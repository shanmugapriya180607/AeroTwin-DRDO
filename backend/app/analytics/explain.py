"""
Explainability.

The operator must be able to answer "why did this alert fire?" without reading
the code. Explanations are assembled from the same residual features the score
was computed from - there is no second, decorative explanation model.

Attribution method:
  * SHAP over the LightGBM model when a trained model and the shap package are
    both present.
  * Otherwise exact additive decomposition of the transparent baseline scoring
    model. For a generalised linear scorer the per-feature contribution is not
    an approximation - it is the term itself.

The active method is always reported so the reader knows which they are seeing.
"""

from __future__ import annotations

from .anomaly import Anomaly


def attribution_method() -> dict:
    try:
        import shap  # type: ignore  # noqa: F401

        shap_available = True
    except Exception:
        shap_available = False
    try:
        import lightgbm  # type: ignore  # noqa: F401

        lgbm_available = True
    except Exception:
        lgbm_available = False

    if shap_available and lgbm_available:
        return {
            "method": "SHAP (TreeExplainer)",
            "active": False,
            "detail": (
                "shap and lightgbm are installed. SHAP attribution activates "
                "once a model trained on NGAFID-MC labelled events is present "
                "in models/. Until then the transparent baseline scorer is "
                "used so that no attribution is reported without a model "
                "behind it."
            ),
        }
    return {
        "method": "Exact additive decomposition (baseline scorer)",
        "active": True,
        "detail": (
            "The baseline scorer is a generalised linear model over residual "
            "features, so each feature's contribution is the exact term in the "
            "score rather than an approximation. Install lightgbm and shap and "
            "train on NGAFID-MC to switch to SHAP attribution."
        ),
    }


def build_explanation(anomaly: Anomaly) -> dict:
    """The full 'why was this alert generated' payload."""
    contributions = anomaly.contributions
    total = sum(abs(c.contribution) for c in contributions) or 1.0
    ranked = [
        {
            **c.as_dict(),
            "share": round(abs(c.contribution) / total, 4),
        }
        for c in contributions
    ]

    primary = contributions[0] if contributions else None
    supporting = contributions[1] if len(contributions) > 1 else None

    if anomaly.abstained:
        verdict = {
            "qualifier": "ABSTAIN",
            "statement": "MODEL ABSTENTION - INSUFFICIENT EVIDENCE",
            "detail": anomaly.abstain_reason
            or "The system will not issue a fault classification on this evidence.",
        }
    else:
        verdict = {
            "qualifier": anomaly.mechanism_qualifier,
            "statement": anomaly.mechanism_label or "Unclassified deviation",
            "detail": _mechanism_detail(anomaly),
        }

    return {
        "anomaly_id": anomaly.id,
        "title": anomaly.title,
        "primary_signal": primary.label if primary else "-",
        "primary_value": round(primary.value, 2) if primary else 0.0,
        "primary_unit": primary.unit if primary else "",
        "supporting_signal": supporting.label if supporting else "-",
        "supporting_value": round(supporting.value, 2) if supporting else 0.0,
        "supporting_unit": supporting.unit if supporting else "",
        "residual": round(anomaly.residual, 2),
        "residual_unit": anomaly.residual_unit,
        "trend": anomaly.trend,
        "operating_regimes": anomaly.regimes,
        "regime_count": len(anomaly.regimes),
        "flights": anomaly.flights,
        "samples": anomaly.samples,
        "score": round(anomaly.score, 4),
        "confidence": round(anomaly.confidence, 4),
        "confidence_pct": round(anomaly.confidence * 100.0, 1),
        "verdict": verdict,
        "contributions": ranked,
        "attribution": attribution_method(),
        "reasoning_chain": _reasoning_chain(anomaly),
        "confidence_breakdown": _confidence_breakdown(anomaly),
    }


def _mechanism_detail(anomaly: Anomaly) -> str:
    from ..core.constants import FAILURE_MODES

    if not anomaly.mechanism:
        return "No named mechanism matches this residual signature."
    mode = FAILURE_MODES[anomaly.mechanism]
    return f"{mode['signature']}. {mode['consequence']}."


def _reasoning_chain(anomaly: Anomaly) -> list[dict]:
    sup = anomaly.supporting
    chain: list[dict] = []
    if anomaly.cylinder:
        chain.append({
            "step": "PHYSICS EXPECTATION",
            "detail": (
                f"For the current throttle, altitude, outside air temperature "
                f"and airspeed, the model expects CHT-{anomaly.cylinder} at "
                f"{sup.get('cht_expected', 0):.0f} °C."
            ),
        })
        chain.append({
            "step": "OBSERVATION",
            "detail": f"The sensor reports {sup.get('cht_observed', 0):.0f} °C.",
        })
        chain.append({
            "step": "RESIDUAL",
            "detail": (
                f"Residual {sup.get('cht_residual', 0):+.0f} °C. Slow-moving "
                f"component {sup.get('cht_drift', 0):+.1f} °C."
            ),
        })
        chain.append({
            "step": "ASYMMETRY",
            "detail": (
                "The other three cylinders remain on expectation. A failing "
                "cylinder shows as asymmetry between the four channels, not as "
                "a shift in the average - the mean CHT is still normal."
            ),
        })
        if sup.get("egt_drift") is not None:
            chain.append({
                "step": "INDEPENDENT CONFIRMATION",
                "detail": (
                    f"EGT-{anomaly.cylinder} drift {sup.get('egt_drift', 0):+.0f} °C moves "
                    "in the same direction. Two independent channels on the same "
                    "cylinder agreeing is a physical story, not an instrumentation fault."
                ),
            })
        chain.append({
            "step": "STATE ESTIMATOR",
            "detail": (
                f"Online trim estimate for this cylinder has diverged "
                f"{sup.get('trim_divergence_pct', 0):+.1f}% from its locked healthy baseline."
            ),
        })
    else:
        chain.append({
            "step": "PHYSICS EXPECTATION",
            "detail": f"Model expects {sup.get('expected', 0):.1f} {anomaly.residual_unit}.",
        })
        chain.append({
            "step": "OBSERVATION",
            "detail": f"Sensor reports {sup.get('observed', 0):.1f} {anomaly.residual_unit}.",
        })
        chain.append({
            "step": "RESIDUAL",
            "detail": f"Drift {sup.get('drift', 0):+.2f} {anomaly.residual_unit}.",
        })

    chain.append({
        "step": "PERSISTENCE",
        "detail": (
            f"Present in {len(anomaly.regimes)} operating regime"
            f"{'s' if len(anomaly.regimes) != 1 else ''} over {anomaly.flights} flight"
            f"{'s' if anomaly.flights != 1 else ''} "
            f"({anomaly.samples:,} steady-state samples). A model bias would not "
            "track a single cylinder across changing power and altitude."
        ),
    })
    return chain


def _confidence_breakdown(anomaly: Anomaly) -> list[dict]:
    from .anomaly import (C_AGREEMENT, C_FLIGHT, C_PERSISTENCE, C_REGIME,
                          C_SCORE)

    sup = anomaly.supporting
    regime_term = min(len(anomaly.regimes), 4) / 4.0
    flight_term = min(anomaly.flights, 8) / 8.0
    agreement = float(sup.get("agreement", 0.0))
    persistence = float(sup.get("persistence", 0.0))
    return [
        {"factor": "ANOMALY SCORE", "value": round(anomaly.score, 3),
         "weight": C_SCORE, "contribution": round(C_SCORE * anomaly.score, 3),
         "detail": "Magnitude of the divergence from physics."},
        {"factor": "REGIME BREADTH", "value": len(anomaly.regimes),
         "weight": C_REGIME, "contribution": round(C_REGIME * regime_term, 3),
         "detail": "Distinct power/altitude regimes the deviation survives."},
        {"factor": "FLIGHT COUNT", "value": anomaly.flights,
         "weight": C_FLIGHT, "contribution": round(C_FLIGHT * flight_term, 3),
         "detail": "Independent sorties the deviation reappears in."},
        {"factor": "CHANNEL AGREEMENT", "value": round(agreement, 2),
         "weight": C_AGREEMENT, "contribution": round(C_AGREEMENT * agreement, 3),
         "detail": "Whether CHT, EGT and the trim estimate tell the same story."},
        {"factor": "PERSISTENCE", "value": round(persistence, 2),
         "weight": C_PERSISTENCE, "contribution": round(C_PERSISTENCE * persistence, 3),
         "detail": "Fraction of steady samples in which the deviation is active."},
    ]
