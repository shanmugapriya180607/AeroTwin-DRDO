"""
Health index computation.

Per-cylinder health first, engine health second. The system does not say "the
engine is unwell" - it says "cylinder 3". Health is derived from residual
asymmetry measured against the *median* of the four cylinders, which is robust
to exactly the case that matters: one cylinder diverging while three stay
normal. A mean-based measure would drag the three healthy cylinders down with
the failing one.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..core.constants import ENGINE
from ..twin.residual import ChannelResidual

K_CHT_ASYM = 1.15        # health points per degC of CHT residual asymmetry
K_EGT_ASYM = 0.18        # health points per degC of EGT residual asymmetry
K_TRIM = 1.00            # health points per % of trim divergence
K_MARGIN = 10.0          # health points at zero margin to the CHT redline
MARGIN_BAND_C = 32.0     # margin below which the redline penalty engages

W_MEAN_CYL = 0.35
W_MIN_CYL = 0.45
W_GLOBAL = 0.20


@dataclass(slots=True)
class CylinderHealth:
    index: int
    health: float
    status: str
    cht_observed: float
    cht_expected: float
    cht_residual: float
    cht_drift: float
    egt_observed: float
    egt_expected: float
    egt_residual: float
    egt_drift: float
    trim_divergence_pct: float
    asymmetry_c: float
    margin_to_redline_c: float

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "health": round(self.health, 1),
            "status": self.status,
            "cht_observed": round(self.cht_observed, 1),
            "cht_expected": round(self.cht_expected, 1),
            "cht_residual": round(self.cht_residual, 1),
            "cht_drift": round(self.cht_drift, 2),
            "egt_observed": round(self.egt_observed, 1),
            "egt_expected": round(self.egt_expected, 1),
            "egt_residual": round(self.egt_residual, 1),
            "egt_drift": round(self.egt_drift, 2),
            "trim_divergence_pct": round(self.trim_divergence_pct, 2),
            "asymmetry_c": round(self.asymmetry_c, 2),
            "margin_to_redline_c": round(self.margin_to_redline_c, 1),
        }


def _median(values: list[float]) -> float:
    data = sorted(values)
    n = len(data)
    if n == 0:
        return 0.0
    return data[n // 2] if n % 2 else 0.5 * (data[n // 2 - 1] + data[n // 2])


def cylinder_status(health: float) -> str:
    if health >= 90.0:
        return "NORMAL"
    if health >= 80.0:
        return "WATCH"
    if health >= 65.0:
        return "DEGRADING"
    return "CRITICAL"


def cylinder_health(
    residuals: dict[str, ChannelResidual],
    trim_divergence: list[float],
) -> list[CylinderHealth]:
    cht_drifts = [residuals[f"cht_{i}"].ewma for i in range(1, 5) if f"cht_{i}" in residuals]
    egt_drifts = [residuals[f"egt_{i}"].ewma for i in range(1, 5) if f"egt_{i}" in residuals]
    cht_ref = _median(cht_drifts)
    egt_ref = _median(egt_drifts)

    out: list[CylinderHealth] = []
    for i in range(1, 5):
        cht = residuals.get(f"cht_{i}")
        egt = residuals.get(f"egt_{i}")
        if cht is None:
            continue
        asym = cht.ewma - cht_ref
        egt_asym = (egt.ewma - egt_ref) if egt else 0.0
        trim = (trim_divergence[i - 1] * 100.0) if i <= len(trim_divergence) else 0.0
        margin = ENGINE["cht_redline_c"] - cht.observed

        penalty = (
            K_CHT_ASYM * abs(asym)
            + K_EGT_ASYM * abs(egt_asym)
            + K_TRIM * abs(trim)
        )
        if margin < MARGIN_BAND_C:
            penalty += K_MARGIN * (1.0 - max(0.0, margin) / MARGIN_BAND_C)

        health = max(0.0, min(100.0, 100.0 - penalty))
        out.append(
            CylinderHealth(
                index=i,
                health=health,
                status=cylinder_status(health),
                cht_observed=cht.observed,
                cht_expected=cht.expected,
                cht_residual=cht.residual,
                cht_drift=cht.ewma,
                egt_observed=egt.observed if egt else 0.0,
                egt_expected=egt.expected if egt else 0.0,
                egt_residual=egt.residual if egt else 0.0,
                egt_drift=egt.ewma if egt else 0.0,
                trim_divergence_pct=trim,
                asymmetry_c=asym,
                margin_to_redline_c=margin,
            )
        )
    return out


def global_health(residuals: dict[str, ChannelResidual]) -> float:
    """Health of the non-per-cylinder subsystems, from their residual drift."""
    penalties = {
        "oil_press_psi": 4.5,     # health points per psi of drift
        "oil_temp_c": 1.6,
        "fuel_flow_gph": 6.0,
        "map_inhg": 5.0,
        "rpm": 0.10,
    }
    penalty = 0.0
    for key, weight in penalties.items():
        res = residuals.get(key)
        if res is None:
            continue
        penalty += weight * abs(res.ewma)
    return max(0.0, min(100.0, 100.0 - penalty))


def engine_health_index(
    cylinders: list[CylinderHealth], global_component: float
) -> float:
    if not cylinders:
        return global_component
    values = [c.health for c in cylinders]
    mean_h = sum(values) / len(values)
    min_h = min(values)
    return max(
        0.0,
        min(100.0, W_MEAN_CYL * mean_h + W_MIN_CYL * min_h + W_GLOBAL * global_component),
    )


def engine_status(health: float, has_critical_threshold: bool) -> tuple[str, str]:
    """Overall engine state and the reason for it."""
    if has_critical_threshold:
        return "CRITICAL", "Absolute limit exceeded - threshold safety floor active"
    if health >= 90.0:
        return "NORMAL", "All channels tracking physics expectation"
    if health >= 72.0:
        return "DEGRADED", "Residual divergence detected below alarm thresholds"
    return "CRITICAL", "Severe residual divergence - engine outside its own physics"
