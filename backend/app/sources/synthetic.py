"""
Demo telemetry simulator - clearly and permanently tagged SYNTHETIC.

This source stands in for the NGAFID-MC replay when the 5.4 GB corpus has not
been downloaded. It is NOT called real data anywhere in the product.

It is not a random number generator. It runs the same thermodynamic model the
twin uses, but against a *hidden* engine state the twin cannot see:

  * a unit-specific fingerprint (volumetric efficiency, cooling effectiveness
    and per-cylinder trim slightly off nominal - every real engine has one),
  * a progressive degradation mechanism (the demo scenario),
  * thermal inertia,
  * sensor noise and slow sensor bias.

The residual the twin computes is therefore a genuine emergent quantity, not a
scripted number.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..core.constants import FAILURE_MODES
from ..mission.profiles import MissionProfile, get_profile, sample_profile
from ..physics.piston import EngineState, PistonEngineModel
from .base import DEFAULT_LAG_TAU, DataSource, SourceDescriptor, TelemetryFrame, ThermalLag

SENSOR_NOISE = {
    "rpm": 6.0, "map_inhg": 0.10, "fuel_flow_gph": 0.09,
    "egt_1": 2.6, "egt_2": 2.6, "egt_3": 2.6, "egt_4": 2.6,
    "cht_1": 0.55, "cht_2": 0.55, "cht_3": 0.55, "cht_4": 0.55,
    "oil_press_psi": 0.6, "oil_temp_c": 0.35,
    "vibration_g": 0.012, "inj_timing_deg": 0.11,
}


@dataclass(slots=True)
class DegradationSpec:
    """A progressive mechanical degradation injected into the hidden truth."""

    mechanism: str = "exhaust_valve_distress"
    cylinder: int = 3                  # 1-indexed
    severity_start: float = 0.0        # 0..1 at t=0
    severity_end: float = 0.0          # 0..1 at end of flight
    onset_fraction: float = 0.15       # mission fraction before growth begins
    enabled: bool = True

    def severity_at(self, progress: float) -> float:
        if not self.enabled:
            return 0.0
        if progress <= self.onset_fraction:
            return self.severity_start
        u = (progress - self.onset_fraction) / max(1e-6, 1.0 - self.onset_fraction)
        u = max(0.0, min(1.0, u))
        # Degradation is not linear: thermal damage accelerates once the
        # affected surface starts to lose its seal.
        shaped = u ** 1.35
        return self.severity_start + (self.severity_end - self.severity_start) * shaped

    def as_dict(self) -> dict:
        mode = FAILURE_MODES.get(self.mechanism, {})
        return {
            "mechanism": self.mechanism,
            "label": mode.get("label", self.mechanism),
            "cylinder": self.cylinder,
            "severity_start": self.severity_start,
            "severity_end": self.severity_end,
            "enabled": self.enabled,
        }


# Physical effect of each mechanism at unit severity.
MECHANISM_EFFECT = {
    "exhaust_valve_distress": {
        "cyl_heat_trim": 0.092,     # fraction of head heat rejection
        "cyl_egt_c": 27.0,          # degC on that cylinder's exhaust
        "vibration_g": 0.06,
        "oil_press_psi": 0.0,
        "fuel_flow_gph": 0.0,
    },
    "plug_fouling": {
        "cyl_heat_trim": -0.035,
        "cyl_egt_c": -46.0,
        "vibration_g": 0.14,
        "oil_press_psi": 0.0,
        "fuel_flow_gph": 0.10,
    },
    "bearing_wear": {
        "cyl_heat_trim": 0.0,
        "cyl_egt_c": 0.0,
        "vibration_g": 0.22,
        "oil_press_psi": -7.5,
        "fuel_flow_gph": 0.0,
    },
    "cylinder_head_cracking": {
        "cyl_heat_trim": 0.075,
        "cyl_egt_c": -8.0,
        "vibration_g": 0.05,
        "oil_press_psi": 0.0,
        "fuel_flow_gph": 0.0,
    },
}


@dataclass(slots=True)
class EngineFingerprint:
    """Unit-to-unit variation. Every engine leaves the factory slightly unique."""

    volumetric_efficiency: float = 0.986
    cooling_effectiveness: float = 0.974
    cylinder_trim: list[float] = field(default_factory=lambda: [0.006, -0.004, 0.009, 0.002])
    cylinder_egt_trim: list[float] = field(default_factory=lambda: [1.8, -2.4, 2.9, -0.7])

    def to_state(self) -> EngineState:
        return EngineState(
            volumetric_efficiency=self.volumetric_efficiency,
            cooling_effectiveness=self.cooling_effectiveness,
            cylinder_trim=list(self.cylinder_trim),
            cylinder_egt_trim=list(self.cylinder_egt_trim),
        )


class SyntheticFlightSource(DataSource):
    """Physics-driven demo telemetry. Provenance: DEMO / SYNTHETIC."""

    def __init__(
        self,
        profile: MissionProfile | str | None = None,
        flight_id: str = "DEMO-0001",
        degradation: DegradationSpec | None = None,
        fingerprint: EngineFingerprint | None = None,
        seed: int = 26054,
        wear_offset: float = 0.0,
    ) -> None:
        self.profile = profile if isinstance(profile, MissionProfile) else get_profile(profile)
        self.flight_id = flight_id
        self.degradation = degradation or DegradationSpec()
        self.fingerprint = fingerprint or EngineFingerprint()
        self.model = PistonEngineModel()
        self.rng = random.Random(seed)
        self.lag = ThermalLag(DEFAULT_LAG_TAU)
        self.wear_offset = wear_offset      # accumulated wear from prior flights
        self._t = 0.0
        self._bias = {k: self.rng.gauss(0.0, v * 0.45) for k, v in SENSOR_NOISE.items()}
        self._open = False

    # -- DataSource ---------------------------------------------------------

    @property
    def descriptor(self) -> SourceDescriptor:
        return SourceDescriptor(
            id="DEMO_TELEMETRY",
            label="DEMO TELEMETRY",
            kind="SYNTHETIC",
            provenance="DEMO / SYNTHETIC",
            available=True,
            detail=(
                "Physics-driven telemetry simulator. Produced by the same "
                "thermodynamic model the twin runs, against a hidden engine "
                "state, with injected degradation, thermal inertia and sensor "
                "noise. Never presented as measured data."
            ),
        )

    def open(self, **kwargs) -> None:
        self._t = 0.0
        self.lag.reset()
        self._open = True

    def read(self) -> TelemetryFrame | None:
        if not self._open:
            self.open()
        if self._t > self.profile.duration_s:
            return None
        frame = self.sample(self._t)
        self._t += 1.0
        return frame

    def close(self) -> None:
        self._open = False

    # -- truth generation ---------------------------------------------------

    def hidden_state(self, progress: float) -> tuple[EngineState, float]:
        """The true engine state at this point in the mission."""
        state = self.fingerprint.to_state()
        severity = min(1.0, self.degradation.severity_at(progress) + self.wear_offset)
        if severity > 0.0 and self.degradation.enabled:
            effect = MECHANISM_EFFECT.get(
                self.degradation.mechanism, MECHANISM_EFFECT["exhaust_valve_distress"]
            )
            idx = max(0, min(3, self.degradation.cylinder - 1))
            state.cylinder_trim[idx] += effect["cyl_heat_trim"] * severity
            state.cylinder_egt_trim[idx] += effect["cyl_egt_c"] * severity
        # Global slow ageing: cooling fins foul, rings wear. Small but real.
        state.cooling_effectiveness -= 0.010 * self.wear_offset
        state.volumetric_efficiency -= 0.006 * self.wear_offset
        return state, severity

    def sample(self, t: float) -> TelemetryFrame:
        condition = sample_profile(self.profile, t)
        state, severity = self.hidden_state(condition.progress)
        pred = self.model.predict(condition.inputs, state)

        channels = pred.channel_map()

        effect = MECHANISM_EFFECT.get(
            self.degradation.mechanism, MECHANISM_EFFECT["exhaust_valve_distress"]
        )
        channels["vibration_g"] += effect["vibration_g"] * severity
        channels["oil_press_psi"] += effect["oil_press_psi"] * severity
        channels["fuel_flow_gph"] += effect["fuel_flow_gph"] * severity

        channels = self.lag.apply(channels, dt=1.0)

        for key, sigma in SENSOR_NOISE.items():
            if key in channels:
                channels[key] += self._bias[key] + self.rng.gauss(0.0, sigma)

        # Ambient channels are measured too.
        channels["oat_c"] = condition.inputs.oat_c + self.rng.gauss(0.0, 0.18)
        channels["altitude_ft"] = condition.inputs.altitude_ft + self.rng.gauss(0.0, 6.0)
        channels["ias_kt"] = condition.inputs.ias_kt + self.rng.gauss(0.0, 0.5)

        if condition.phase == "GROUND":
            for k in ("rpm", "map_inhg", "fuel_flow_gph"):
                channels[k] = channels[k]
            channels["ias_kt"] = max(0.0, channels["ias_kt"])

        return TelemetryFrame(
            t=t,
            wall_clock=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            flight_id=self.flight_id,
            source_id="DEMO_TELEMETRY",
            phase=condition.phase,
            channels={k: round(v, 4) for k, v in channels.items()},
            inputs={
                "throttle": round(condition.inputs.throttle, 4),
                "mixture": round(condition.inputs.mixture, 4),
                "altitude_ft": round(condition.inputs.altitude_ft, 1),
                "oat_c": round(condition.inputs.oat_c, 2),
                "ias_kt": round(condition.inputs.ias_kt, 2),
                "progress": round(condition.progress, 5),
                "_truth_severity": round(severity, 4),
            },
        )

    def seek(self, t: float) -> None:
        self._t = max(0.0, t)

