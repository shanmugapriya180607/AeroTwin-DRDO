"""
Isolation Forest over residual features.

The baseline detector in ``analytics/anomaly.py`` is a transparent linear model
whose weights a propulsion engineer can read and argue with. That gets built
first, on purpose - a learned model that cannot beat an interpretable baseline
is a finding, not a failure.

This module is the learned half. An Isolation Forest is fitted online to the
residual-feature distribution of THIS engine while its baseline is healthy, and
thereafter scores every cylinder against that learned normality. It is
unsupervised by necessity: labelled per-cylinder faults do not exist in the
corpus at 1 Hz resolution, so a supervised per-cylinder classifier would have
to invent its labels. It does not.

Three properties matter for how the output is used downstream:

  1. It trains on healthy residuals only. The gate is the engine's own health,
     not the clock, so a corpus that opens mid-degradation does not poison the
     reference distribution.
  2. It abstains. Before ``MIN_TRAIN_SAMPLES`` it reports UNTRAINED and
     contributes nothing to the fused score, rather than emitting noise.
  3. It attributes. Isolation Forests have no native feature attribution, so
     each feature is occluded to its training median in turn and the change in
     the isolation score is reported. That is a measured contribution, not a
     coefficient read off a linear model.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .feature_engineering import (FEATURE_LABELS, FEATURE_NAMES, FEATURE_UNITS,
                                  to_vector)

MODEL_NAME = "ISOLATION FOREST"
MODEL_VERSION = "1.0.0"
MIN_TRAIN_SAMPLES = 240        # ~4 minutes of steady 1 Hz data per cylinder
MAX_TRAIN_SAMPLES = 6000
N_ESTIMATORS = 200
RANDOM_STATE = 20260054
TRAIN_STRIDE = 3               # decorrelate consecutive 1 Hz samples

try:                                                   # optional dependency
    import numpy as _np
    from sklearn.ensemble import IsolationForest as _SkIsolationForest
    SKLEARN_AVAILABLE = True
except Exception:                                      # pragma: no cover
    _np = None
    _SkIsolationForest = None
    SKLEARN_AVAILABLE = False


@dataclass
class ModelScore:
    """One cylinder's verdict from the learned model."""

    available: bool
    trained: bool
    score: float                    # 0..1, higher = more anomalous
    raw: float                      # sklearn score_samples output
    verdict: str                    # NORMAL | ANOMALY | UNTRAINED
    reason: str
    contributions: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "available": self.available,
            "trained": self.trained,
            "score": round(self.score, 4),
            "raw": round(self.raw, 5),
            "verdict": self.verdict,
            "reason": self.reason,
            "contributions": self.contributions,
        }


UNAVAILABLE = ModelScore(
    available=False, trained=False, score=0.0, raw=0.0,
    verdict="UNTRAINED",
    reason=(
        "scikit-learn is not installed in this environment. The transparent "
        "baseline detector carries the diagnosis on its own; the learned model "
        "contributes nothing rather than guessing."
    ),
)


class IsolationForestDetector:
    """One forest for the whole engine, scored per cylinder.

    Pooling the four cylinders is deliberate. Each cylinder contributes its own
    residual-feature vector, so the learned normality is "what a healthy
    cylinder on this engine looks like" - and a single cylinder drifting away
    from its three siblings is exactly the shape the forest isolates.
    """

    def __init__(self) -> None:
        self._buffer: list = []
        self._forest = None
        self._medians: list = []
        self._score_ref: tuple = (0.0, 1.0)     # (median, spread) of training scores
        self.trained = False
        self.train_samples = 0
        self.fitted_at_flight: str | None = None
        self.refits = 0
        self._skipped = 0
        self._contamination_note = ""
        self._error: str | None = None

    # -- training ----------------------------------------------------------

    def observe(self, feature_rows: list, healthy: bool, steady: bool) -> None:
        """Offer one tick's four cylinder vectors as training evidence.

        Rejected unless the engine is BOTH healthy and in a steady operating
        state. Residuals during a throttle transient reflect model lag, not
        engine condition, and training on them widens the learned normality
        until nothing is ever anomalous again.
        """
        if self.trained or not SKLEARN_AVAILABLE:
            return
        if not (healthy and steady):
            self._skipped += 1
            return
        self._skipped += 1
        if self._skipped % TRAIN_STRIDE:
            return
        for features in feature_rows:
            if len(self._buffer) < MAX_TRAIN_SAMPLES:
                self._buffer.append(to_vector(features))
        if len(self._buffer) >= MIN_TRAIN_SAMPLES:
            self.fit()

    def fit(self, flight_id: str | None = None) -> bool:
        if not SKLEARN_AVAILABLE or len(self._buffer) < MIN_TRAIN_SAMPLES:
            return False
        if self._error:
            return False
        try:
            return self._fit(flight_id)
        except Exception as exc:                      # pragma: no cover - env guard
            self._error = str(exc)
            self.trained = False
            self._forest = None
            return False

    def _fit(self, flight_id: str | None) -> bool:
        matrix = _np.asarray(self._buffer, dtype=float)
        forest = _SkIsolationForest(
            n_estimators=N_ESTIMATORS,
            max_samples="auto",
            contamination="auto",
            random_state=RANDOM_STATE,
            n_jobs=1,
        )
        forest.fit(matrix)

        scores = forest.score_samples(matrix)
        median = float(_np.median(scores))
        # Robust spread from the healthy tail: the 5th percentile is the
        # least-normal training point, so anything beyond it is genuinely
        # outside what this engine looked like when it was well.
        p05 = float(_np.percentile(scores, 5))
        spread = max(1e-4, median - p05)

        self._forest = forest
        self._medians = [float(v) for v in _np.median(matrix, axis=0)]
        self._score_ref = (median, spread)
        self.trained = True
        self.train_samples = int(matrix.shape[0])
        self.fitted_at_flight = flight_id
        self.refits += 1
        self._contamination_note = (
            f"Fitted on {self.train_samples} steady-state healthy residual "
            f"vectors pooled across four cylinders."
        )
        return True

    def reset(self) -> None:
        self._error = None
        self._buffer = []
        self._forest = None
        self.trained = False
        self.train_samples = 0
        self.refits = 0

    # -- scoring -----------------------------------------------------------

    def score(self, features: dict) -> ModelScore:
        """Score one cylinder. Convenience wrapper over :meth:`score_batch`."""
        return self.score_batch([features], attribute=0)[0]

    def score_batch(self, rows: list, attribute: int | None = None) -> list:
        """Score several cylinders in one forest evaluation.

        The forest is the expensive part of the analytics stack, and it is
        re-run for every cylinder on every refresh. Evaluating the four
        together turns four calls into one, and attribution - which costs one
        further call per feature - is computed only for the cylinder the
        caller actually intends to explain.
        """
        if not SKLEARN_AVAILABLE:
            return [UNAVAILABLE for _ in rows]
        if not self.trained:
            pending = ModelScore(
                available=True, trained=False, score=0.0, raw=0.0,
                verdict="UNTRAINED",
                reason=(
                    f"Learning this engine's healthy residual distribution: "
                    f"{len(self._buffer)} of {MIN_TRAIN_SAMPLES} steady-state "
                    f"samples collected. The model abstains until it has enough."
                ),
            )
            return [pending for _ in rows]

        vectors = [to_vector(features) for features in rows]
        try:
            raws = self._forest.score_samples(_np.asarray(vectors, dtype=float))
        except Exception as exc:                      # pragma: no cover - env guard
            # A broken numerical stack must degrade the diagnosis, never stop
            # the twin. The physics baseline carries it alone from here.
            self.trained = False
            self._forest = None
            self._error = str(exc)
            failed = ModelScore(
                available=True, trained=False, score=0.0, raw=0.0,
                verdict="UNTRAINED",
                reason=(
                    "The learned model failed at inference and has been taken "
                    f"out of the loop: {exc}. Diagnosis continues on the "
                    "transparent physics baseline."
                ),
            )
            return [failed for _ in rows]

        out = []
        for index, vector in enumerate(vectors):
            raw = float(raws[index])
            score = self._normalise(raw)
            out.append(ModelScore(
                available=True,
                trained=True,
                score=score,
                raw=raw,
                verdict="ANOMALY" if score >= 0.5 else "NORMAL",
                reason=(
                    "Isolation depth against the healthy residual distribution "
                    f"learned from {self.train_samples} samples of this engine."
                ),
                contributions=(
                    self._attribute(vector, raw) if attribute == index else []
                ),
            ))
        return out

    def _normalise(self, raw: float) -> float:
        """Map an isolation score to 0..1 against the healthy training spread.

        Zero at the median healthy point, 0.5 at the 5th-percentile healthy
        point, saturating beyond. The reference comes from measured training
        scores, so the number is anchored to this engine rather than to a
        constant somebody picked.
        """
        median, spread = self._score_ref
        deviation = (median - raw) / spread
        return max(0.0, min(1.0, 1.0 - math.exp(-0.693 * max(0.0, deviation))))

    def _attribute(self, vector: list, raw: float) -> list:
        """Occlusion attribution: replace each feature with its healthy median
        and measure how much of the anomaly disappears."""
        if self._forest is None:
            return []
        rows = []
        for i in range(len(vector)):
            probe = list(vector)
            probe[i] = self._medians[i]
            rows.append(probe)
        try:
            occluded = self._forest.score_samples(_np.asarray(rows, dtype=float))
        except Exception:                             # pragma: no cover - env guard
            return []

        base = self._normalise(raw)
        deltas = []
        for i, name in enumerate(FEATURE_NAMES):
            without = self._normalise(float(occluded[i]))
            deltas.append((name, max(0.0, base - without)))

        total = sum(d for _, d in deltas)
        if total <= 1e-9:
            return []
        deltas.sort(key=lambda kv: kv[1], reverse=True)
        return [
            {
                "feature": name,
                "label": FEATURE_LABELS[name],
                "unit": FEATURE_UNITS[name],
                "share": round(delta / total, 4),
                "delta": round(delta, 4),
            }
            for name, delta in deltas[:5] if delta > 1e-6
        ]

    # -- reporting ---------------------------------------------------------

    def status(self) -> dict:
        return {
            "name": MODEL_NAME,
            "version": MODEL_VERSION,
            "library": "scikit-learn" if SKLEARN_AVAILABLE else None,
            "available": SKLEARN_AVAILABLE,
            "trained": self.trained,
            "state": (
                "TRAINED" if self.trained
                else ("COLLECTING" if SKLEARN_AVAILABLE else "UNAVAILABLE")
            ),
            "train_samples": self.train_samples,
            "buffered": len(self._buffer),
            "required_samples": MIN_TRAIN_SAMPLES,
            "n_estimators": N_ESTIMATORS,
            "features": FEATURE_NAMES,
            "feature_count": len(FEATURE_NAMES),
            "input": "RESIDUAL FEATURES (observed - physics expected)",
            "supervision": "UNSUPERVISED",
            "refits": self.refits,
            "error": self._error,
            "note": self._contamination_note or (
                "Trains only on steady-state samples from a healthy baseline, "
                "so transient model lag is never learned as normal."
            ),
            "abstention": (
                "Reports UNTRAINED and contributes zero to the fused score "
                "until it has enough healthy evidence."
            ),
        }


anomaly_model = IsolationForestDetector()


def fuse(baseline_score: float, model: ModelScore, weight: float = 0.35) -> tuple:
    """Blend the transparent baseline with the learned model.

    The baseline keeps the majority weight, and an untrained or unavailable
    model contributes nothing at all. Returns (fused_score, provenance_label).
    """
    if not (model.available and model.trained):
        return baseline_score, "BASELINE ONLY"
    fused = (1.0 - weight) * baseline_score + weight * model.score
    return max(0.0, min(1.0, fused)), "BASELINE + ISOLATION FOREST"


def agreement(baseline_score: float, model: ModelScore) -> str:
    """Do the two detectors tell the same story? Disagreement is information."""
    if not (model.available and model.trained):
        return "MODEL ABSTAINED"
    base_flag = baseline_score >= 0.5
    model_flag = model.score >= 0.5
    if base_flag == model_flag:
        return "AGREE"
    return "DISAGREE - PHYSICS BASELINE LEADS" if base_flag else "DISAGREE - MODEL LEADS"
