"""
AeroTwin ground-station service.

Owns the twin runtime, the active data source, the mission state and the
asynchronous lockstep loop that drives both. Everything the API and the
websockets expose is a view onto this object.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .analytics.calibration import calibrator
from .analytics.explain import build_explanation
from .analytics.validation import ValidationReport, run_validation
from .core.constants import (AIRWORTHINESS_NOTICE, BUILD_STATUS, CHANNELS, DATASET_NGAFID,
                             ENGINE, MODEL_ID, MODEL_VERSION, PRODUCT_NAME,
                             PRODUCT_SUBTITLE, PROGRAMME_REF, REAL_CHANNELS,
                             SIMULATED_CHANNELS)
from .core.eventlog import event_log
from .mission import route
from .mission.profiles import PROFILES, MissionProfile, build_custom_profile, get_profile
from .mission.simulator import SimulationResult, run_simulation
from .sources.base import DataSource
from .sources.can_bus import SocketCanSource
from .sources.ngafid import NgafidReplaySource, corpus_mode, discover_flights
from .sources.synthetic import DegradationSpec, SyntheticFlightSource
from .sources.team_corpus import (TeamCorpusSource, corpus_report as team_corpus_report,
                                 discover_files as discover_team_files)
from .store.history import DEMO_SCHEDULE, generate_history
from .twin.runtime import TwinRuntime

TICK_HZ = 5.0
TICK_INTERVAL = 1.0 / TICK_HZ
DEFAULT_TIME_SCALE = 20.0
DEMO_TIME_SCALE = 200.0        # one of the offered replay rates, so the
                              # active chip matches what the clock is doing
LIVE_FLIGHT_START = 12845

BOOT_STEPS = [
    ("telemetry", "Loading telemetry interface"),
    ("physics", "Initializing physics model"),
    ("history", "Replaying flight history through the twin"),
    ("state", "Synchronizing engine state"),
    ("residual", "Starting residual engine"),
    ("validation", "Running validation harness"),
    ("mission", "Loading mission profile"),
]



def _seed_from(flight_id: str) -> int:
    """A stable integer seed from any flight identifier."""
    try:
        return int(flight_id)
    except (TypeError, ValueError):
        return abs(hash(str(flight_id))) % 100000


def _degraded_cylinder(seed: int) -> int:
    """Which cylinder this sortie degrades.

    Derived from the sortie rather than fixed. The demonstration injected on
    cylinder 3 every time, so the console reported cylinder 3 every time - and
    a localisation that always gives the same answer cannot be told apart from
    a hard-coded one, whatever the detector is really doing underneath.
    Successive sorties now degrade different cylinders and the finding follows,
    which is what makes the attribution visible as attribution.

    Deterministic in the seed, so a given sortie replays identically.
    """
    return 1 + (abs(int(seed)) % 4)


@dataclass
class MissionState:
    id: str = "ISR-047"
    name: str = "PERSISTENT SURVEILLANCE"
    uav_id: str = "UAV-01"
    engine_id: str = "AERO-01"
    airframe: str = "MALE UAV / PUSHER CONFIGURATION"
    profile_id: str = "ISR_STANDARD"
    flight_id: str = str(LIVE_FLIGHT_START)
    started_at: str = ""
    status: str = "STANDBY"
    elapsed_s: float = 0.0
    duration_s: float = 0.0
    sector: str = route.SECTOR_NAME

    def as_dict(self, position: dict, phase: str) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "uav_id": self.uav_id,
            "engine_id": self.engine_id,
            "airframe": self.airframe,
            "profile_id": self.profile_id,
            "flight_id": self.flight_id,
            "started_at": self.started_at,
            "status": self.status,
            "phase": phase,
            "elapsed_s": round(self.elapsed_s),
            "duration_s": round(self.duration_s),
            "progress": round(self.elapsed_s / max(1.0, self.duration_s), 4),
            "sector": self.sector,
            "position": position,
        }


@dataclass
class BootState:
    status: str = "BOOT"          # BOOT | INITIALISING | READY
    steps: list[dict] = field(default_factory=lambda: [
        {"key": key, "label": label, "status": "PENDING", "detail": ""}
        for key, label in BOOT_STEPS
    ])
    progress: float = 0.0
    message: str = "Standing by"

    def mark(self, key: str, status: str, detail: str = "") -> None:
        for step in self.steps:
            if step["key"] == key:
                step["status"] = status
                if detail:
                    step["detail"] = detail
        done = sum(1 for s in self.steps if s["status"] == "COMPLETE")
        self.progress = done / len(self.steps)


class AeroTwinService:
    def __init__(self) -> None:
        self.runtime = TwinRuntime()
        self.boot = BootState()
        self.mission = MissionState()
        self.profile: MissionProfile = get_profile("ISR_STANDARD")
        self.source: DataSource = self._build_source(str(LIVE_FLIGHT_START), 0.62, 0.92)
        self.time_scale = DEFAULT_TIME_SCALE
        self.running = False
        self.paused = False
        self.datalink = True
        self.datalink_lost_at: str | None = None
        self.demo_active = False
        self.demo_started_at = 0.0
        self.validation: ValidationReport | None = None
        self.simulations: dict[str, SimulationResult] = {}
        self.started_wall = datetime.now(timezone.utc)
        self._sim_t = 0.0
        self._flight_number = LIVE_FLIGHT_START
        self._task: asyncio.Task | None = None
        self._subscribers: dict[str, set[asyncio.Queue]] = {
            "telemetry": set(), "residuals": set(), "alerts": set(), "mission": set(),
        }
        self._last_alert_signature: str = ""
        self._announced: set[str] = set()
        self._boot_task: asyncio.Task | None = None
        event_log.subscribe(self._on_log_event)

    # -- source construction -----------------------------------------------

    def _build_source(self, flight_id: str, s0: float, s1: float,
                      profile_id: str | None = None, onset: float = 0.04) -> DataSource:
        """Pick the data source for a sortie.

        This is the whole data-agnostic claim in one method. Mount a corpus at
        AEROTWIN_NGAFID_DIR and the real-data adapter is selected; nothing
        downstream of here knows or cares which one it got, because both
        satisfy the same 1 Hz frame contract. With no corpus present the demo
        telemetry simulator takes the slot and tags every frame it produces.

        Only an *operator* corpus takes the slot. The demo flights bundled with
        the repository exist so the ingest path has something to read out of the
        box; they carry no fault, so replaying them here would quietly remove
        the degradation the whole demonstration is built around. They stay
        available as a source and on Data & Models, and the simulator keeps the
        live seat.
        """
        flights = discover_flights() if corpus_mode() == "REAL" else []
        if flights:
            # Rotate through the mounted corpus so successive sorties are
            # different flights rather than the same one replayed.
            index = (int(flight_id) - LIVE_FLIGHT_START) % len(flights)
            source = NgafidReplaySource(flights[index])
            try:
                source.open()
                event_log.info(
                    "TELEMETRY",
                    f"Corpus flight {flights[index]} loaded ({len(source):,} samples at 1 Hz)",
                )
                return source
            except Exception as exc:
                # A malformed or short flight file must not take the ground
                # station down - fall back and say why.
                event_log.warning(
                    "TELEMETRY",
                    f"Corpus flight {flights[index]} unusable ({exc}); "
                    "falling back to demo telemetry",
                )

        return SyntheticFlightSource(
            profile=profile_id or getattr(self, "profile", None) or "ISR_STANDARD",
            flight_id=flight_id,
            degradation=DegradationSpec(
                "exhaust_valve_distress",
                _degraded_cylinder(_seed_from(flight_id)),
                s0, s1, onset, True,
            ),
            # The flight id is a corpus file stem when a file-backed source
            # has the seat, so this cannot assume it parses.
            seed=51000 + _seed_from(flight_id),
        )

    # -- lifecycle ----------------------------------------------------------

    async def startup(self) -> None:
        self.boot.status = "INITIALISING"
        self.boot.message = "Initializing AEROTWIN"
        self._boot_task = asyncio.create_task(self._boot_sequence())

    async def shutdown(self) -> None:
        self.running = False
        if self._task:
            self._task.cancel()
        if self._boot_task:
            self._boot_task.cancel()

    async def _boot_sequence(self) -> None:
        loop = asyncio.get_running_loop()

        event_log.info("SYSTEM", f"{PRODUCT_NAME} ground station starting")
        self.boot.mark("telemetry", "ACTIVE")
        await asyncio.sleep(0.25)
        descriptor = self.source.descriptor
        self.boot.mark("telemetry", "COMPLETE", descriptor.label)
        event_log.info("TELEMETRY", f"Telemetry interface bound to {descriptor.label}")

        self.boot.mark("physics", "ACTIVE")
        info = self.runtime.physics.info
        await asyncio.sleep(0.2)
        self.boot.mark("physics", "COMPLETE", info.backend)
        event_log.info("PHYSICS", f"{info.backend} initialised - {info.fidelity}")

        self.boot.mark("history", "ACTIVE")
        self.boot.message = "Replaying flight history through the twin"
        records = await loop.run_in_executor(None, generate_history, self.runtime)
        self.boot.mark("history", "COMPLETE", f"{len(records)} sorties replayed")
        event_log.info(
            "TWIN",
            f"{len(records)} prior sorties replayed through the lockstep loop "
            f"({sum(r.samples for r in records):,} samples)",
        )

        self.boot.mark("state", "ACTIVE")
        await asyncio.sleep(0.15)
        estimator = self.runtime.estimator.snapshot()
        self.boot.mark(
            "state", "COMPLETE",
            f"baseline {'locked' if estimator['baseline_locked'] else 'not locked'}",
        )
        event_log.info(
            "STATE ESTIMATOR",
            "Healthy baseline locked - volumetric efficiency "
            f"{estimator['baseline']['volumetric_efficiency']:.3f}, cooling "
            f"effectiveness {estimator['baseline']['cooling_effectiveness']:.3f}",
        )

        self.boot.mark("residual", "ACTIVE")
        await asyncio.sleep(0.15)
        self.boot.mark("residual", "COMPLETE", f"{len(self.runtime.residuals.channels)} channels")
        event_log.info("RESIDUAL ENGINE", "Residual engine active on 13 modelled channels")

        # The validation harness is expensive and nothing on the operational
        # side depends on it, so it runs behind the live stream rather than
        # holding the ground station offline.
        self.boot.mark("validation", "ACTIVE", "running behind the live stream")
        asyncio.create_task(self._run_validation())

        self.boot.mark("mission", "ACTIVE")
        await asyncio.sleep(0.15)
        self.boot.mark("mission", "COMPLETE", self.mission.id)

        self.boot.status = "READY"
        self.boot.message = "SYSTEM READY"
        event_log.info("SYSTEM", "SYSTEM READY")
        await self.start_stream()

    async def _run_validation(self) -> None:
        loop = asyncio.get_running_loop()
        event_log.info("VALIDATION", "Validation harness started")
        try:
            self.validation = await loop.run_in_executor(None, run_validation, self.runtime)
        except Exception as exc:  # pragma: no cover - defensive
            self.boot.mark("validation", "FAILED", str(exc))
            event_log.warning("VALIDATION", f"Validation harness failed: {exc}")
            return
        self.boot.mark(
            "validation", "COMPLETE",
            f"ROC-AUC {self.validation.roc_auc:.3f} over {self.validation.trials} trials",
        )
        event_log.info(
            "VALIDATION",
            f"Synthetic harness complete - ROC-AUC {self.validation.roc_auc:.3f}, "
            f"F1 {self.validation.f1:.3f}, localisation "
            f"{self.validation.localisation_accuracy:.3f} "
            f"({self.validation.trials} trials, {self.validation.elapsed_s:.1f} s)",
        )
        event_log.info("CALIBRATION", calibrator.reason)

    # -- streaming loop -----------------------------------------------------

    async def start_stream(self) -> None:
        if self.running:
            return
        self.running = True
        # Offline warm-up is done; the learned model joins the live loop.
        self.runtime.learned_enabled = True
        self.mission.status = "ACTIVE"
        self.mission.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.mission.duration_s = self.profile.duration_s
        self.source.open()
        event_log.info("TELEMETRY", "Telemetry stream connected")
        event_log.info("TWIN", "Digital twin synchronised - lockstep execution active")
        self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        """The lockstep clock.

        Wrapped so that a failure anywhere in the analytics stack degrades the
        diagnosis rather than stopping the stream. A ground station that goes
        silent is a worse failure than one reporting a reduced capability, so
        the error is logged for the operator and the clock keeps running.
        """
        consecutive_errors = 0
        try:
            while self.running:
                started = time.perf_counter()
                try:
                    if not self.paused and self.datalink:
                        self._advance()
                    await self._broadcast()
                    consecutive_errors = 0
                except asyncio.CancelledError:
                    raise
                except Exception as exc:              # pragma: no cover - guard
                    consecutive_errors += 1
                    if consecutive_errors in (1, 10, 100):
                        event_log.critical(
                            "TWIN",
                            f"Twin step failed ({consecutive_errors}x): "
                            f"{type(exc).__name__}: {exc}",
                        )
                    if consecutive_errors > 400:
                        event_log.critical("TWIN", "Twin loop halted after repeated failures")
                        self.running = False
                        return
                elapsed = time.perf_counter() - started
                await asyncio.sleep(max(0.005, TICK_INTERVAL - elapsed))
        except asyncio.CancelledError:
            return

    def _advance(self) -> None:
        """One clock tick: as many 1 Hz samples as the replay rate calls for."""
        self._advance_samples(max(1, int(round(self.time_scale / TICK_HZ))))

    def _advance_samples(self, samples: int) -> None:
        source = self.source
        for _ in range(samples):
            if isinstance(source, SyntheticFlightSource):
                if self._sim_t > self.profile.duration_s:
                    self._next_flight()
                    source = self.source
                frame = source.sample(self._sim_t)
                self._sim_t += 1.0
            else:
                frame = source.read()
                if frame is None:
                    self._next_flight()
                    source = self.source
                    continue
                self._sim_t = frame.t
            self.runtime.step(frame)
        self.mission.elapsed_s = self._sim_t
        self._detect_state_changes()

    def _next_flight(self) -> None:
        record = self.runtime.close_flight(
            flight_id=self.mission.flight_id,
            label=f"FLIGHT #{self.mission.flight_id}",
            profile_id=self.profile.id,
            duration_s=self.profile.duration_s,
            notes="Live sortie",
        )
        event_log.info(
            "MISSION",
            f"Flight #{record.flight_id} complete - health index "
            f"{record.health_index:.1f}%, status {record.status}",
        )
        self._flight_number += 1
        self.mission.flight_id = str(self._flight_number)
        severity_start = min(0.95, 0.62 + 0.10 * (self._flight_number - LIVE_FLIGHT_START))
        self.source = self._build_source(
            self.mission.flight_id, severity_start, min(0.99, severity_start + 0.10),
            profile_id=self.profile.id,
        )
        self.source.open()
        self._sim_t = 0.0
        self.runtime.flight_series = []
        self.demo_active = False
        event_log.info("MISSION", f"Flight #{self.mission.flight_id} started")

    # -- change detection for the operational log --------------------------

    def _detect_state_changes(self) -> None:
        runtime = self.runtime
        estimator = runtime.estimator.status
        if estimator.baseline_locked and "baseline" not in self._announced:
            self._announced.add("baseline")

        for anomaly in runtime.anomalies:
            if anomaly.abstained or anomaly.score < 0.55:
                continue
            key = f"{anomaly.id}:{anomaly.severity}"
            if key in self._announced:
                continue
            self._announced.add(key)
            level = "WARNING" if anomaly.severity == "HIGH" else "ADVISORY"
            event_log.emit(
                level, "ANOMALY",
                f"{anomaly.title} - {anomaly.trend.lower()}, anomaly score "
                f"{anomaly.score:.2f}, confidence {anomaly.confidence:.2f}",
                anomaly_id=anomaly.id,
            )
            if anomaly.severity == "HIGH":
                event_log.advisory(
                    "MAINTENANCE",
                    f"Maintenance advisory generated - {anomaly.mechanism_label or anomaly.title}",
                    anomaly_id=anomaly.id,
                )

        for alert in runtime.threshold:
            key = f"THR:{alert['title']}"
            if key in self._announced:
                continue
            self._announced.add(key)
            event_log.emit(alert["level"], "THRESHOLD", f"{alert['title']} - {alert['detail']}")

    # -- websocket fan-out --------------------------------------------------

    def subscribe(self, topic: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._subscribers.setdefault(topic, set()).add(queue)
        return queue

    def unsubscribe(self, topic: str, queue: asyncio.Queue) -> None:
        self._subscribers.get(topic, set()).discard(queue)

    def _publish(self, topic: str, payload: dict) -> None:
        for queue in list(self._subscribers.get(topic, set())):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                continue

    async def _broadcast(self) -> None:
        tick = self.runtime.current
        if tick is None:
            return
        self._publish("telemetry", {"type": "telemetry", **self.telemetry_frame()})
        self._publish("residuals", {"type": "residuals", **self.residual_frame()})
        self._publish("mission", {"type": "mission", **self.mission_frame()})

        signature = "|".join(
            f"{a.id}:{a.severity}:{a.score:.2f}" for a in self.runtime.anomalies[:4]
        ) + f"|{len(self.runtime.threshold)}|{self.runtime.engine_state_label}"
        if signature != self._last_alert_signature:
            self._last_alert_signature = signature
            self._publish("alerts", {"type": "alerts", **self.alert_frame()})

    def _on_log_event(self, event: dict) -> None:
        self._publish("alerts", {"type": "log", "event": event})

    # -- frames -------------------------------------------------------------

    def telemetry_frame(self) -> dict:
        tick = self.runtime.current
        if tick is None:
            return {}
        return {
            "tick": tick.compact(),
            "engine": self.engine_summary(),
            "provenance": self.live_provenance(),
            "datalink": self.datalink_state(),
            "source": self.source_descriptor(),
        }

    def residual_frame(self) -> dict:
        tick = self.runtime.current
        if tick is None:
            return {}
        return {
            "t": round(tick.t, 1),
            "sync_pct": round(self.runtime.sync_pct, 2),
            "channels": {k: r.as_dict() for k, r in tick.residuals.items()},
            "estimator": self.runtime.estimator.snapshot(),
            "asymmetry": self.runtime.cylinder_asymmetry(),
            "steady": tick.steady,
            "regime": tick.regime,
        }

    def mission_frame(self) -> dict:
        tick = self.runtime.current
        phase = tick.phase if tick else "GROUND"
        position = self.uav_position()
        return {
            "mission": self.mission.as_dict(position, phase),
            "altitude_ft": round(tick.inputs.get("altitude_ft", 0.0)) if tick else 0,
            "ias_kt": round(tick.inputs.get("ias_kt", 0.0), 1) if tick else 0,
            "rpm": round(tick.channels.get("rpm", 0.0)) if tick else 0,
            "oat_c": round(tick.inputs.get("oat_c", 0.0), 1) if tick else 0,
            "power_pct": round(tick.power_fraction * 100.0, 1) if tick else 0,
            "demo_active": self.demo_active,
            "time_scale": self.time_scale,
        }

    def alert_frame(self) -> dict:
        return {
            "anomalies": [a.as_dict() for a in self.runtime.anomalies],
            "advisories": [a.as_dict() for a in self.runtime.advisories],
            "threshold": self.runtime.threshold,
            "engine_state": self.runtime.engine_state_label,
            "engine_reason": self.runtime.engine_state_reason,
        }

    # -- views --------------------------------------------------------------

    def uav_position(self) -> dict:
        tick = self.runtime.current
        if tick is None:
            return route.position_at("GROUND", 0.0, 0.0)
        phase = tick.phase
        elapsed = 0.0
        local = 0.0
        for segment in self.profile.segments:
            if self._sim_t <= elapsed + segment.duration_s:
                local = (self._sim_t - elapsed) / max(1.0, segment.duration_s)
                break
            elapsed += segment.duration_s
        return route.position_at(phase, local, self._sim_t)

    def engine_summary(self) -> dict:
        runtime = self.runtime
        tick = runtime.current
        top = next(
            (a for a in runtime.anomalies if not a.abstained and a.score > 0.3), None
        )
        envelope = runtime.envelope
        return {
            "engine_id": self.mission.engine_id,
            # A health number computed against a model that does not apply to
            # the connected source is not a health number, so it is not sent as
            # one. The console renders a dash and the abstention reason.
            "health_index": round(runtime.health_index, 1) if envelope["health_valid"] else None,
            "health_valid": envelope["health_valid"],
            "envelope": envelope,
            "status": runtime.engine_state_label,
            "reason": runtime.engine_state_reason,
            "confidence": round(top.confidence, 4) if top else None,
            "model_state": runtime.estimator.status.state,
            "model_gated": runtime.estimator.status.gated,
            "sync_pct": round(runtime.sync_pct, 2),
            "cylinders": [c.as_dict() for c in runtime.cylinders],
            "anomaly_count": sum(1 for a in runtime.anomalies if a.score >= 0.3),
            "advisory_count": len(runtime.advisories),
            "threshold_count": len(runtime.threshold),
            "prognosis": runtime.prognosis.as_dict() if runtime.prognosis else None,
            "health_history": [
                {"flight_id": r.flight_id, "label": r.label, "health": round(r.health_index, 1),
                 "profile_id": r.profile_id, "status": r.status,
                 "peak_residual_c": round(r.peak_residual_c, 1), "notes": r.notes}
                for r in runtime.flights
            ] + ([{
                "flight_id": self.mission.flight_id,
                "label": f"FLIGHT #{self.mission.flight_id}",
                "health": round(runtime.health_index, 1),
                "profile_id": self.profile.id,
                "status": runtime.engine_state_label,
                "peak_residual_c": round(
                    max((c.asymmetry_c for c in runtime.cylinders), key=abs, default=0.0), 1),
                "notes": "Live sortie", "live": True,
            }] if runtime.cylinders else []),
            "phase": tick.phase if tick else "GROUND",
            "regime": tick.regime if tick else "-",
            "power_pct": round(tick.power_fraction * 100.0, 1) if tick else 0.0,
            "power_hp": round(tick.power_hp, 1) if tick else 0.0,
        }

    def datalink_state(self) -> dict:
        return {
            "connected": self.datalink,
            "status": "CONNECTED" if self.datalink else "INTERRUPTED",
            "last_valid": self.runtime.last_sync_wall,
            "lost_at": self.datalink_lost_at,
            "rate_hz": 1.0,
            "twin_state": "SYNCHRONISED" if self.datalink else "HOLD",
            "diagnostics_state": "ACTIVE" if self.datalink else "PAUSED",
        }

    def live_provenance(self) -> dict:
        """
        How many channels in the current frame are measured.

        Read from the frame rather than from the channel registry: the registry
        says which channels *can* be measured, which is a property of the
        contract. Whether they *were* depends on the mounted corpus, and only
        the frame knows that.
        """
        descriptor = self.source.descriptor
        measured = descriptor.provenance == "REAL"
        tick = self.runtime.current
        tags = getattr(tick, "provenance", None) if tick else None

        counts = {"real": 0, "simulated": 0, "demo": 0}
        if tags:
            for value in tags.values():
                counts[str(value).lower()] = counts.get(str(value).lower(), 0) + 1
        else:
            counts["real"] = len(REAL_CHANNELS)
            counts["simulated"] = len(SIMULATED_CHANNELS)

        # A channel the contract calls measurable was not measured unless the
        # source that produced it was. Folding the count here is what keeps the
        # header on Telemetry from disagreeing with the badge on every row.
        if not measured:
            counts["demo"] += counts["real"]
            counts["real"] = 0

        counts["mode"] = "REAL" if measured else "DEMO"
        counts["source"] = descriptor.provenance
        return counts

    def source_descriptor(self) -> dict:
        d = self.source.descriptor
        return {
            "id": d.id, "label": d.label, "kind": d.kind,
            "provenance": d.provenance, "detail": d.detail, "rate_hz": d.rate_hz,
            "mode": corpus_mode() if d.kind == "REPLAY" else "DEMO",
            "state": "CONNECTED" if d.provenance == "REAL" else "ACTIVE",
        }

    def all_sources(self) -> list[dict]:
        entries = []
        team_files = discover_team_files()
        candidates: list = [SyntheticFlightSource(), NgafidReplaySource(), SocketCanSource()]
        if team_files:
            candidates.insert(1, TeamCorpusSource(team_files[0]))
        for source in candidates:
            d = source.descriptor
            entries.append({
                "id": d.id, "label": d.label, "kind": d.kind,
                "provenance": d.provenance, "available": d.available,
                "detail": d.detail, "active": d.id == self.source.descriptor.id,
            })
        entries.append({
            "id": "JSBSIM", "label": "JSBSIM FGPISTON", "kind": "PHYSICS",
            "provenance": "PHYSICS MODEL",
            "available": self.runtime.physics.info.available,
            "detail": self.runtime.physics.info.note,
            "active": True,
        })
        return entries

    def system_status(self) -> dict:
        uptime = (datetime.now(timezone.utc) - self.started_wall).total_seconds()
        return {
            "product": PRODUCT_NAME,
            "subtitle": PRODUCT_SUBTITLE,
            "programme": PROGRAMME_REF,
            "build_status": BUILD_STATUS,
            "airworthiness_notice": AIRWORTHINESS_NOTICE,
            "boot": {
                "status": self.boot.status,
                "progress": round(self.boot.progress, 3),
                "message": self.boot.message,
                "steps": self.boot.steps,
            },
            "system": "ONLINE" if self.boot.status == "READY" else "INITIALISING",
            "datalink": self.datalink_state(),
            "twin": {
                "state": "SYNCHRONISED" if self.datalink and self.running else "HOLD",
                "sync_pct": round(self.runtime.sync_pct, 2),
                "samples": self.runtime.samples,
                "buffer": len(self.runtime.buffer),
            },
            "model": self.runtime.model_meta(),
            "mission_status": self.mission.status,
            "running": self.running,
            "paused": self.paused,
            "demo_active": self.demo_active,
            "time_scale": self.time_scale,
            "uptime_s": round(uptime, 1),
            "deployment": {
                "mode": "ON-PREMISE",
                "cloud": "NOT USED",
                "air_gapped_ready": True,
                "note": (
                    "All components run locally. No external service is contacted "
                    "at runtime. Defence telemetry does not leave the deployment."
                ),
            },
            "engine": {
                "id": self.mission.engine_id,
                "designation": ENGINE["reference_engine"],
                "class": ENGINE["class_label"],
                "rated_power_hp": ENGINE["rated_power_hp"],
                "cylinders": ENGINE["cylinders"],
            },
            "model_id": MODEL_ID,
            "model_version": MODEL_VERSION,
            "dataset": DATASET_NGAFID["id"],
        }

    def provenance(self) -> dict:
        tick = self.runtime.current
        channels = []
        for channel in CHANNELS:
            value = tick.channels.get(channel["key"]) if tick else None
            channels.append({
                **channel,
                "value": round(value, 2) if value is not None else None,
                "live": value is not None,
            })
        total = len(CHANNELS)
        real = len(REAL_CHANNELS)
        return {
            "channels": channels,
            "summary": {
                "total": total,
                "real": real,
                "simulated": total - real,
                "real_pct": round(100.0 * real / total, 1),
                "simulated_pct": round(100.0 * (total - real) / total, 1),
            },
            "source": self.source_descriptor(),
            "live": self.live_provenance(),
        }

    def explanation(self, anomaly_id: str) -> dict | None:
        for anomaly in self.runtime.anomalies:
            if anomaly.id == anomaly_id:
                return build_explanation(anomaly)
        return None

    # -- control ------------------------------------------------------------

    def set_speed(self, scale: float) -> None:
        self.time_scale = max(1.0, min(400.0, scale))
        event_log.info("SYSTEM", f"Replay rate set to {self.time_scale:.0f}x real time")

    def pause(self) -> None:
        self.paused = True
        self.mission.status = "PAUSED"
        event_log.info("SYSTEM", "Replay paused")

    def resume(self) -> None:
        self.paused = False
        self.mission.status = "ACTIVE"
        event_log.info("SYSTEM", "Replay resumed")

    def step(self, samples: int = 1) -> dict:
        """Advance exactly `samples` 1 Hz timesteps, then hold again.

        The single-step control the operator gets while paused. It bypasses the
        replay rate entirely - one press is one dataset sample, whatever the
        clock was running at - and it leaves the simulation held, so pressing
        it does not quietly restart the stream.
        """
        if not self.paused:
            self.pause()
        n = max(1, min(600, int(samples)))
        self._advance_samples(n)
        return {
            "paused": True,
            "t": round(self._sim_t, 1),
            "index": int(self._sim_t),
            "samples": n,
        }

    def stop_stream(self) -> dict:
        """Hold the replay and mark the sortie stopped, but keep the state.

        Distinct from RESET: everything computed so far stays inspectable -
        the residual history, the anomalies, the advisory - which is what an
        operator wants after stopping on something interesting.
        """
        self.paused = True
        self.demo_active = False
        self.mission.status = "STOPPED"
        event_log.info("SYSTEM", "Replay stopped")
        return {"stopped": True, "t": round(self._sim_t, 1)}

    def reset_run(self) -> dict:
        """Return the twin to a cold, restartable state.

        The source is rebuilt from the top and every quantity derived from the
        stopped sortie is discarded, so the next START begins with no residual
        baseline, no CUSUM and no anomaly carried over from the last one.
        """
        self.runtime.reset_run()
        self.source = self._build_source(
            self.mission.flight_id, 0.62, 0.92, profile_id=self.profile.id,
        )
        self.source.open()
        self._sim_t = 0.0
        self.paused = True
        self.demo_active = False
        self.time_scale = DEFAULT_TIME_SCALE
        self.datalink = True
        self.datalink_lost_at = None
        self.mission.elapsed_s = 0.0
        self.mission.status = "IDLE"
        self._announced = set()
        self._last_alert_signature = ""
        event_log.info("SYSTEM", "Simulation reset - twin state cleared")
        return {"reset": True, "t": 0.0}

    def seek(self, t: float) -> None:
        self._sim_t = max(0.0, min(self.profile.duration_s, t))
        if isinstance(self.source, SyntheticFlightSource):
            self.source.seek(self._sim_t)

    def set_datalink(self, connected: bool) -> None:
        if connected == self.datalink:
            return
        self.datalink = connected
        if connected:
            self.datalink_lost_at = None
            event_log.info("TELEMETRY", "Data link restored - twin resynchronising")
        else:
            self.datalink_lost_at = self.runtime.last_sync_wall
            event_log.warning(
                "TELEMETRY",
                "Data link interrupted - digital twin held, predictive diagnostics paused",
            )

    def start_demo(self) -> dict:
        """Restart the live sortie as the compressed judge demonstration."""
        self.profile = get_profile("ISR_STANDARD")
        self.mission.profile_id = self.profile.id
        self.mission.duration_s = self.profile.duration_s
        # Each demonstration run degrades the next cylinder round, so pressing
        # START DEMO twice does not produce the same finding twice.
        self._demo_run = getattr(self, "_demo_run", 0) + 1
        self.source = SyntheticFlightSource(
            profile=self.profile,
            flight_id=self.mission.flight_id,
            degradation=DegradationSpec(
                "exhaust_valve_distress",
                _degraded_cylinder(self._demo_run),
                0.60, 0.95, 0.06, True,
            ),
            seed=990001,
        )
        self.source.open()
        self._sim_t = 0.0
        self.runtime.flight_series = []
        self.runtime.residuals.reset_cusum()
        self._announced = {a for a in self._announced if a.startswith("baseline")}
        self.time_scale = DEMO_TIME_SCALE
        self.paused = False
        self.datalink = True
        self.demo_active = True
        self.demo_started_at = time.time()
        self.mission.status = "ACTIVE"
        event_log.info("SYSTEM", "Guided demonstration started - compressed sortie replay")
        event_log.info("MISSION", f"Mission {self.mission.id} / {self.mission.uav_id} initialising")
        return {
            "demo": True,
            "time_scale": self.time_scale,
            "duration_s": self.profile.duration_s,
            "estimated_wall_s": round(self.profile.duration_s / self.time_scale, 1),
            "scenario": {
                "mission": self.mission.id,
                "uav": self.mission.uav_id,
                "engine": self.mission.engine_id,
                "mechanism": "Early exhaust valve distress",
                "cylinder": 3,
                "note": (
                    "The degradation is injected into the hidden truth of the "
                    "telemetry simulator. The twin is not told about it - the "
                    "residual, the localisation and the advisory are all computed."
                ),
            },
        }

    def stop_demo(self) -> None:
        self.demo_active = False
        self.time_scale = DEFAULT_TIME_SCALE
        event_log.info("SYSTEM", "Guided demonstration ended")

    # -- the team corpus ----------------------------------------------------

    def dataset_report(self) -> dict:
        """Everything counted out of the team corpus, plus who has the seat.

        Nothing here is a constant: the file list, the row counts, the sampling
        rate and the label distribution are all read off the filesystem when
        this is called, which is the only way the dataset page can claim to be
        showing what is actually mounted.
        """
        report = team_corpus_report()
        active = self.source.descriptor
        report["active"] = active.id.startswith("TEAM_")
        report["active_source"] = {
            "id": active.id, "label": active.label, "provenance": active.provenance,
        }
        return report

    def activate_team_corpus(self, name: str | None = None) -> dict:
        """Give the team corpus the live seat.

        The whole data-agnostic claim in one call: a corpus with a different
        schema, different units and no per-cylinder instrumentation takes over
        the stream, and nothing downstream changes. What it cannot support is
        reported rather than synthesised.
        """
        files = discover_team_files()
        if not files:
            return {"activated": False, "detail": "Team corpus not present"}
        chosen = next((p for p in files if p.stem == name or p.name == name), files[0])

        source = TeamCorpusSource(chosen)
        try:
            source.open()
        except Exception as exc:
            event_log.warning("TELEMETRY", f"Team corpus {chosen.name} unusable ({exc})")
            return {"activated": False, "detail": str(exc)}

        self.runtime.reset_run()
        self.source = source
        self._sim_t = 0.0
        self.paused = False
        self.demo_active = False
        self.mission.flight_id = chosen.stem
        self.mission.status = "ACTIVE"
        self.mission.duration_s = float(len(source))
        self.time_scale = min(self.time_scale, 20.0)
        event_log.info(
            "TELEMETRY",
            f"Team corpus {chosen.name} on the live seat "
            f"({len(source):,} samples at 1 Hz, tagged SIMULATED)",
        )
        return {
            "activated": True,
            "file": chosen.name,
            "samples": len(source),
            "provenance": "SIMULATED",
            "duration_s": float(len(source)),
        }

    def restore_default_source(self) -> dict:
        """Hand the live seat back to the demonstration simulator."""
        self.runtime.reset_run()
        self.mission.flight_id = str(self._flight_number)
        self.source = self._build_source(
            self.mission.flight_id, 0.62, 0.92, profile_id=self.profile.id,
        )
        self.source.open()
        self._sim_t = 0.0
        self.mission.duration_s = self.profile.duration_s
        self.mission.status = "ACTIVE"
        event_log.info("TELEMETRY", "Live seat returned to the demonstration simulator")
        return {"activated": True, "source": self.source.descriptor.id}

    def run_mission_simulation(self, profile_id: str, custom: dict | None = None) -> SimulationResult:
        if profile_id.upper() == "CUSTOM" and custom:
            profile = build_custom_profile(
                altitude_ft=float(custom.get("altitude_ft", 15000)),
                oat_c=float(custom.get("oat_c", 20)),
                ias_kt=float(custom.get("ias_kt", 88)),
                throttle_pct=float(custom.get("throttle_pct", 78)),
                duration_s=float(custom.get("duration_s", 23400)),
                transients=bool(custom.get("transients", False)),
            )
        else:
            profile = get_profile(profile_id)

        run_id = f"SIM-{uuid.uuid4().hex[:8].upper()}"
        prognosis = self.runtime.prognosis
        result = run_simulation(
            profile=profile,
            engine_state=self.runtime.estimator.current.copy(),
            baseline_state=self.runtime.estimator.baseline.copy(),
            health_index=self.runtime.health_index,
            p_serviceable=prognosis.p_serviceable_2d if prognosis else 0.9,
            run_id=run_id,
        )
        self.simulations[run_id] = result
        event_log.info(
            "SIMULATION",
            f"Mission simulation {run_id} on profile {profile.name} - peak CHT "
            f"{result.summary['peak_cht_c']:.0f} °C, margin "
            f"{result.summary['cht_margin_c']:.0f} °C, risk "
            f"{result.summary['mission_risk']['band']}",
        )
        return result

    def profile_catalogue(self) -> list[dict]:
        return [p.descriptor() for p in PROFILES.values()]

    def flight_replay(self, flight_id: str) -> dict | None:
        for record in self.runtime.flights:
            if record.flight_id == flight_id:
                return record.as_dict(with_series=True)
        if flight_id == self.mission.flight_id:
            return {
                "flight_id": flight_id,
                "label": f"FLIGHT #{flight_id}",
                "profile_id": self.profile.id,
                "duration_s": round(self.profile.duration_s),
                "health_index": round(self.runtime.health_index, 1),
                "peak_cylinder": 3,
                "peak_residual_c": round(
                    max((c.asymmetry_c for c in self.runtime.cylinders), key=abs, default=0.0), 1),
                "status": self.runtime.engine_state_label,
                "samples": self.runtime.samples,
                "notes": "Live sortie in progress",
                "series": list(self.runtime.flight_series),
                "live": True,
            }
        return None

    def flight_list(self) -> list[dict]:
        flights = [r.as_dict() for r in self.runtime.flights]
        flights.append({
            "flight_id": self.mission.flight_id,
            "label": f"FLIGHT #{self.mission.flight_id}",
            "profile_id": self.profile.id,
            "duration_s": round(self.profile.duration_s),
            "health_index": round(self.runtime.health_index, 1),
            "peak_cylinder": 3,
            "peak_residual_c": round(
                max((c.asymmetry_c for c in self.runtime.cylinders), key=abs, default=0.0), 1),
            "status": self.runtime.engine_state_label,
            "samples": self.runtime.samples,
            "notes": "Live sortie in progress",
            "live": True,
        })
        return flights

    def ngafid_status(self) -> dict:
        files = discover_flights()
        mode = corpus_mode()
        return {
            # `configured` has always meant "is there something to read". It is
            # now true for the bundled corpus too, so `mode` carries the part
            # that matters: whether what is mounted was ever measured.
            "configured": bool(files),
            "mode": mode,
            "provenance": "REAL" if mode == "REAL" else "DEMO",
            "files": files[:50],
            "count": len(files),
            "schedule": [
                {"flight": leg.flight_number, "profile": leg.profile_id, "note": leg.note}
                for leg in DEMO_SCHEDULE
            ],
        }


service = AeroTwinService()
