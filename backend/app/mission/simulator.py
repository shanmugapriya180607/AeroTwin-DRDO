"""
Mission simulation.

Answers the planner's question: given the engine *as it is now* - including
whatever degradation the twin has estimated - how will it behave on this
proposed sortie?

This is not a replay and not a canned animation. The physics model is run
forward over the candidate profile using the live estimated engine state, so a
degraded cylinder shows up in the prediction, and a hot-weather profile shows
it getting worse. The four operating conditions named in the problem statement
are the built-in profiles.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..analytics.prognostics import mission_risk
from ..core.constants import ENGINE
from ..physics.jsbsim_adapter import physics_backend
from ..physics.piston import EngineState
from ..sources.base import DEFAULT_LAG_TAU, ThermalLag
from .profiles import MissionProfile, sample_profile

SIM_STRIDE_S = 20


class _LaggedPrediction:
    """A prediction with thermal inertia applied to the temperature channels."""

    __slots__ = ("_raw", "cht_c", "egt_c", "oil_temp_c", "oil_press_psi",
                 "rpm", "map_inhg", "power_fraction", "fuel_flow_gph")

    def __init__(self, raw, lagged: dict[str, float]) -> None:
        self._raw = raw
        self.cht_c = [lagged[f"cht_{i}"] for i in range(1, 5)]
        self.egt_c = [lagged[f"egt_{i}"] for i in range(1, 5)]
        self.oil_temp_c = lagged["oil_temp_c"]
        self.oil_press_psi = lagged["oil_press_psi"]
        self.rpm = raw.rpm
        self.map_inhg = raw.map_inhg
        self.power_fraction = raw.power_fraction
        self.fuel_flow_gph = raw.fuel_flow_gph


@dataclass
class SimulationResult:
    run_id: str
    profile: dict
    series: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)
    warnings: list[dict] = field(default_factory=list)
    provenance: str = "PHYSICS FORWARD SIMULATION"

    def as_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "profile": self.profile,
            "series": self.series,
            "summary": self.summary,
            "warnings": self.warnings,
            "provenance": self.provenance,
        }


def run_simulation(
    profile: MissionProfile,
    engine_state: EngineState,
    baseline_state: EngineState,
    health_index: float,
    p_serviceable: float,
    run_id: str,
    stride_s: int = SIM_STRIDE_S,
) -> SimulationResult:
    """Forward-simulate the sortie on the current estimated engine state."""
    series: list[dict] = []
    peak_cht = 0.0
    peak_cht_cylinder = 0
    peak_asymmetry = 0.0
    peak_oil_temp = 0.0
    min_oil_press = 999.0
    fuel_burned_gal = 0.0
    caution_seconds = 0
    redline_seconds = 0

    # Cylinder heads and oil have real thermal inertia. Without it the forward
    # simulation reports the steady-state temperature of a 90-second takeoff
    # segment, which the engine never actually reaches from cold.
    actual_lag = ThermalLag(DEFAULT_LAG_TAU)
    nominal_lag = ThermalLag(DEFAULT_LAG_TAU)

    t = 0.0
    duration = profile.duration_s
    while t <= duration:
        condition = sample_profile(profile, t)
        actual_raw = physics_backend.predict(condition.inputs, engine_state)
        nominal_raw = physics_backend.predict(condition.inputs, baseline_state)
        actual = _LaggedPrediction(actual_raw, actual_lag.apply(actual_raw.channel_map(), stride_s))
        nominal = _LaggedPrediction(nominal_raw, nominal_lag.apply(nominal_raw.channel_map(), stride_s))

        cht = actual.cht_c
        cht_nominal = nominal.cht_c
        residuals = [cht[i] - cht_nominal[i] for i in range(4)]
        asym = max(residuals) - min(residuals)
        hottest = max(range(4), key=lambda i: cht[i])

        if cht[hottest] > peak_cht:
            peak_cht = cht[hottest]
            peak_cht_cylinder = hottest + 1
        peak_asymmetry = max(peak_asymmetry, asym)
        peak_oil_temp = max(peak_oil_temp, actual.oil_temp_c)
        min_oil_press = min(min_oil_press, actual.oil_press_psi)
        fuel_burned_gal += actual.fuel_flow_gph * (stride_s / 3600.0)

        if cht[hottest] >= ENGINE["cht_redline_c"]:
            redline_seconds += stride_s
        elif cht[hottest] >= ENGINE["cht_caution_c"]:
            caution_seconds += stride_s

        # Health projection: the residual asymmetry the twin would compute at
        # this operating point, scored with the same penalty the live health
        # index uses.
        projected_health = max(
            0.0, min(100.0, 100.0 - 1.15 * _median_asymmetry(residuals) * 1.0)
        )

        series.append({
            "t": round(t),
            "phase": condition.phase,
            "altitude_ft": round(condition.inputs.altitude_ft),
            "ias_kt": round(condition.inputs.ias_kt, 1),
            "throttle": round(condition.inputs.throttle, 3),
            "oat_c": round(condition.inputs.oat_c, 1),
            "rpm": round(actual.rpm),
            "map_inhg": round(actual.map_inhg, 2),
            "power_pct": round(actual.power_fraction * 100.0, 1),
            "fuel_flow_gph": round(actual.fuel_flow_gph, 2),
            "cht": [round(v, 1) for v in cht],
            "cht_expected": [round(v, 1) for v in cht_nominal],
            "egt": [round(v, 1) for v in actual.egt_c],
            "oil_temp_c": round(actual.oil_temp_c, 1),
            "oil_press_psi": round(actual.oil_press_psi, 1),
            "residual_max_c": round(max(residuals, key=abs), 2),
            "asymmetry_c": round(asym, 2),
            "projected_health": round(projected_health, 1),
        })
        t += stride_s

    warnings: list[dict] = []
    if redline_seconds >= 60:
        warnings.append({
            "level": "CRITICAL",
            "title": f"CHT-{peak_cht_cylinder} PROJECTED ABOVE REDLINE",
            "detail": (
                f"Predicted peak {peak_cht:.0f} °C exceeds the {ENGINE['cht_redline_c']:.0f} °C "
                f"limit for {redline_seconds // 60} minutes of this profile."
            ),
        })
    elif caution_seconds > 0 or redline_seconds > 0:
        warnings.append({
            "level": "WARNING",
            "title": f"CHT-{peak_cht_cylinder} PROJECTED IN CAUTION BAND",
            "detail": (
                f"Predicted peak {peak_cht:.0f} °C against a "
                f"{ENGINE['cht_caution_c']:.0f} °C caution threshold for "
                f"{caution_seconds // 60} minutes."
            ),
        })
    if peak_asymmetry > 12.0:
        warnings.append({
            "level": "WARNING",
            "title": "PER-CYLINDER ASYMMETRY GROWS ON THIS PROFILE",
            "detail": (
                f"Predicted peak spread {peak_asymmetry:.0f} °C between cylinders. "
                "The existing divergence is amplified by this operating condition."
            ),
        })
    if min_oil_press <= ENGINE["oil_press_caution_psi"]:
        warnings.append({
            "level": "WARNING",
            "title": "OIL PRESSURE PROJECTED LOW",
            "detail": f"Predicted minimum {min_oil_press:.0f} psi.",
        })

    hours = duration / 3600.0
    risk = mission_risk(p_serviceable, health_index, hours)
    # The serviceability prior does not know about this specific profile's
    # thermal outcome. A projected limit exceedance overrides it.
    if redline_seconds >= 60:
        risk["band"] = "HIGH"
        risk["recommendation"] = (
            "Do not despatch on this profile. The projection exceeds an "
            "absolute engine limit."
        )
        risk["escalated_by"] = "PROJECTED CHT REDLINE EXCEEDANCE"
    elif caution_seconds > 900 and risk["band"] in ("LOW", "MODERATE"):
        risk["band"] = "ELEVATED"
        risk["recommendation"] = (
            "Reduce loiter power or shorten the sortie. The projection holds "
            "the affected cylinder in the caution band for an extended period."
        )
        risk["escalated_by"] = "SUSTAINED CHT CAUTION BAND"

    summary = {
        "duration_s": round(duration),
        "duration_hms": _hms(duration),
        "peak_cht_c": round(peak_cht, 1),
        "peak_cht_cylinder": peak_cht_cylinder,
        "cht_redline_c": ENGINE["cht_redline_c"],
        "cht_margin_c": round(ENGINE["cht_redline_c"] - peak_cht, 1),
        "peak_asymmetry_c": round(peak_asymmetry, 1),
        "peak_oil_temp_c": round(peak_oil_temp, 1),
        "min_oil_press_psi": round(min_oil_press, 1),
        "fuel_burn_gal": round(fuel_burned_gal, 1),
        "caution_minutes": caution_seconds // 60,
        "caution_seconds": caution_seconds,
        "redline_minutes": redline_seconds // 60,
        "redline_seconds": redline_seconds,
        "mission_risk": risk,
        "samples": len(series),
        "stride_s": stride_s,
    }
    return SimulationResult(
        run_id=run_id,
        profile=profile.descriptor(),
        series=series,
        summary=summary,
        warnings=warnings,
    )


def _median_asymmetry(residuals: list[float]) -> float:
    ordered = sorted(residuals)
    median = 0.5 * (ordered[1] + ordered[2])
    return max(abs(v - median) for v in residuals)


def _hms(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"

