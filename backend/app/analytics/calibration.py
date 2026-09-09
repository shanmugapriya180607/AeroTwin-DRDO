"""
Confidence calibration.

Most projects emit a softmax and call it confidence. A calibrated probability
means something stronger: when the system says 80%, it is right 80% of the
time - and that claim is checked with a reliability diagram and an expected
calibration error, not asserted.

Platt scaling is fitted here on the validation harness output:

    p_calibrated = sigmoid(a * logit(p_raw) + b)

with L2 regularisation, because a small evidence set with no observed errors
is perfectly separable and an unregularised fit would run the parameters to
infinity and report 100% confidence on everything.

If the evidence is too thin to fit - too few issued classifications, or no
observed errors to learn from - the calibrator says so and stays at identity
rather than manufacturing a correction. The unfitted state is reported in the
UI; it is not hidden behind a plausible-looking number.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

MIN_SAMPLES = 6
MIN_ERRORS = 1
L2 = 0.35
ITERATIONS = 400
LEARNING_RATE = 0.12
PARAM_CAP = 6.0


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, x))))


def _logit(p: float) -> float:
    p = max(1e-4, min(1.0 - 1e-4, p))
    return math.log(p / (1.0 - p))


@dataclass
class PlattCalibrator:
    a: float = 1.0
    b: float = 0.0
    fitted: bool = False
    method: str = "IDENTITY (UNFITTED)"
    fitted_on: str = ""
    samples: int = 0
    errors: int = 0
    ece_before: float = 0.0
    ece_after: float = 0.0
    reason: str = "No calibration fit has been performed yet."
    reliability_before: list[dict] = field(default_factory=list)
    reliability_after: list[dict] = field(default_factory=list)

    def apply(self, probability: float) -> float:
        if not self.fitted:
            return probability
        return _sigmoid(self.a * _logit(probability) + self.b)

    def fit(self, probabilities: list[float], correctness: list[int], scope: str) -> None:
        self.samples = len(probabilities)
        self.errors = sum(1 for c in correctness if c == 0)
        self.ece_before, self.reliability_before = reliability(probabilities, correctness)

        if self.samples < MIN_SAMPLES:
            self._defer(
                f"Only {self.samples} issued classifications in the harness "
                f"({MIN_SAMPLES} required). Reporting raw confidence uncalibrated."
            )
            return
        if self.errors < MIN_ERRORS:
            self._defer(
                f"{self.samples} issued classifications, all correct. A "
                "reliability fit needs observed errors to learn from; with none, "
                "any fit would simply push every confidence to 1.0. Reporting "
                "raw confidence uncalibrated."
            )
            return

        a, b = 1.0, 0.0
        xs = [_logit(p) for p in probabilities]
        n = float(self.samples)
        for _ in range(ITERATIONS):
            grad_a = grad_b = 0.0
            for x, y in zip(xs, correctness):
                error = _sigmoid(a * x + b) - y
                grad_a += error * x
                grad_b += error
            grad_a = grad_a / n + L2 * (a - 1.0)
            grad_b = grad_b / n + L2 * b
            a -= LEARNING_RATE * grad_a
            b -= LEARNING_RATE * grad_b
            a = max(-PARAM_CAP, min(PARAM_CAP, a))
            b = max(-PARAM_CAP, min(PARAM_CAP, b))

        self.a, self.b = a, b
        self.fitted = True
        self.method = "PLATT SCALING (L2 REGULARISED)"
        self.fitted_on = scope
        calibrated = [self.apply(p) for p in probabilities]
        self.ece_after, self.reliability_after = reliability(calibrated, correctness)
        self.reason = (
            f"Fitted on {self.samples} issued classifications from {scope} "
            f"({self.errors} observed error{'s' if self.errors != 1 else ''}). "
            f"Expected calibration error {self.ece_before:.3f} -> {self.ece_after:.3f}."
        )

    def _defer(self, reason: str) -> None:
        self.fitted = False
        self.a, self.b = 1.0, 0.0
        self.method = "IDENTITY (FIT DEFERRED)"
        self.ece_after = self.ece_before
        self.reliability_after = list(self.reliability_before)
        self.reason = reason

    def as_dict(self) -> dict:
        return {
            "fitted": self.fitted,
            "method": self.method,
            "fitted_on": self.fitted_on,
            "a": round(self.a, 4),
            "b": round(self.b, 4),
            "samples": self.samples,
            "errors": self.errors,
            "ece_before": round(self.ece_before, 4),
            "ece_after": round(self.ece_after, 4),
            "reason": self.reason,
            "reliability_before": self.reliability_before,
            "reliability_after": self.reliability_after,
        }


def reliability(probabilities: list[float], correctness: list[int],
                bins: int = 5) -> tuple[float, list[dict]]:
    """Expected calibration error and the reliability diagram bins."""
    out: list[dict] = []
    total = len(probabilities)
    if total == 0:
        return 0.0, out
    ece = 0.0
    for index in range(bins):
        lo = index / bins
        hi = (index + 1) / bins
        members = [
            (p, c) for p, c in zip(probabilities, correctness)
            if (lo <= p < hi) or (index == bins - 1 and p == hi)
        ]
        if not members:
            out.append({"bin": f"{lo:.1f}-{hi:.1f}", "count": 0,
                        "mean_confidence": None, "observed_accuracy": None, "gap": None})
            continue
        mean_conf = sum(p for p, _ in members) / len(members)
        observed = sum(c for _, c in members) / len(members)
        gap = abs(mean_conf - observed)
        ece += (len(members) / total) * gap
        out.append({
            "bin": f"{lo:.1f}-{hi:.1f}",
            "count": len(members),
            "mean_confidence": round(mean_conf, 4),
            "observed_accuracy": round(observed, 4),
            "gap": round(gap, 4),
        })
    return ece, out


calibrator = PlattCalibrator()
