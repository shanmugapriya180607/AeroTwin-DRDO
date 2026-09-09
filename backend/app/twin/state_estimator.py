"""
Online engine state estimation.

This is the feedback arm of the twin. Without it you have a simulation running
next to a sensor feed; with it the model adapts to *this* engine, which is what
the word twin actually means.

Four families of slow parameter are tracked by exponentially-weighted
recursive estimation, updated only in steady-state regimes:

    volumetric efficiency   - induction health, observable from air/fuel flow
    cooling effectiveness   - fin fouling and baffle condition, from mean CHT
    per-cylinder heat trim  - localised combustion/valve condition, from CHT asymmetry
    per-cylinder EGT trim   - localised combustion quality, from EGT asymmetry

Two model evaluations are then maintained every second:

    BASELINE  - the healthy fingerprint of this engine, locked once the
                estimator has converged on known-good operation. The residual
                the diagnostics consume is measured against this.
    ADAPTED   - the live estimate. Its residual is near zero by construction,
                and that is precisely what "twin synchronised" means.

Deliberate design choice: the fault must not be absorbed by the estimator.
Locking the baseline is what prevents the adaptation loop from quietly
explaining away the degradation it is supposed to detect.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..core.constants import CYLINDER_COOLING_BIAS, CYLINDER_EGT_BIAS
from ..physics.piston import EnginePrediction, EngineState, OperatingInputs

GAIN_GLOBAL = 0.0035          # volumetric efficiency, cooling effectiveness
GAIN_TRIM = 0.0022            # per-cylinder parameters (slower - these are diagnostic)
CONVERGENCE_SAMPLES = 240     # steady samples before the estimator is CALIBRATED
BASELINE_LOCK_SAMPLES = 420   # steady samples before the healthy baseline is frozen


@dataclass(slots=True)
class EstimatorStatus:
    state: str = "INITIALISING"    # INITIALISING | ADAPTING | CALIBRATED
    steady_samples: int = 0
    total_samples: int = 0
    baseline_locked: bool = False
    convergence: float = 0.0       # 0..1
    innovation: float = 0.0        # magnitude of the last correction applied
    gated: bool = False            # true while the regime gate holds adaptation


@dataclass(slots=True)
class StateEstimator:
    current: EngineState = field(default_factory=EngineState)
    baseline: EngineState = field(default_factory=EngineState)
    status: EstimatorStatus = field(default_factory=EstimatorStatus)
    _prev_throttle: float | None = None

    # -- gating -------------------------------------------------------------

    def is_steady(self, inputs: OperatingInputs, prediction: EnginePrediction, phase: str) -> bool:
        """Only adapt in regimes where the estimate is actually observable."""
        if phase in ("GROUND", "TAKEOFF", "APPROACH"):
            return False
        if prediction.power_fraction < 0.25:
            return False
        if self._prev_throttle is not None and abs(inputs.throttle - self._prev_throttle) > 0.012:
            return False
        return True

    # -- update -------------------------------------------------------------

    def update(
        self,
        observed: dict[str, float],
        expected_adapted: EnginePrediction,
        inputs: OperatingInputs,
        phase: str,
        healthy_hint: bool = True,
    ) -> EstimatorStatus:
        self.status.total_samples += 1
        steady = self.is_steady(inputs, expected_adapted, phase)
        self._prev_throttle = inputs.throttle

        self.status.gated = not steady
        if not steady:
            # Adaptation is held outside observable regimes; the converged
            # state and the reported model status both persist.
            return self.status

        self.status.steady_samples += 1
        innovation = 0.0

        # --- volumetric efficiency from measured induction flow ------------
        ff_obs = observed.get("fuel_flow_gph")
        ff_exp = expected_adapted.fuel_flow_gph
        if ff_obs is not None and ff_exp > 0.5:
            ratio = max(0.75, min(1.25, ff_obs / ff_exp))
            delta = GAIN_GLOBAL * (ratio - 1.0) * self.current.volumetric_efficiency
            self.current.volumetric_efficiency = _clamp(
                self.current.volumetric_efficiency + delta, 0.80, 1.15
            )
            innovation += abs(delta)

        # --- cooling effectiveness from the MEDIAN head rise ---------------
        # Deliberately the median and not the mean: a single failing cylinder
        # must not be able to bias a global engine parameter. With a mean
        # reference, one hot cylinder drags the cooling estimate up and pushes
        # the three healthy cylinders to a spurious negative trim - the fault
        # gets smeared across all four instead of localised to one.
        cht_obs = [observed.get(f"cht_{i}") for i in range(1, 5)]
        if all(v is not None for v in cht_obs):
            obs_rise = _median(
                [cht_obs[i] - inputs.oat_c - CYLINDER_COOLING_BIAS[i] for i in range(4)]  # type: ignore[operator]
            )
            exp_rise = _median(
                [expected_adapted.cht_c[i] - inputs.oat_c - CYLINDER_COOLING_BIAS[i] for i in range(4)]
            )
            if obs_rise > 15.0 and exp_rise > 15.0:
                # head rise is inversely proportional to cooling conductance
                ratio = max(0.75, min(1.35, exp_rise / obs_rise))
                delta = GAIN_GLOBAL * (ratio - 1.0) * self.current.cooling_effectiveness
                self.current.cooling_effectiveness = _clamp(
                    self.current.cooling_effectiveness + delta, 0.60, 1.25
                )
                innovation += abs(delta)

                # --- per-cylinder heat trim from CHT asymmetry -------------
                # Referenced to the same robust median, so a diverging
                # cylinder carries its own trim and the others stay at zero.
                for i in range(4):
                    measured_i = cht_obs[i] - inputs.oat_c - CYLINDER_COOLING_BIAS[i]  # type: ignore[operator]
                    target_trim = measured_i / max(1.0, obs_rise) - 1.0
                    err = target_trim - self.current.cylinder_trim[i]
                    self.current.cylinder_trim[i] = _clamp(
                        self.current.cylinder_trim[i] + GAIN_TRIM * err, -0.35, 0.45
                    )
                    innovation += abs(GAIN_TRIM * err)

        # --- per-cylinder EGT trim from exhaust asymmetry ------------------
        egt_obs = [observed.get(f"egt_{i}") for i in range(1, 5)]
        if all(v is not None for v in egt_obs):
            mean_obs = sum(egt_obs) / 4.0                            # type: ignore[arg-type]
            mean_exp = sum(expected_adapted.egt_c) / 4.0
            for i in range(4):
                asym_obs = egt_obs[i] - mean_obs - CYLINDER_EGT_BIAS[i]   # type: ignore[operator]
                asym_exp = expected_adapted.egt_c[i] - mean_exp - CYLINDER_EGT_BIAS[i]
                err = (asym_obs - asym_exp) + self.current.cylinder_egt_trim[i]
                self.current.cylinder_egt_trim[i] = _clamp(
                    self.current.cylinder_egt_trim[i]
                    + GAIN_TRIM * (err - self.current.cylinder_egt_trim[i]),
                    -60.0, 60.0,
                )
                innovation += abs(GAIN_TRIM * err) * 0.01

        self.status.innovation = innovation
        self.status.convergence = min(1.0, self.status.steady_samples / CONVERGENCE_SAMPLES)

        if self.status.steady_samples >= CONVERGENCE_SAMPLES:
            self.status.state = "CALIBRATED"
        else:
            self.status.state = "ADAPTING"

        # --- baseline lock -------------------------------------------------
        if (
            not self.status.baseline_locked
            and healthy_hint
            and self.status.steady_samples >= BASELINE_LOCK_SAMPLES
        ):
            self.baseline = self.current.copy()
            self.status.baseline_locked = True

        return self.status

    # -- reporting ----------------------------------------------------------

    def trim_divergence(self) -> list[float]:
        """Current per-cylinder trim minus the locked healthy baseline."""
        return [
            self.current.cylinder_trim[i] - self.baseline.cylinder_trim[i]
            for i in range(4)
        ]

    def egt_trim_divergence(self) -> list[float]:
        return [
            self.current.cylinder_egt_trim[i] - self.baseline.cylinder_egt_trim[i]
            for i in range(4)
        ]

    def snapshot(self) -> dict:
        return {
            "state": self.status.state,
            "gated": self.status.gated,
            "baseline_locked": self.status.baseline_locked,
            "convergence": round(self.status.convergence, 4),
            "steady_samples": self.status.steady_samples,
            "total_samples": self.status.total_samples,
            "innovation": round(self.status.innovation, 6),
            "current": {
                "volumetric_efficiency": round(self.current.volumetric_efficiency, 5),
                "cooling_effectiveness": round(self.current.cooling_effectiveness, 5),
                "cylinder_trim": [round(v, 5) for v in self.current.cylinder_trim],
                "cylinder_egt_trim": [round(v, 3) for v in self.current.cylinder_egt_trim],
            },
            "baseline": {
                "volumetric_efficiency": round(self.baseline.volumetric_efficiency, 5),
                "cooling_effectiveness": round(self.baseline.cooling_effectiveness, 5),
                "cylinder_trim": [round(v, 5) for v in self.baseline.cylinder_trim],
                "cylinder_egt_trim": [round(v, 3) for v in self.baseline.cylinder_egt_trim],
            },
            "trim_divergence": [round(v, 5) for v in self.trim_divergence()],
            "egt_trim_divergence": [round(v, 3) for v in self.egt_trim_divergence()],
        }

    def seed_baseline(self, state: EngineState) -> None:
        """Carry a locked baseline across flights of the same engine."""
        self.baseline = state.copy()
        self.current = state.copy()
        self.status.baseline_locked = True
        self.status.state = "CALIBRATED"
        self.status.convergence = 1.0
        self.status.steady_samples = CONVERGENCE_SAMPLES


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _median(values: list[float]) -> float:
    data = sorted(values)
    n = len(data)
    if n == 0:
        return 0.0
    return data[n // 2] if n % 2 else 0.5 * (data[n // 2 - 1] + data[n // 2])
