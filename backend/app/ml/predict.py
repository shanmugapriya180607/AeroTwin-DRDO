"""
The single prediction entry point.

``predict_engine_state(data)`` takes one observation - the sensor channels plus
the operating inputs the engine actually saw - and returns the twin's verdict
on it. It is the function a deployment would call from a CAN callback, and it
is what the ``POST /api/predict`` route wraps.

It returns only what the models genuinely support:

    fault           names a LIKELY CONTRIBUTING MECHANISM, never a confirmed
                    physical failure, and is None when evidence is thin.
    confidence      comes from the calibrator, not from a constant.
    top_features    are measured contributions over residual features.

If the observation is missing what physics needs, the function abstains rather
than extrapolating.
"""

from __future__ import annotations

from ..core.constants import MODEL_ID, MODEL_VERSION
from .anomaly_model import anomaly_model
from .feature_engineering import FEATURE_LABELS, FEATURE_UNITS, cylinder_features

REQUIRED_INPUTS = ("altitude_ft", "oat_c", "ias_kt")
REQUIRED_CHANNELS = ("rpm", "cht_1", "cht_2", "cht_3", "cht_4")


def _abstain(reason: str, detail: str = "") -> dict:
    return {
        "health": None,
        "health_status": "INSUFFICIENT DATA",
        "anomaly": False,
        "anomaly_score": None,
        "fault": None,
        "confidence": None,
        "top_features": [],
        "model_version": MODEL_VERSION,
        "model_id": MODEL_ID,
        "abstained": True,
        "abstain_reason": reason,
        "detail": detail,
    }


def predict_engine_state(data: dict | None = None) -> dict:
    """Score one observation, or the live tick when ``data`` is omitted.

    ``data`` shape::

        {
          "channels": {"rpm": .., "cht_1": .., ... },
          "inputs":   {"throttle": .., "altitude_ft": .., "oat_c": .., "ias_kt": ..}
        }
    """
    from ..service import service                      # deferred: circular

    runtime = service.runtime

    if data:
        result = _predict_supplied(data, runtime)
        if result is not None:
            return result

    tick = runtime.current
    if tick is None:
        return _abstain(
            "No telemetry frame available",
            "The twin has not yet received a frame to score.",
        )

    residuals = tick.residuals
    trim = runtime.estimator.trim_divergence()
    egt_trim = runtime.estimator.egt_trim_divergence()

    # Rank cylinders by the learned + baseline view, then report the worst.
    worst_index, worst_score, worst_model = 1, 0.0, None
    for index in range(1, 5):
        features = cylinder_features(index, residuals, trim, egt_trim)
        model_score = anomaly_model.score(features)
        baseline = next(
            (a.score for a in runtime.anomalies if a.cylinder == index), 0.0
        )
        combined = max(baseline, model_score.score if model_score.trained else 0.0)
        if combined > worst_score:
            worst_index, worst_score, worst_model = index, combined, model_score

    top = next(
        (a for a in runtime.anomalies if a.cylinder == worst_index),
        runtime.anomalies[0] if runtime.anomalies else None,
    )

    features = cylinder_features(worst_index, residuals, trim, egt_trim)
    model_score = worst_model or anomaly_model.score(features)

    top_features = _merge_attribution(top, model_score, features)
    anomaly_flag = bool(top and not top.abstained and top.score >= 0.30)

    fault = None
    if top and not top.abstained and top.mechanism_label and top.score >= 0.30:
        fault = {
            "mechanism": top.mechanism,
            "label": top.mechanism_label,
            "qualifier": top.mechanism_qualifier,
            "cylinder": top.cylinder,
            "statement": (
                f"LIKELY CONTRIBUTING MECHANISM - {top.mechanism_label}. "
                "Not a confirmed physical failure; inspection is what confirms."
            ),
        }

    return {
        "health": round(runtime.health_index, 1),
        "health_status": runtime.engine_state_label,
        "anomaly": anomaly_flag,
        "anomaly_score": round(top.score, 4) if top else round(worst_score, 4),
        "fault": fault,
        "confidence": round(top.confidence, 4) if (top and not top.abstained) else None,
        "top_features": top_features,
        "model_version": MODEL_VERSION,
        "model_id": MODEL_ID,
        "abstained": bool(top.abstained) if top else False,
        "abstain_reason": top.abstain_reason if top else None,
        "detail": {
            "cylinder": worst_index,
            "affected_signal": f"cht_{worst_index}",
            "severity": top.severity if top else "NONE",
            "regime": tick.regime,
            "phase": tick.phase,
            "steady_state": tick.steady,
            "learned_model": model_score.as_dict(),
            "physics_backend": runtime.physics.info.backend,
            "twin_sync_pct": round(runtime.sync_pct, 2),
        },
    }


def _predict_supplied(data: dict, runtime) -> dict | None:
    """Score a caller-supplied frame through the physics model.

    Returns None to fall through to the live tick when the payload does not
    carry enough to run physics on.
    """
    channels = data.get("channels") or {}
    inputs = data.get("inputs") or {}
    if not channels:
        return None

    missing_inputs = [k for k in REQUIRED_INPUTS if k not in inputs]
    missing_channels = [k for k in REQUIRED_CHANNELS if k not in channels]
    if missing_inputs or missing_channels:
        return _abstain(
            "Observation does not satisfy the data contract",
            {
                "missing_inputs": missing_inputs,
                "missing_channels": missing_channels,
                "required_inputs": list(REQUIRED_INPUTS),
                "required_channels": list(REQUIRED_CHANNELS),
            },
        )

    from ..physics.piston import OperatingInputs

    operating = OperatingInputs(
        throttle=float(inputs.get("throttle", 0.75)),
        mixture=float(inputs.get("mixture", 0.62)),
        altitude_ft=float(inputs["altitude_ft"]),
        oat_c=float(inputs["oat_c"]),
        ias_kt=float(inputs["ias_kt"]),
    )
    prediction = runtime.physics.predict(operating, runtime.estimator.current)
    expected = prediction.channel_map()

    rows = []
    for key, observed in channels.items():
        if key not in expected:
            continue
        rows.append({
            "channel": key,
            "observed": round(float(observed), 2),
            "expected": round(expected[key], 2),
            "residual": round(float(observed) - expected[key], 2),
        })

    cht_res = [
        float(channels[f"cht_{i}"]) - expected[f"cht_{i}"]
        for i in range(1, 5)
        if f"cht_{i}" in channels and f"cht_{i}" in expected
    ]
    mean_res = sum(cht_res) / len(cht_res) if cht_res else 0.0
    asymmetry = [r - mean_res for r in cht_res]
    worst = max(range(len(asymmetry)), key=lambda i: abs(asymmetry[i])) if asymmetry else 0

    return {
        "health": None,
        "health_status": "SINGLE-FRAME EVALUATION",
        "anomaly": bool(asymmetry and abs(asymmetry[worst]) > 6.0),
        "anomaly_score": round(min(1.0, abs(asymmetry[worst]) / 12.0), 4) if asymmetry else 0.0,
        "fault": None,
        "confidence": None,
        "top_features": [
            {
                "feature": "cht_asymmetry_c",
                "label": FEATURE_LABELS["cht_asymmetry_c"],
                "unit": FEATURE_UNITS["cht_asymmetry_c"],
                "value": round(asymmetry[worst], 2) if asymmetry else 0.0,
                "share": 1.0,
                "source": "PHYSICS RESIDUAL",
            }
        ] if asymmetry else [],
        "model_version": MODEL_VERSION,
        "model_id": MODEL_ID,
        "abstained": True,
        "abstain_reason": (
            "A single frame carries no persistence and no regime diversity. "
            "The physics comparison is returned; a health index, a mechanism "
            "and a calibrated confidence are not, because one second of data "
            "cannot support them."
        ),
        "detail": {
            "cylinder": worst + 1 if asymmetry else None,
            "comparison": rows,
            "physics_backend": runtime.physics.info.backend,
            "note": (
                "Stream frames through /ws/telemetry or the replay source to "
                "accumulate the evidence a diagnosis requires."
            ),
        },
    }


def _merge_attribution(anomaly, model_score, features: dict) -> list:
    """Baseline contributions first, learned-model shares folded in beside them."""
    out = []
    seen = set()

    if anomaly is not None:
        for contribution in anomaly.contributions[:5]:
            out.append({
                "feature": contribution.feature,
                "label": contribution.label,
                "unit": contribution.unit,
                "value": round(contribution.value, 3),
                "share": round(contribution.contribution, 4),
                "source": "PHYSICS BASELINE",
            })
            seen.add(contribution.feature)

    if model_score.trained:
        for contribution in model_score.contributions:
            name = contribution["feature"]
            if name in seen:
                continue
            out.append({
                "feature": name,
                "label": contribution["label"],
                "unit": contribution["unit"],
                "value": round(features.get(name, 0.0), 3),
                "share": contribution["share"],
                "source": "ISOLATION FOREST",
            })

    return out[:6]
