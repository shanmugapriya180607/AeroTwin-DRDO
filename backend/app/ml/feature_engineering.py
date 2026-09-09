"""
Feature engineering.

Every feature in this module is derived from a RESIDUAL - the difference
between what the engine did and what physics says it should have done given
the same throttle, altitude, ambient temperature and airspeed. None is a raw
sensor value.

That distinction is the project. A model fed raw CHT learns "hot engines are
sick", which is wrong: a hot engine on a hot day at low airspeed is behaving
exactly as an air-cooled engine should. A model fed the residual learns "this
cylinder is not doing what physics says it should", which is the fault.

Feature groups
    asymmetry   - this cylinder's residual against the four-cylinder mean.
                  The single most diagnostic quantity in piston-engine
                  condition monitoring: a failing cylinder shows up as
                  asymmetry, not as a change in the average.
    drift       - slow EWMA of the residual, so a one-second spike does not
                  read as degradation.
    persistence - one-sided CUSUM: how long the deviation has held.
    trim        - the state estimator's divergence from the healthy baseline.
    dispersion  - spread across the four cylinders, an engine-level view.
"""

from __future__ import annotations

import math

FEATURE_NAMES: list[str] = [
    "cht_asymmetry_c",
    "egt_asymmetry_c",
    "cht_drift_c",
    "cht_normalised_z",
    "cht_persistence",
    "trim_divergence",
    "egt_trim_divergence",
    "cht_egt_agreement",
    "cht_dispersion_c",
]

FEATURE_LABELS: dict[str, str] = {
    "cht_asymmetry_c": "CHT ASYMMETRY vs 4-CYL MEAN",
    "egt_asymmetry_c": "EGT ASYMMETRY vs 4-CYL MEAN",
    "cht_drift_c": "CHT RESIDUAL DRIFT (EWMA)",
    "cht_normalised_z": "CHT RESIDUAL z-SCORE",
    "cht_persistence": "PERSISTENCE (CUSUM)",
    "trim_divergence": "COOLING TRIM DIVERGENCE",
    "egt_trim_divergence": "COMBUSTION TRIM DIVERGENCE",
    "cht_egt_agreement": "CHT / EGT AGREEMENT",
    "cht_dispersion_c": "FOUR-CYLINDER DISPERSION",
}

FEATURE_UNITS: dict[str, str] = {
    "cht_asymmetry_c": "°C",
    "egt_asymmetry_c": "°C",
    "cht_drift_c": "°C",
    "cht_normalised_z": "σ",
    "cht_persistence": "σ·s",
    "trim_divergence": "frac",
    "egt_trim_divergence": "frac",
    "cht_egt_agreement": "-",
    "cht_dispersion_c": "°C",
}

# Scale each feature to roughly unit magnitude at "clearly abnormal", so the
# Isolation Forest is not dominated by whichever channel has the largest units.
FEATURE_SCALE: dict[str, float] = {
    "cht_asymmetry_c": 6.0,
    "egt_asymmetry_c": 15.0,
    "cht_drift_c": 8.0,
    "cht_normalised_z": 3.0,
    "cht_persistence": 80.0,
    "trim_divergence": 0.020,
    "egt_trim_divergence": 0.020,
    "cht_egt_agreement": 1.0,
    "cht_dispersion_c": 8.0,
}


def _mean(values: list) -> float:
    return sum(values) / len(values) if values else 0.0


def _std(values: list) -> float:
    if len(values) < 2:
        return 0.0
    m = _mean(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / (len(values) - 1))


def cylinder_features(
    index: int,
    residuals: dict,
    trim_divergence: list,
    egt_trim_divergence: list,
) -> dict:
    """Feature vector for one cylinder, keyed by FEATURE_NAMES.

    ``residuals`` maps channel key -> ChannelResidual (see twin/residual.py).
    """
    cht_drifts = [residuals[f"cht_{i}"].ewma for i in range(1, 5) if f"cht_{i}" in residuals]
    egt_drifts = [residuals[f"egt_{i}"].ewma for i in range(1, 5) if f"egt_{i}" in residuals]
    cht_mean = _mean(cht_drifts)
    egt_mean = _mean(egt_drifts)

    cht = residuals.get(f"cht_{index}")
    egt = residuals.get(f"egt_{index}")
    if cht is None:
        return {name: 0.0 for name in FEATURE_NAMES}

    cht_asym = cht.ewma - cht_mean
    egt_asym = (egt.ewma - egt_mean) if egt else 0.0

    # Agreement: do the exhaust side and the head side tell the same story?
    # A cylinder hot on CHT *and* hot on EGT is a combustion event. Hot on CHT
    # while EGT sits flat points at the cooling path instead. Sign agreement is
    # therefore diagnostic in its own right.
    if abs(cht_asym) < 0.5 or abs(egt_asym) < 2.0:
        agreement = 0.0
    else:
        agreement = 1.0 if (cht_asym > 0) == (egt_asym > 0) else -1.0

    trim = trim_divergence[index - 1] if index <= len(trim_divergence) else 0.0
    egt_trim = egt_trim_divergence[index - 1] if index <= len(egt_trim_divergence) else 0.0

    return {
        "cht_asymmetry_c": cht_asym,
        "egt_asymmetry_c": egt_asym,
        "cht_drift_c": cht.ewma,
        "cht_normalised_z": cht.normalised,
        "cht_persistence": cht.cusum,
        "trim_divergence": trim,
        "egt_trim_divergence": egt_trim,
        "cht_egt_agreement": agreement,
        "cht_dispersion_c": _std(cht_drifts),
    }


def global_features(residuals: dict) -> dict:
    """Engine-level residual features, for the non-cylinder subsystems."""
    out = {}
    for key in ("rpm", "map_inhg", "fuel_flow_gph", "oil_press_psi", "oil_temp_c"):
        res = residuals.get(key)
        out[key] = {
            "residual": res.residual if res else 0.0,
            "drift": res.ewma if res else 0.0,
            "z": res.normalised if res else 0.0,
            "persistence": res.cusum if res else 0.0,
        }
    return out


def feature_frame(
    residuals: dict,
    trim_divergence: list,
    egt_trim_divergence: list,
) -> list:
    """All four cylinder vectors, in cylinder order."""
    return [
        cylinder_features(i, residuals, trim_divergence, egt_trim_divergence)
        for i in range(1, 5)
    ]


def to_vector(features: dict) -> list:
    """Scaled, capped vector in FEATURE_NAMES order - the model's input."""
    vector = []
    for name in FEATURE_NAMES:
        scaled = features.get(name, 0.0) / FEATURE_SCALE[name]
        vector.append(max(-8.0, min(8.0, scaled)))
    return vector


def describe() -> list:
    """Model card fragment: what the model actually looks at."""
    return [
        {
            "name": name,
            "label": FEATURE_LABELS[name],
            "unit": FEATURE_UNITS[name],
            "scale": FEATURE_SCALE[name],
            "derived_from": "RESIDUAL (observed - physics expected)",
        }
        for name in FEATURE_NAMES
    ]
