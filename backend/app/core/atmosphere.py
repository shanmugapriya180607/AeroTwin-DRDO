"""International Standard Atmosphere helpers.

Used by both halves of the twin: the physics model needs ambient density and
pressure to predict manifold pressure and cooling airflow, and the telemetry
source needs them to produce a physically consistent observed stream.
"""

from __future__ import annotations

import math

P0_INHG = 29.9213
T0_K = 288.15
LAPSE_C_PER_FT = 0.0019812  # 1.98 degC per 1000 ft


def isa_temperature_c(altitude_ft: float) -> float:
    """ISA static air temperature in degC at a pressure altitude."""
    return 15.0 - LAPSE_C_PER_FT * altitude_ft


def pressure_inhg(altitude_ft: float) -> float:
    """ISA static pressure in inHg."""
    ratio = max(0.0, 1.0 - 6.87535e-6 * altitude_ft)
    return P0_INHG * ratio ** 5.2559


def density_ratio(altitude_ft: float, oat_c: float) -> float:
    """sigma = rho / rho_sea_level, corrected for non-standard temperature."""
    p_ratio = pressure_inhg(altitude_ft) / P0_INHG
    t_ratio = T0_K / max(200.0, oat_c + 273.15)
    return max(0.05, p_ratio * t_ratio)


def tas_kt(ias_knots: float, altitude_ft: float, oat_c: float) -> float:
    """True airspeed from indicated airspeed (compressibility ignored)."""
    return ias_knots / math.sqrt(max(0.05, density_ratio(altitude_ft, oat_c)))


def isa_deviation_c(altitude_ft: float, oat_c: float) -> float:
    return oat_c - isa_temperature_c(altitude_ft)
