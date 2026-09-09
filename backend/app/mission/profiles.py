"""
Mission profiles and the flight-condition generator.

A mission profile is a piecewise definition of the *control and ambient
inputs* over time - altitude, indicated airspeed, throttle, mixture and ISA
temperature deviation. These are the inputs shared by the real engine and the
physics model, so the profile drives both halves of the twin identically.

The four operating conditions named in the problem statement are implemented
as first-class profiles: high altitude, endurance, hot weather and throttle
transients.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..core import atmosphere as atm
from ..physics.piston import OperatingInputs

PHASES = ["GROUND", "TAKEOFF", "CLIMB", "TRANSIT", "ISR LOITER", "RTB", "DESCENT", "APPROACH"]


@dataclass(slots=True)
class Segment:
    phase: str
    duration_s: float
    alt_start_ft: float
    alt_end_ft: float
    ias_kt: float
    throttle: float
    mixture: float


@dataclass(slots=True)
class MissionProfile:
    id: str
    name: str
    summary: str
    isa_deviation_c: float
    segments: list[Segment]
    throttle_modulation: float = 0.0   # amplitude of throttle transients, 0..1
    modulation_period_s: float = 240.0
    tags: list[str] = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        return sum(s.duration_s for s in self.segments)

    def cruise_altitude_ft(self) -> float:
        return max(s.alt_end_ft for s in self.segments)

    def descriptor(self) -> dict:
        cruise = max(self.segments, key=lambda s: s.duration_s)
        return {
            "id": self.id,
            "name": self.name,
            "summary": self.summary,
            "duration_s": self.duration_s,
            "cruise_altitude_ft": self.cruise_altitude_ft(),
            "oat_c": round(atm.isa_temperature_c(self.cruise_altitude_ft()) + self.isa_deviation_c, 1),
            "isa_deviation_c": self.isa_deviation_c,
            "ias_kt": cruise.ias_kt,
            "throttle_pct": round(cruise.throttle * 100),
            "throttle_transients": self.throttle_modulation > 0.01,
            "tags": self.tags,
        }


@dataclass(slots=True)
class FlightCondition:
    t: float
    phase: str
    inputs: OperatingInputs
    progress: float


def _lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


def _smooth(u: float) -> float:
    """Smoothstep - avoids unphysical step changes at segment boundaries."""
    u = max(0.0, min(1.0, u))
    return u * u * (3.0 - 2.0 * u)


def sample_profile(profile: MissionProfile, t: float) -> FlightCondition:
    """Flight condition at mission-elapsed time ``t`` seconds."""
    total = profile.duration_s
    t = max(0.0, min(total, t))
    acc = 0.0
    seg = profile.segments[-1]
    local = seg.duration_s
    for s in profile.segments:
        if t <= acc + s.duration_s:
            seg = s
            local = t - acc
            break
        acc += s.duration_s

    u = _smooth(local / max(1.0, seg.duration_s))
    altitude = _lerp(seg.alt_start_ft, seg.alt_end_ft, u)

    throttle = seg.throttle
    if profile.throttle_modulation > 0.01 and seg.phase in ("ISR LOITER", "TRANSIT", "CLIMB"):
        w = 2.0 * math.pi * t / max(30.0, profile.modulation_period_s)
        # Asymmetric transient: fast advance, slower retard - matches a real
        # throttle schedule far better than a sine.
        shape = math.sin(w) + 0.4 * math.sin(2.0 * w)
        throttle = max(0.28, min(1.0, seg.throttle + profile.throttle_modulation * shape))

    ias = seg.ias_kt * (0.85 + 0.15 * (throttle / max(0.1, seg.throttle)))

    oat = atm.isa_temperature_c(altitude) + profile.isa_deviation_c
    # Diurnal / boundary-layer wobble so the ambient channel is not a constant.
    oat += 0.6 * math.sin(t / 900.0)

    return FlightCondition(
        t=t,
        phase=seg.phase,
        progress=t / max(1.0, total),
        inputs=OperatingInputs(
            throttle=throttle,
            mixture=seg.mixture,
            altitude_ft=altitude,
            oat_c=oat,
            ias_kt=ias,
        ),
    )


# ---------------------------------------------------------------------------
# Profile library
# ---------------------------------------------------------------------------

def _isr_segments(cruise_ft: float, loiter_ft: float, loiter_s: float,
                  ias: float, loiter_throttle: float,
                  climb_throttle: float = 0.97, climb_ias: float = 95.0) -> list[Segment]:
    """Standard sortie shape.

    Climb is flown as a cruise-climb rather than at best-rate: the extra
    airspeed is cooling mass flow through the cylinder fins, which is how an
    air-cooled engine is actually protected on a warm-day departure.
    """
    return [
        Segment("GROUND", 120, 320, 320, 0, 0.22, 1.00),
        Segment("TAKEOFF", 90, 320, 900, 68, 1.00, 1.00),
        Segment("CLIMB", 1500, 900, cruise_ft, climb_ias, climb_throttle, 0.86),
        Segment("TRANSIT", 1800, cruise_ft, loiter_ft, ias, 0.95, 0.34),
        Segment("ISR LOITER", loiter_s, loiter_ft, loiter_ft, ias - 10, loiter_throttle, 0.31),
        Segment("RTB", 2100, loiter_ft, cruise_ft, ias + 6, 0.93, 0.36),
        Segment("DESCENT", 1500, cruise_ft, 2500, ias + 14, 0.38, 0.58),
        Segment("APPROACH", 420, 2500, 320, 72, 0.30, 0.92),
    ]


PROFILES: dict[str, MissionProfile] = {
    "ISR_STANDARD": MissionProfile(
        id="ISR_STANDARD",
        name="STANDARD ISR SORTIE",
        summary="Reference intelligence, surveillance and reconnaissance sortie over Training Sector Alpha.",
        isa_deviation_c=1.0,
        segments=_isr_segments(12480, 14000, 15870, 96, 0.86),
        tags=["REFERENCE", "BASELINE"],
    ),
    "HIGH_ALTITUDE": MissionProfile(
        id="HIGH_ALTITUDE",
        name="HIGH ALTITUDE",
        summary="Service-ceiling operation. Reduced air density lowers both power available and cooling mass flow.",
        isa_deviation_c=-2.0,
        segments=_isr_segments(16000, 18000, 12600, 92, 0.98),
        tags=["DENSITY ALTITUDE", "POWER LIMITED"],
    ),
    "ENDURANCE": MissionProfile(
        id="ENDURANCE",
        name="ENDURANCE",
        summary="Maximum-endurance loiter at best economy mixture. Long thermal soak at steady state.",
        isa_deviation_c=0.0,
        segments=[
            Segment("GROUND", 120, 320, 320, 0, 0.22, 1.00),
            Segment("TAKEOFF", 90, 320, 900, 68, 1.00, 1.00),
            Segment("CLIMB", 1620, 900, 11000, 86, 0.97, 0.86),
            Segment("TRANSIT", 1500, 11000, 12000, 88, 0.90, 0.30),
            Segment("ISR LOITER", 32400, 12000, 12000, 74, 0.70, 0.26),
            Segment("RTB", 2400, 12000, 11000, 92, 0.88, 0.32),
            Segment("DESCENT", 1500, 11000, 2500, 104, 0.38, 0.58),
            Segment("APPROACH", 420, 2500, 320, 72, 0.30, 0.92),
        ],
        tags=["LONG SOAK", "LEAN OF PEAK"],
    ),
    "HOT_WEATHER": MissionProfile(
        id="HOT_WEATHER",
        name="HOT WEATHER",
        summary="High ambient temperature operation. Cooling margin is the limiting factor, not power.",
        isa_deviation_c=22.0,
        # Hot-day departure: power reduced and airspeed raised to protect the
        # cylinder heads. Even so, this profile is where a degraded cylinder
        # runs out of thermal margin first.
        segments=_isr_segments(11500, 12500, 14400, 98, 0.78,
                               climb_throttle=0.90, climb_ias=104.0),
        tags=["THERMAL LIMITED", "ISA +22"],
    ),
    "THROTTLE_TRANSIENT": MissionProfile(
        id="THROTTLE_TRANSIENT",
        name="THROTTLE TRANSIENT",
        summary="Repeated power changes. Tests whether the residual holds through non-steady operation.",
        isa_deviation_c=3.0,
        segments=_isr_segments(11000, 12500, 12600, 94, 0.80),
        throttle_modulation=0.20,
        modulation_period_s=210.0,
        tags=["NON-STEADY", "REGIME COVERAGE"],
    ),
}

DEFAULT_PROFILE = "ISR_STANDARD"


def get_profile(profile_id: str | None) -> MissionProfile:
    return PROFILES.get((profile_id or DEFAULT_PROFILE).upper(), PROFILES[DEFAULT_PROFILE])


def build_custom_profile(
    altitude_ft: float,
    oat_c: float,
    ias_kt: float,
    throttle_pct: float,
    duration_s: float,
    transients: bool = False,
) -> MissionProfile:
    """User-defined profile from the mission simulator's CUSTOM panel."""
    altitude_ft = max(500.0, min(25000.0, altitude_ft))
    isa_dev = oat_c - atm.isa_temperature_c(altitude_ft)
    loiter = max(600.0, duration_s - 3630.0)
    throttle = max(0.25, min(1.0, throttle_pct / 100.0))
    return MissionProfile(
        id="CUSTOM",
        name="CUSTOM PROFILE",
        summary="Operator-defined mission profile.",
        isa_deviation_c=round(isa_dev, 1),
        segments=[
            Segment("TAKEOFF", 90, 320, 900, 68, 1.00, 1.00),
            Segment("CLIMB", 1440, 900, altitude_ft, 88, 0.98, 0.86),
            Segment("ISR LOITER", loiter, altitude_ft, altitude_ft, ias_kt, throttle, 0.32),
            Segment("DESCENT", 1680, altitude_ft, 2500, ias_kt + 12, 0.38, 0.58),
            Segment("APPROACH", 420, 2500, 320, 72, 0.30, 0.92),
        ],
        throttle_modulation=0.18 if transients else 0.0,
        tags=["OPERATOR DEFINED"],
    )
