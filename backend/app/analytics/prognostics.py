"""
Prognostics.

The published NGAFID-MC benchmark task is binary: P(RUL > 2 days). This module
reports that task and nothing more precise. It deliberately does NOT emit a
continuous "147 hours remaining" figure, because no validated estimator behind
this prototype supports one, and inventing a precise number is the fastest way
to lose an engineer's trust.

Every value produced here carries a provenance label. In demo mode the
serviceability model is a transparent logistic function of the health index,
its drift rate and the peak anomaly score - it is labelled DEMO / SIMULATED
and is not presented as a validated benchmark result.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

BENCHMARK_TASK = "P(RUL > 2 days)"

A_BIAS = 3.373
B_HEALTH = 0.55        # per 10 health points above 70
C_DRIFT = 0.09         # per health-point-per-10-flights of decline
D_ANOMALY = 0.55       # per unit peak anomaly score


@dataclass(slots=True)
class Prognosis:
    health_index: float
    drift_per_10_flights: float
    peak_anomaly_score: float
    p_serviceable_2d: float
    band: str
    provenance: str
    task: str
    note: str

    def as_dict(self) -> dict:
        return {
            "health_index": round(self.health_index, 1),
            "drift_per_10_flights": round(self.drift_per_10_flights, 2),
            "peak_anomaly_score": round(self.peak_anomaly_score, 3),
            "p_serviceable_2d": round(self.p_serviceable_2d, 4),
            "p_serviceable_2d_pct": round(self.p_serviceable_2d * 100.0, 1),
            "band": self.band,
            "provenance": self.provenance,
            "task": self.task,
            "note": self.note,
        }


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, x))))


def health_drift_rate(history: list[float]) -> float:
    """Least-squares slope of the health index, expressed per 10 flights.

    Positive means improving, negative means declining. Reported as a decline
    magnitude by the caller.
    """
    n = len(history)
    if n < 2:
        return 0.0
    xs = list(range(n))
    mean_x = sum(xs) / n
    mean_y = sum(history) / n
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom < 1e-9:
        return 0.0
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, history)) / denom
    return slope * 10.0


def serviceability(
    health_index: float,
    health_history: list[float],
    peak_anomaly_score: float,
    validated: bool = False,
) -> Prognosis:
    slope10 = health_drift_rate(health_history)
    decline = max(0.0, -slope10)

    logit = (
        A_BIAS
        + B_HEALTH * (health_index - 70.0) / 10.0
        - C_DRIFT * decline
        - D_ANOMALY * peak_anomaly_score
    )
    probability = _sigmoid(logit)

    if probability >= 0.90:
        band = "HIGH"
    elif probability >= 0.75:
        band = "MODERATE"
    elif probability >= 0.55:
        band = "REDUCED"
    else:
        band = "LOW"

    return Prognosis(
        health_index=health_index,
        drift_per_10_flights=slope10,
        peak_anomaly_score=peak_anomaly_score,
        p_serviceable_2d=probability,
        band=band,
        provenance="VALIDATED" if validated else "DEMO / SIMULATED",
        task=BENCHMARK_TASK,
        note=(
            "Held-out benchmark result on NGAFID-MC labelled maintenance events."
            if validated else
            "Illustrative serviceability estimate produced by the demo "
            "serviceability model. It is not a validated benchmark result and "
            "must not be read as one. The published benchmark task this "
            "prototype targets is P(RUL > 2 days) on NGAFID-MC held-out data."
        ),
    )


def mission_risk(
    p_serviceable: float, health_index: float, mission_hours: float
) -> dict:
    """Risk of a propulsion-driven mission abort over a planned sortie length.

    Exposure scales with sortie duration - the whole point of a MALE UAV is
    that it is airborne for a long time, far from a runway.
    """
    base = 1.0 - p_serviceable
    exposure = min(2.5, max(0.25, mission_hours / 6.5))
    risk = min(0.95, base * exposure * (1.0 + max(0.0, (85.0 - health_index)) / 100.0))
    if risk < 0.05:
        band, action = "LOW", "Mission may proceed as planned."
    elif risk < 0.15:
        band, action = "MODERATE", "Mission may proceed. Inspect at next scheduled access."
    elif risk < 0.30:
        band, action = "ELEVATED", "Inspect before next sortie. Consider shortening the loiter leg."
    else:
        band, action = "HIGH", "Do not despatch until the affected item is inspected."
    return {
        "risk": round(risk, 4),
        "risk_pct": round(risk * 100.0, 1),
        "band": band,
        "recommendation": action,
        "mission_hours": round(mission_hours, 2),
        "provenance": "DEMO / SIMULATED",
    }
