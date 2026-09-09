"""
The residual engine.

    residual = observed - physics_expected

computed per channel and, critically, per cylinder, every second.

A threshold monitor asks "is CHT above 230 degC?". The residual asks "given
this throttle setting, this altitude, this outside air temperature and this
airspeed, physics says cylinder 3 should be at 198 degC - it is at 214 degC,
why?". The second question detects a developing fault while every absolute
value is still inside limits.

Everything downstream in the analytics layer consumes residuals, never raw
sensor values. That is the design decision that separates a twin from a
dashboard.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

from ..core.constants import CHANNEL_BY_KEY, RESIDUAL_CHANNELS

WINDOW = 600                # samples held for robust scale estimation
EWMA_ALPHA = 0.004          # slow drift tracker (~250 sample time constant)
CUSUM_SLACK_SIGMA = 0.75    # allowance before the persistence counter accrues
CUSUM_LEAK = 0.9995         # slow decay so a micro-bias cannot accumulate forever
CUSUM_CAP = 600.0


@dataclass(slots=True)
class ChannelResidual:
    key: str
    observed: float
    expected: float
    residual: float
    normalised: float          # robust z-score against the healthy scale
    ewma: float                # slow-moving drift estimate
    cusum: float               # accumulated one-sided persistence
    scale: float               # robust sigma used for normalisation
    unit: str

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "observed": round(self.observed, 3),
            "expected": round(self.expected, 3),
            "residual": round(self.residual, 3),
            "normalised": round(self.normalised, 3),
            "ewma": round(self.ewma, 3),
            "cusum": round(self.cusum, 3),
            "scale": round(self.scale, 4),
            "unit": self.unit,
        }


@dataclass(slots=True)
class _ChannelTracker:
    key: str
    history: deque = field(default_factory=lambda: deque(maxlen=WINDOW))
    ewma: float = 0.0
    cusum_pos: float = 0.0
    cusum_neg: float = 0.0
    scale: float = 1.0
    seeded: bool = False
    frozen_scale: float | None = None


class ResidualEngine:
    """Per-channel residual computation with robust normalisation."""

    def __init__(self, channels: list[str] | None = None) -> None:
        self.channels = channels or list(RESIDUAL_CHANNELS)
        self.trackers = {k: _ChannelTracker(k) for k in self.channels}

    def freeze_scales(self) -> None:
        """Lock the healthy noise scale so a growing fault cannot inflate it.

        Without this, a slowly growing residual widens its own tolerance band
        and normalises itself away - a classic self-masking failure in
        adaptive monitors.
        """
        for tracker in self.trackers.values():
            if len(tracker.history) >= 60:
                tracker.frozen_scale = _robust_sigma(tracker.history)

    def compute(
        self,
        observed: dict[str, float],
        expected: dict[str, float],
        steady: bool = True,
    ) -> dict[str, ChannelResidual]:
        out: dict[str, ChannelResidual] = {}
        for key in self.channels:
            if key not in observed or key not in expected:
                continue
            tracker = self.trackers[key]
            obs = float(observed[key])
            exp = float(expected[key])
            res = obs - exp

            if steady:
                tracker.history.append(res)

            scale = tracker.frozen_scale
            if scale is None:
                scale = _robust_sigma(tracker.history) if len(tracker.history) >= 30 else None
            if scale is None or scale <= 1e-6:
                scale = _default_scale(key)
            tracker.scale = scale

            if not tracker.seeded:
                tracker.ewma = res
                tracker.seeded = True
            elif steady:
                tracker.ewma += EWMA_ALPHA * (res - tracker.ewma)

            z = res / scale
            if steady:
                slack = CUSUM_SLACK_SIGMA
                tracker.cusum_pos = min(
                    CUSUM_CAP, max(0.0, tracker.cusum_pos * CUSUM_LEAK + z - slack)
                )
                tracker.cusum_neg = min(
                    CUSUM_CAP, max(0.0, tracker.cusum_neg * CUSUM_LEAK - z - slack)
                )

            out[key] = ChannelResidual(
                key=key,
                observed=obs,
                expected=exp,
                residual=res,
                normalised=z,
                ewma=tracker.ewma,
                cusum=max(tracker.cusum_pos, tracker.cusum_neg),
                scale=scale,
                unit=CHANNEL_BY_KEY.get(key, {}).get("unit", ""),
            )
        return out

    def reset_cusum(self) -> None:
        for tracker in self.trackers.values():
            tracker.cusum_pos = 0.0
            tracker.cusum_neg = 0.0


# --------------------------------------------------------------------------


def _robust_sigma(values) -> float:
    """Median absolute deviation, scaled to a Gaussian-equivalent sigma.

    Robust rather than a plain standard deviation: a developing fault is an
    outlier population, and it must not be allowed to widen its own band.
    """
    data = sorted(values)
    n = len(data)
    if n < 4:
        return 0.0
    med = data[n // 2] if n % 2 else 0.5 * (data[n // 2 - 1] + data[n // 2])
    deviations = sorted(abs(v - med) for v in data)
    mad = deviations[n // 2] if n % 2 else 0.5 * (deviations[n // 2 - 1] + deviations[n // 2])
    return 1.4826 * mad


_DEFAULT_SCALES = {
    "cht_1": 1.6, "cht_2": 1.6, "cht_3": 1.6, "cht_4": 1.6,
    "egt_1": 5.0, "egt_2": 5.0, "egt_3": 5.0, "egt_4": 5.0,
    "map_inhg": 0.22, "rpm": 14.0,
    "oil_press_psi": 1.4, "oil_temp_c": 1.1, "fuel_flow_gph": 0.25,
}


def _default_scale(key: str) -> float:
    return _DEFAULT_SCALES.get(key, 1.0)


def asymmetry_index(values: list[float]) -> float:
    """Peak deviation from the four-cylinder mean.

    A failing cylinder shows up as asymmetry between the four channels, not as
    a change in the average. This single number is the piston-engine
    diagnostic that a fleet-level scalar dataset cannot express.
    """
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    return max(abs(v - mean) for v in values)


def dispersion(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))
