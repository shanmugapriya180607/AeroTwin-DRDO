"""
Prior-flight history generation.

The maintenance story in this product is a *cross-flight* one: "cylinder 3 CHT
residual has drifted over the last 6 flights". That evidence cannot be faked at
render time - it has to come from the twin actually processing those flights.

At startup the runtime replays six prior sorties of the same airframe through
the full lockstep loop with a progressively worsening hidden degradation. The
estimator locks its healthy baseline on flight 1 and carries it forward, the
detector accumulates regime and flight evidence, and each flight's closing
health index is recorded.

Flights are processed at a coarser stride than 1 Hz purely for startup latency;
the live flight runs at full rate. The stride is reported in the API so the
figure is never mistaken for a full-resolution result.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from ..sources.synthetic import DegradationSpec, SyntheticFlightSource
from ..twin.runtime import FlightRecord, TwinRuntime

BASE_FLIGHT_NUMBER = 12839
HISTORY_STRIDE_S = 15          # sample every N seconds of mission time
EVALUATE_UNTIL_PHASE = "RTB"   # stop before descent: the estimate is observable in cruise


@dataclass(frozen=True)
class HistoryLeg:
    flight_number: int
    profile_id: str
    severity_start: float
    severity_end: float
    note: str


# Severity schedule for the demonstration engine. Flight 1 is healthy, which
# is what allows the estimator to lock a trustworthy baseline.
DEMO_SCHEDULE: list[HistoryLeg] = [
    HistoryLeg(12839, "ISR_STANDARD", 0.00, 0.00, "Reference sortie. Healthy baseline locked."),
    HistoryLeg(12840, "THROTTLE_TRANSIENT", 0.00, 0.06, "First measurable CHT-3 asymmetry."),
    HistoryLeg(12841, "ENDURANCE", 0.06, 0.15, "Drift persists through a long thermal soak."),
    HistoryLeg(12842, "ISR_STANDARD", 0.15, 0.28, "Divergence now visible in cruise."),
    HistoryLeg(12843, "HIGH_ALTITUDE", 0.28, 0.45, "Present at reduced cooling mass flow."),
    HistoryLeg(12844, "HOT_WEATHER", 0.45, 0.62, "Confirmed across a third thermal regime."),
]


def _phase_cutoff(source: SyntheticFlightSource) -> float:
    elapsed = 0.0
    for segment in source.profile.segments:
        elapsed += segment.duration_s
        if segment.phase == EVALUATE_UNTIL_PHASE:
            return elapsed
    return source.profile.duration_s


def generate_history(
    runtime: TwinRuntime,
    schedule: list[HistoryLeg] | None = None,
    stride_s: int = HISTORY_STRIDE_S,
    on_progress=None,
) -> list[FlightRecord]:
    """Replay the prior sorties through the full twin loop."""
    legs = schedule or DEMO_SCHEDULE
    records: list[FlightRecord] = []
    started = time.perf_counter()

    for index, leg in enumerate(legs):
        flight_id = str(leg.flight_number)
        degradation = DegradationSpec(
            mechanism="exhaust_valve_distress",
            cylinder=3,
            severity_start=leg.severity_start,
            severity_end=leg.severity_end,
            onset_fraction=0.12,
            enabled=leg.severity_end > 0.0,
        )
        source = SyntheticFlightSource(
            profile=leg.profile_id,
            flight_id=flight_id,
            degradation=degradation,
            seed=26054 + index * 17,
        )
        cutoff = _phase_cutoff(source)
        t = 0.0
        while t <= cutoff:
            runtime.step(source.sample(t))
            t += stride_s
        runtime.refresh_analytics()
        record = runtime.close_flight(
            flight_id=flight_id,
            label=f"FLIGHT #{flight_id}",
            profile_id=leg.profile_id,
            duration_s=source.profile.duration_s,
            notes=leg.note,
        )
        records.append(record)
        if on_progress:
            on_progress(index + 1, len(legs), record)

    runtime.history_elapsed_s = time.perf_counter() - started  # type: ignore[attr-defined]
    runtime.history_stride_s = stride_s                        # type: ignore[attr-defined]
    return records
