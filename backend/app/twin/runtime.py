"""
Lockstep twin runtime.

For every 1 Hz telemetry frame the runtime:

  1. takes the control and ambient inputs the real engine saw,
  2. runs the physics model twice on those same inputs -
     once against the locked healthy BASELINE state, once against the live
     ADAPTED state,
  3. computes per-channel and per-cylinder residuals against the baseline,
  4. updates the online state estimator from the adapted residual,
  5. accumulates anomaly evidence and recomputes health, prognosis and
     advisories.

The adapted residual is the twin's tracking error and drives the
synchronisation figure. The baseline residual is the diagnostic signal. Both
are published, because a twin that only reports the adapted residual can
silently absorb the very fault it exists to find.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from ..analytics.envelope import envelope_status
from ..analytics.advisory import Advisory, build_advisories
from ..analytics.anomaly import Anomaly, AnomalyDetector, regime_key, threshold_alerts
from ..analytics.health import (CylinderHealth, cylinder_health, engine_health_index,
                                engine_status, global_health)
from ..analytics.prognostics import Prognosis, serviceability
from ..core.constants import MODEL_ID, MODEL_VERSION, RESIDUAL_CHANNELS
from ..ml.anomaly_model import anomaly_model, fuse as fuse_model_score
from ..ml.feature_engineering import cylinder_features, feature_frame
from ..physics.jsbsim_adapter import physics_backend
from ..physics.piston import OperatingInputs
from ..sources.base import DEFAULT_LAG_TAU, TelemetryFrame, ThermalLag
from .residual import ChannelResidual, ResidualEngine, asymmetry_index
from .state_estimator import StateEstimator

BUFFER_SAMPLES = 5400          # ~90 minutes of 1 Hz history held in memory
ANALYTICS_EVERY = 5            # recompute the analytics stack every N samples
LEARNED_EVERY = 4              # apply the learned model every Nth analytics pass
SCALE_FREEZE_DELAY = 300       # steady samples after baseline lock

# Denominator floors for the synchronisation metric, so a channel passing
# through zero cannot dominate the tracking figure.
_SYNC_FLOOR = {
    "cht_1": 60.0, "cht_2": 60.0, "cht_3": 60.0, "cht_4": 60.0,
    "egt_1": 300.0, "egt_2": 300.0, "egt_3": 300.0, "egt_4": 300.0,
    "map_inhg": 8.0, "rpm": 800.0, "oil_press_psi": 20.0,
    "oil_temp_c": 40.0, "fuel_flow_gph": 2.0,
}


@dataclass(slots=True)
class TwinTick:
    t: float
    wall_clock: str
    flight_id: str
    phase: str
    channels: dict[str, float]
    expected: dict[str, float]
    expected_adapted: dict[str, float]
    residuals: dict[str, ChannelResidual]
    inputs: dict[str, float]
    power_fraction: float
    power_hp: float
    tas_kt: float
    density_ratio: float
    steady: bool
    sync_pct: float
    regime: str

    def compact(self) -> dict:
        """Wire format for the telemetry websocket."""
        return {
            "t": round(self.t, 1),
            "wall_clock": self.wall_clock,
            "flight_id": self.flight_id,
            "phase": self.phase,
            "regime": self.regime,
            "channels": {k: round(v, 2) for k, v in self.channels.items()},
            "expected": {k: round(v, 2) for k, v in self.expected.items()},
            "residuals": {
                k: {"r": round(r.residual, 2), "z": round(r.normalised, 2),
                    "e": round(r.ewma, 2), "c": round(r.cusum, 1)}
                for k, r in self.residuals.items()
            },
            "inputs": self.inputs,
            "power_fraction": round(self.power_fraction, 4),
            "power_hp": round(self.power_hp, 1),
            "tas_kt": round(self.tas_kt, 1),
            "steady": self.steady,
            "sync_pct": round(self.sync_pct, 2),
        }


@dataclass(slots=True)
class FlightRecord:
    flight_id: str
    label: str
    profile_id: str
    duration_s: float
    health_index: float
    peak_cylinder: int | None
    peak_residual_c: float
    status: str
    samples: int
    notes: str = ""
    series: list[dict] = field(default_factory=list)

    def as_dict(self, with_series: bool = False) -> dict:
        data = {
            "flight_id": self.flight_id,
            "label": self.label,
            "profile_id": self.profile_id,
            "duration_s": round(self.duration_s),
            "health_index": round(self.health_index, 1),
            "peak_cylinder": self.peak_cylinder,
            "peak_residual_c": round(self.peak_residual_c, 1),
            "status": self.status,
            "samples": self.samples,
            "notes": self.notes,
        }
        if with_series:
            data["series"] = self.series
        return data


class TwinRuntime:
    """One instance per monitored engine."""

    def __init__(self) -> None:
        self.physics = physics_backend
        self.estimator = StateEstimator()
        self.residuals = ResidualEngine(RESIDUAL_CHANNELS)
        self.detector = AnomalyDetector()
        self.expected_lag = ThermalLag(DEFAULT_LAG_TAU)
        self.adapted_lag = ThermalLag(DEFAULT_LAG_TAU)

        self.buffer: deque[TwinTick] = deque(maxlen=BUFFER_SAMPLES)
        self.flights: list[FlightRecord] = []
        self.health_history: list[float] = []

        self.current: TwinTick | None = None
        self.cylinders: list[CylinderHealth] = []
        self.anomalies: list[Anomaly] = []
        self.advisories: list[Advisory] = []
        self.prognosis: Prognosis | None = None
        self.threshold: list[dict] = []
        self.health_index: float = 100.0
        self.engine_state_label: str = "NORMAL"
        self.engine_state_reason: str = "Awaiting telemetry"
        self.sync_pct: float = 0.0
        self.samples: int = 0
        self._post_lock_samples: int = 0
        self._scales_frozen = False
        self._sync_ewma: float | None = None
        self.physics_steps_per_s: float = 0.0
        self.last_sync_wall: str = "-"
        self.flight_series: list[dict] = []
        self._series_stride = 10
        # The learned model is off during offline replay. Warm-up and the
        # validation harness push tens of thousands of samples through the
        # runtime as fast as the CPU allows; paying for a forest evaluation on
        # each one would delay the ground station coming online for no
        # diagnostic benefit, because the model is still learning normality.
        # It trains throughout and starts contributing when the stream does.
        self.learned_enabled = False
        self._learned_countdown = 0
        self._learned_cache: dict[str, dict] = {}
        # Whether the connected source is something this model was calibrated
        # for. Recomputed every analytics pass, because the source can change
        # under the twin while it is running.
        self.envelope: dict = {
            "state": "IN ENVELOPE", "diagnosis_permitted": True,
            "localisation_permitted": True, "health_valid": True,
            "reasons": [], "summary": "", "coverage": {}, "limits": [], "model": {},
        }

    # -- one lockstep step --------------------------------------------------

    def step(self, frame: TelemetryFrame) -> TwinTick:
        inputs = OperatingInputs(
            throttle=float(frame.inputs.get("throttle", 0.0)),
            mixture=float(frame.inputs.get("mixture", 0.6)),
            altitude_ft=float(frame.inputs.get("altitude_ft", 0.0)),
            oat_c=float(frame.inputs.get("oat_c", 15.0)),
            ias_kt=float(frame.inputs.get("ias_kt", 0.0)),
        )

        started = time.perf_counter()
        baseline_state = (
            self.estimator.baseline if self.estimator.status.baseline_locked
            else self.estimator.current
        )
        pred_baseline = self.physics.predict(inputs, baseline_state)
        pred_adapted = self.physics.predict(inputs, self.estimator.current)
        elapsed = time.perf_counter() - started
        if elapsed > 0:
            rate = 2.0 / elapsed
            self.physics_steps_per_s = (
                rate if self.physics_steps_per_s == 0.0
                else 0.98 * self.physics_steps_per_s + 0.02 * rate
            )

        expected = self.expected_lag.apply(pred_baseline.channel_map())
        expected_adapted = self.adapted_lag.apply(pred_adapted.channel_map())

        steady = self.estimator.is_steady(inputs, pred_adapted, frame.phase)
        residuals = self.residuals.compute(frame.channels, expected, steady=steady)

        self.estimator.update(
            frame.channels, pred_adapted, inputs, frame.phase,
            healthy_hint=self._healthy_hint(),
        )
        if self.estimator.status.baseline_locked:
            if self._post_lock_samples == 0:
                self.residuals = ResidualEngine(RESIDUAL_CHANNELS)
                self.detector = AnomalyDetector()
            self._post_lock_samples += 1
            if not self._scales_frozen and self._post_lock_samples >= SCALE_FREEZE_DELAY:
                self.residuals.freeze_scales()
                self._scales_frozen = True

        sync = self._synchronisation(frame.channels, expected_adapted)
        regime = regime_key(pred_adapted.power_fraction, inputs.altitude_ft)

        tick = TwinTick(
            t=frame.t,
            wall_clock=frame.wall_clock,
            flight_id=frame.flight_id,
            phase=frame.phase,
            channels=dict(frame.channels),
            expected=expected,
            expected_adapted=expected_adapted,
            residuals=residuals,
            inputs=dict(frame.inputs),
            power_fraction=pred_adapted.power_fraction,
            power_hp=pred_adapted.power_hp,
            tas_kt=pred_adapted.tas_kt,
            density_ratio=pred_adapted.density_ratio,
            steady=steady,
            sync_pct=sync,
            regime=regime,
        )

        self.buffer.append(tick)
        self.current = tick
        self.samples += 1
        self.last_sync_wall = frame.wall_clock

        self.detector.observe(
            residuals, pred_adapted.power_fraction, inputs.altitude_ft,
            frame.t, frame.flight_id, steady,
        )
        if self.samples % self._series_stride == 0:
            self.flight_series.append(_series_point(tick))
        if self.samples % ANALYTICS_EVERY == 0:
            self.refresh_analytics()
        return tick

    # -- analytics ----------------------------------------------------------

    def refresh_analytics(self) -> None:
        if self.current is None:
            return
        residuals = self.current.residuals
        trim_div = self.estimator.trim_divergence()
        egt_div = self.estimator.egt_trim_divergence()

        # Before anything is diagnosed: is this source one the physics model
        # was calibrated for? A residual computed against a model built for a
        # different engine is a model-mismatch residual, and reporting it as a
        # fault would be the worst thing this system could do.
        self.envelope = envelope_status(self.current.channels, self.current.inputs)

        self.cylinders = cylinder_health(residuals, trim_div)
        self.threshold = threshold_alerts(self.current.channels)
        self.health_index = engine_health_index(self.cylinders, global_health(residuals))
        has_critical = any(a["level"] == "CRITICAL" for a in self.threshold)

        if not self.envelope["diagnosis_permitted"]:
            # Abstain, loudly and with the reason. No health verdict, no
            # anomalies, no advisory - and the threshold alerts stay, because an
            # absolute limit is an absolute limit whatever model is running.
            self.engine_state_label = "MODEL ABSTENTION"
            self.engine_state_reason = self.envelope["summary"]
            self.anomalies = []
            self.advisories = []
            self.prognosis = None
            return

        self.engine_state_label, self.engine_state_reason = engine_status(
            self.health_index, has_critical
        )

        # The learned model trains on this engine's own healthy, steady-state
        # residuals and abstains until it has enough of them. It sits behind a
        # guard on purpose: a model failure degrades the diagnosis to the
        # physics baseline, it never stops the twin.
        try:
            anomaly_model.observe(
                feature_frame(residuals, trim_div, egt_div),
                healthy=self._healthy_hint() and self.estimator.status.baseline_locked,
                steady=self.current.steady,
            )
        except Exception:                             # pragma: no cover - env guard
            pass

        flights_observed = len(self.flights) + 1
        self.anomalies = self.detector.evaluate(residuals, trim_div, egt_div, flights_observed)
        if self.learned_enabled:
            self._learned_countdown -= 1
            if self._learned_countdown <= 0:
                self._learned_countdown = LEARNED_EVERY
                try:
                    self._apply_learned_model(residuals, trim_div, egt_div)
                except Exception:                     # pragma: no cover - env guard
                    pass
            else:
                self._carry_learned_verdicts()
        self.advisories = build_advisories(self.anomalies, self.threshold)

        peak_score = max((a.score for a in self.anomalies), default=0.0)
        history = self.health_history + [self.health_index]
        self.prognosis = serviceability(self.health_index, history, peak_score)

        if self.anomalies and not self.anomalies[0].abstained and self.anomalies[0].cylinder:
            top = self.anomalies[0]
            if top.score > 0.55:
                self.engine_state_reason = (
                    f"Cylinder {top.cylinder} CHT residual increasing"
                )

    def _apply_learned_model(self, residuals, trim_div, egt_div) -> None:
        """Fuse the Isolation Forest verdict into each per-cylinder anomaly.

        The physics baseline keeps the majority weight and an abstaining model
        changes nothing at all, so the fused score can never be worse-founded
        than the interpretable model alone. Where the two disagree, that
        disagreement is published rather than averaged away.

        All four cylinders go through the forest in a single evaluation, and
        only the worst one pays for feature attribution - the forest is the
        most expensive thing in the analytics stack and the twin has to hold
        1 Hz lockstep while replaying a corpus far faster than real time.
        """
        from ..ml.anomaly_model import agreement as model_agreement

        cylinders = [a for a in self.anomalies if a.cylinder]
        if not cylinders:
            return

        features = [
            cylinder_features(a.cylinder, residuals, trim_div, egt_div)
            for a in cylinders
        ]
        worst = max(range(len(cylinders)), key=lambda i: cylinders[i].score)
        verdicts = anomaly_model.score_batch(features, attribute=worst)

        for anomaly, verdict in zip(cylinders, verdicts):
            fused, provenance = fuse_model_score(anomaly.score, verdict)
            anomaly.learned = {
                **verdict.as_dict(),
                "baseline_score": round(anomaly.score, 4),
                "fused_score": round(fused, 4),
                "provenance": provenance,
                "agreement": model_agreement(anomaly.score, verdict),
            }
            self._learned_cache[anomaly.id] = anomaly.learned
            if verdict.trained:
                anomaly.score = fused

        self.anomalies.sort(key=lambda a: (a.score, a.confidence), reverse=True)
        for rank, anomaly in enumerate(self.anomalies, start=1):
            anomaly.rank = rank

    def _carry_learned_verdicts(self) -> None:
        """Re-attach the last learned verdict to freshly-scored anomalies.

        The detector rebuilds its anomaly objects on every pass; without this
        the learned verdict would flicker in and out of the UI between the
        passes that actually re-run the forest.
        """
        for anomaly in self.anomalies:
            previous = self._learned_cache.get(anomaly.id)
            if previous:
                anomaly.learned = previous
                if previous.get("trained"):
                    anomaly.score = previous.get("fused_score", anomaly.score)

    def _healthy_hint(self) -> bool:
        """Do not lock a baseline on an engine that already looks unwell."""
        if not self.cylinders:
            return True
        return all(c.health > 88.0 for c in self.cylinders)

    def _synchronisation(self, observed: dict[str, float], adapted: dict[str, float]) -> float:
        """How well the adapted model tracks the engine, 0..100 %.

        Mean absolute tracking error across the modelled channels, relative to
        each channel's own magnitude. This is the twin's own goodness of fit -
        it is deliberately measured against the ADAPTED model, so a high figure
        means "the twin represents this engine", not "the engine is healthy".
        """
        keys = [k for k in RESIDUAL_CHANNELS if k in observed and k in adapted]
        if not keys:
            return 0.0
        total = 0.0
        for key in keys:
            denom = max(abs(adapted[key]), _SYNC_FLOOR.get(key, 1.0))
            total += min(1.0, abs(observed[key] - adapted[key]) / denom)
        raw = 100.0 * (1.0 - total / len(keys))
        self._sync_ewma = raw if self._sync_ewma is None else 0.985 * self._sync_ewma + 0.015 * raw
        self.sync_pct = self._sync_ewma
        return self.sync_pct

    # -- flight boundary ----------------------------------------------------

    def close_flight(self, flight_id: str, label: str, profile_id: str,
                     duration_s: float, notes: str = "") -> FlightRecord:
        peak_cyl, peak_res = None, 0.0
        for cyl in self.cylinders:
            if abs(cyl.asymmetry_c) > abs(peak_res):
                peak_res = cyl.asymmetry_c
                peak_cyl = cyl.index
        record = FlightRecord(
            flight_id=flight_id,
            label=label,
            profile_id=profile_id,
            duration_s=duration_s,
            health_index=self.health_index,
            peak_cylinder=peak_cyl,
            peak_residual_c=peak_res,
            status=self.engine_state_label,
            samples=self.samples,
            notes=notes,
            series=list(self.flight_series),
        )
        self.flights.append(record)
        self.health_history.append(self.health_index)
        self.flight_series = []
        self.samples = 0
        self.residuals.reset_cusum()
        return record

    def reset_run(self) -> None:
        """Discard everything learned from the current sortie.

        RESET has to leave the twin genuinely cold, or the next run starts with
        the previous run's residual baseline and CUSUM already loaded and the
        anomaly reappears before any evidence for it exists. The detector's
        *trained* state is deliberately kept - it is a model of normality built
        over the whole corpus, not of this sortie.
        """
        self.residuals = ResidualEngine(RESIDUAL_CHANNELS)
        self.estimator = StateEstimator()
        self.expected_lag.reset()
        self.adapted_lag.reset()
        self.buffer.clear()
        self.current = None
        self.cylinders = []
        self.anomalies = []
        self.advisories = []
        self.prognosis = None
        self.threshold = []
        self.health_index = 100.0
        self.engine_state_label = "NORMAL"
        self.engine_state_reason = "Awaiting telemetry"
        self.sync_pct = 0.0
        self.samples = 0
        self._post_lock_samples = 0
        self._scales_frozen = False
        self._sync_ewma = None
        self.flight_series = []
        self.last_sync_wall = "-"
        self._learned_cache = {}
        self._learned_countdown = 0
        self.envelope = envelope_status({}, {})

    # -- reporting ----------------------------------------------------------

    def model_meta(self) -> dict:
        info = self.physics.info
        return {
            "model_id": MODEL_ID,
            "model_version": MODEL_VERSION,
            "physics_backend": info.backend,
            "physics_available": info.available,
            "physics_version": info.version,
            "fidelity": info.fidelity,
            "fidelity_note": info.note,
            "physics_steps_per_s": round(self.physics_steps_per_s, 1),
            "realtime_factor": round(self.physics_steps_per_s, 1),
            "last_sync": self.last_sync_wall,
            "estimator": self.estimator.snapshot(),
            "engine_deck": self.physics.engine_deck(),
        }

    def series(self, channel: str, limit: int = 900) -> list[dict]:
        ticks = list(self.buffer)[-limit:]
        out: list[dict] = []
        for tick in ticks:
            res = tick.residuals.get(channel)
            if res is None:
                continue
            out.append({
                "t": round(tick.t, 1),
                "observed": round(res.observed, 2),
                "expected": round(res.expected, 2),
                "residual": round(res.residual, 3),
                "drift": round(res.ewma, 3),
                "phase": tick.phase,
            })
        return out

    def cylinder_asymmetry(self) -> dict:
        if self.current is None:
            return {"cht": 0.0, "egt": 0.0}
        cht = [self.current.channels.get(f"cht_{i}", 0.0) for i in range(1, 5)]
        egt = [self.current.channels.get(f"egt_{i}", 0.0) for i in range(1, 5)]
        return {"cht": round(asymmetry_index(cht), 2), "egt": round(asymmetry_index(egt), 2)}


def _series_point(tick: TwinTick) -> dict:
    res3 = tick.residuals.get("cht_3")
    return {
        "t": round(tick.t, 1),
        "altitude_ft": round(tick.inputs.get("altitude_ft", 0.0)),
        "ias_kt": round(tick.inputs.get("ias_kt", 0.0), 1),
        "rpm": round(tick.channels.get("rpm", 0.0)),
        "cht_1": round(tick.channels.get("cht_1", 0.0), 1),
        "cht_2": round(tick.channels.get("cht_2", 0.0), 1),
        "cht_3": round(tick.channels.get("cht_3", 0.0), 1),
        "cht_4": round(tick.channels.get("cht_4", 0.0), 1),
        "egt_3": round(tick.channels.get("egt_3", 0.0), 1),
        "oil_press_psi": round(tick.channels.get("oil_press_psi", 0.0), 1),
        "oil_temp_c": round(tick.channels.get("oil_temp_c", 0.0), 1),
        "residual_cht_3": round(res3.residual, 2) if res3 else 0.0,
        "phase": tick.phase,
    }
