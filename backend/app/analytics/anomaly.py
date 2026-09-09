"""
Per-cylinder anomaly detection on residuals.

Everything in this module consumes residuals, never raw sensor values.

The detector produces two distinct quantities, and conflating them is a common
mistake:

    anomaly score  - how far this cylinder has drifted from its own physics.
    confidence     - a calibrated probability that the *diagnosis* is correct,
                     driven by the breadth of evidence: how many flights, how
                     many operating regimes, whether independent channels
                     agree. A large residual seen once in one regime is a
                     strong score and a weak diagnosis.

When the evidence is insufficient the detector abstains rather than guessing.
For a defence maintenance decision, an honest abstention is a feature.

Hard threshold alarms are retained underneath all of this as a safety floor -
see ``threshold_alerts``. Oil pressure loss is a seconds-level emergency, not
a degradation trend, and prediction never replaces the reflex.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..core.constants import ENGINE, FAILURE_MODES
from ..twin.residual import ChannelResidual
from .calibration import calibrator

# --- scoring weights (transparent baseline model) --------------------------
# These operate on normalised residual features. The LightGBM path in
# ``model.py`` replaces them when a trained model is present; the weights below
# are the interpretable baseline the project's methodology requires be built
# first.
W_ASYMMETRY = 1.35      # per-cylinder CHT residual asymmetry - the core signal
W_EGT = 0.62            # supporting exhaust-side agreement
W_TRIM = 0.85           # state-estimator trim divergence from healthy baseline
W_CUSUM = 0.75          # persistence
W_Z = 0.35              # instantaneous normalised residual
BIAS = -3.10

NORM_CHT_ASYM = 6.0     # degC per unit feature
NORM_EGT_ASYM = 15.0
NORM_TRIM = 0.020       # 2% trim per unit feature
NORM_CUSUM = 80.0
NORM_Z = 3.0
FEATURE_CAP = 3.0

# --- calibration (see calibration.py for the reliability reporting) --------
C_BIAS = -3.07
C_SCORE = 1.00
C_REGIME = 1.20
C_FLIGHT = 0.80
C_AGREEMENT = 0.90
C_PERSISTENCE = 0.70

ABSTAIN_MIN_REGIMES = 2
ABSTAIN_MIN_SAMPLES = 120
ABSTAIN_MIN_CONFIDENCE = 0.45

SEVERITY_BANDS = [(0.80, "HIGH"), (0.55, "MEDIUM"), (0.30, "LOW")]


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, x))))


def _cap(value: float) -> float:
    return max(-FEATURE_CAP, min(FEATURE_CAP, value))


def regime_key(power_fraction: float, altitude_ft: float) -> str:
    if power_fraction < 0.40:
        p = "LOW PWR"
    elif power_fraction < 0.65:
        p = "CRUISE PWR"
    elif power_fraction < 0.85:
        p = "HIGH PWR"
    else:
        p = "MAX PWR"
    if altitude_ft < 5000:
        a = "LOW ALT"
    elif altitude_ft < 11000:
        a = "MID ALT"
    else:
        a = "HIGH ALT"
    return f"{p} / {a}"


@dataclass(slots=True)
class FeatureContribution:
    feature: str
    label: str
    value: float
    unit: str
    contribution: float

    def as_dict(self) -> dict:
        return {
            "feature": self.feature,
            "label": self.label,
            "value": round(self.value, 3),
            "unit": self.unit,
            "contribution": round(self.contribution, 4),
        }


@dataclass(slots=True)
class Anomaly:
    id: str
    rank: int
    title: str
    subsystem: str
    cylinder: int | None
    severity: str
    score: float
    confidence: float
    confidence_raw: float
    abstained: bool
    abstain_reason: str | None
    mechanism: str | None
    mechanism_label: str | None
    mechanism_qualifier: str          # LIKELY | POSSIBLE | LOW CONFIDENCE | ABSTAIN
    summary: str
    residual: float
    residual_unit: str
    trend: str
    regimes: list[str]
    flights: int
    samples: int
    first_seen_t: float
    last_seen_t: float
    contributions: list[FeatureContribution] = field(default_factory=list)
    supporting: dict = field(default_factory=dict)
    # Populated by the runtime once the learned model has enough evidence.
    # Empty means the Isolation Forest abstained and the physics baseline
    # carried the diagnosis alone.
    learned: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "rank": self.rank,
            "title": self.title,
            "subsystem": self.subsystem,
            "cylinder": self.cylinder,
            "severity": self.severity,
            "score": round(self.score, 4),
            "confidence": round(self.confidence, 4),
            "confidence_raw": round(self.confidence_raw, 4),
            "calibrated": calibrator.fitted,
            "abstained": self.abstained,
            "abstain_reason": self.abstain_reason,
            "mechanism": self.mechanism,
            "mechanism_label": self.mechanism_label,
            "mechanism_qualifier": self.mechanism_qualifier,
            "summary": self.summary,
            "residual": round(self.residual, 2),
            "residual_unit": self.residual_unit,
            "trend": self.trend,
            "regimes": self.regimes,
            "regime_count": len(self.regimes),
            "flights": self.flights,
            "samples": self.samples,
            "first_seen_t": self.first_seen_t,
            "last_seen_t": self.last_seen_t,
            "contributions": [c.as_dict() for c in self.contributions],
            "supporting": self.supporting,
            "learned": self.learned,
        }


@dataclass(slots=True)
class _Track:
    """Per-subject evidence accumulator across the mission and across flights."""

    regimes: set[str] = field(default_factory=set)
    samples: int = 0
    active_samples: int = 0
    first_seen_t: float = 0.0
    last_seen_t: float = 0.0
    flights: set[str] = field(default_factory=set)
    peak_score: float = 0.0
    started: bool = False


class AnomalyDetector:
    """Stateful detector. One instance per engine, persists across flights."""

    DETECT_Z = 2.0

    def __init__(self) -> None:
        self.tracks: dict[str, _Track] = {}
        self.history_flights: dict[str, int] = {}

    # -- evidence accumulation ---------------------------------------------

    def _track(self, key: str) -> _Track:
        if key not in self.tracks:
            self.tracks[key] = _Track()
        return self.tracks[key]

    def observe(
        self,
        residuals: dict[str, ChannelResidual],
        power_fraction: float,
        altitude_ft: float,
        t: float,
        flight_id: str,
        steady: bool,
    ) -> None:
        if not steady:
            return
        regime = regime_key(power_fraction, altitude_ft)
        cht_res = [residuals[f"cht_{i}"].ewma for i in range(1, 5) if f"cht_{i}" in residuals]
        cht_mean = sum(cht_res) / len(cht_res) if cht_res else 0.0

        for i in range(1, 5):
            key = f"CYL{i}"
            track = self._track(key)
            track.samples += 1
            track.last_seen_t = t
            track.flights.add(flight_id)
            res = residuals.get(f"cht_{i}")
            if res is None:
                continue
            asym = res.ewma - cht_mean
            if abs(res.normalised) > self.DETECT_Z or abs(asym) > 3.0:
                track.active_samples += 1
                track.regimes.add(regime)
                if not track.started:
                    track.first_seen_t = t
                    track.started = True

        for key, channel in (("OIL_PRESS", "oil_press_psi"), ("OIL_TEMP", "oil_temp_c"),
                             ("FUEL", "fuel_flow_gph"), ("MAP", "map_inhg"), ("RPM", "rpm")):
            res = residuals.get(channel)
            if res is None:
                continue
            track = self._track(key)
            track.samples += 1
            track.last_seen_t = t
            track.flights.add(flight_id)
            if abs(res.normalised) > self.DETECT_Z:
                track.active_samples += 1
                track.regimes.add(regime)
                if not track.started:
                    track.first_seen_t = t
                    track.started = True

    # -- scoring ------------------------------------------------------------

    def evaluate(
        self,
        residuals: dict[str, ChannelResidual],
        trim_divergence: list[float],
        egt_trim_divergence: list[float],
        flights_observed: int,
    ) -> list[Anomaly]:
        anomalies: list[Anomaly] = []
        cht_res = [residuals[f"cht_{i}"].ewma for i in range(1, 5) if f"cht_{i}" in residuals]
        egt_res = [residuals[f"egt_{i}"].ewma for i in range(1, 5) if f"egt_{i}" in residuals]
        cht_mean = sum(cht_res) / len(cht_res) if cht_res else 0.0
        egt_mean = sum(egt_res) / len(egt_res) if egt_res else 0.0

        for i in range(1, 5):
            cht = residuals.get(f"cht_{i}")
            egt = residuals.get(f"egt_{i}")
            if cht is None:
                continue
            anomalies.append(
                self._score_cylinder(
                    i, cht, egt, cht_mean, egt_mean,
                    trim_divergence[i - 1] if i <= len(trim_divergence) else 0.0,
                    egt_trim_divergence[i - 1] if i <= len(egt_trim_divergence) else 0.0,
                    flights_observed,
                )
            )

        anomalies.extend(self._score_global(residuals, flights_observed))
        anomalies = [a for a in anomalies if a.score >= 0.12]
        anomalies.sort(key=lambda a: (a.score, a.confidence), reverse=True)
        for rank, anomaly in enumerate(anomalies, start=1):
            anomaly.rank = rank
        return anomalies

    def _score_cylinder(
        self, index: int, cht: ChannelResidual, egt: ChannelResidual | None,
        cht_mean: float, egt_mean: float, trim_div: float, egt_trim_div: float,
        flights_observed: int,
    ) -> Anomaly:
        track = self._track(f"CYL{index}")
        cht_asym = cht.ewma - cht_mean
        egt_asym = (egt.ewma - egt_mean) if egt else 0.0

        # Magnitude, not direction. A cylinder running abnormally COLD is a
        # fault too - spark plug fouling drops EGT and CHT on one cylinder.
        # Scoring on the signed value would make the detector blind to it.
        # Direction is preserved separately and used to name the mechanism.
        f_asym = _cap(abs(cht_asym) / NORM_CHT_ASYM)
        f_egt = _cap(abs(egt_asym) / NORM_EGT_ASYM)
        f_trim = _cap(abs(trim_div) / NORM_TRIM)
        f_cusum = _cap(cht.cusum / NORM_CUSUM)
        f_z = _cap(abs(cht.normalised) / NORM_Z)

        logit = (
            BIAS
            + W_ASYMMETRY * f_asym
            + W_EGT * f_egt
            + W_TRIM * f_trim
            + W_CUSUM * f_cusum
            + W_Z * f_z
        )
        score = sigmoid(logit)

        contributions = [
            FeatureContribution(f"cht_{index}_residual_asymmetry",
                                f"CHT-{index} residual asymmetry", cht_asym, "°C",
                                W_ASYMMETRY * f_asym),
            FeatureContribution(f"cyl{index}_trim_divergence",
                                f"CYL-{index} trim divergence", trim_div * 100.0, "%",
                                W_TRIM * f_trim),
            FeatureContribution(f"cht_{index}_persistence",
                                f"CHT-{index} persistence (CUSUM)", cht.cusum, "σ·n",
                                W_CUSUM * f_cusum),
            FeatureContribution(f"egt_{index}_residual_asymmetry",
                                f"EGT-{index} residual asymmetry", egt_asym, "°C",
                                W_EGT * f_egt),
            FeatureContribution(f"cht_{index}_normalised",
                                f"CHT-{index} normalised residual", cht.normalised, "σ",
                                W_Z * f_z),
        ]
        contributions.sort(key=lambda c: abs(c.contribution), reverse=True)

        agreement = _agreement(cht_asym, egt_asym, trim_div)
        persistence = track.active_samples / max(1, track.samples)
        confidence, confidence_raw, abstained, reason = self._calibrate(
            score, len(track.regimes), max(flights_observed, len(track.flights)),
            agreement, persistence, track.samples,
        )

        mechanism = _infer_mechanism(cht_asym, egt_asym, trim_div)
        qualifier = _qualifier(confidence, abstained)
        severity = _severity(score, abstained)
        trend = _trend_label(cht.ewma, cht.cusum)

        summary = (
            f"CHT-{index} residual {cht_asym:+.1f} °C against physics expectation, "
            f"{'persistent' if persistence > 0.5 else 'intermittent'} across "
            f"{len(track.regimes)} operating regime{'s' if len(track.regimes) != 1 else ''}."
        )

        return Anomaly(
            id=f"ANOM-CYL{index}",
            rank=0,
            title=f"CYLINDER {index} CHT",
            subsystem="THERMAL / PER-CYLINDER",
            cylinder=index,
            severity=severity,
            score=score,
            confidence=confidence,
            confidence_raw=confidence_raw,
            abstained=abstained,
            abstain_reason=reason,
            mechanism=None if abstained else mechanism,
            mechanism_label=None if abstained else FAILURE_MODES[mechanism]["label"],
            mechanism_qualifier=qualifier,
            summary=summary,
            residual=cht.residual,
            residual_unit="°C",
            trend=trend,
            regimes=sorted(track.regimes),
            flights=max(flights_observed, len(track.flights)),
            samples=track.samples,
            first_seen_t=track.first_seen_t,
            last_seen_t=track.last_seen_t,
            contributions=contributions,
            supporting={
                "cht_expected": round(cht.expected, 1),
                "cht_observed": round(cht.observed, 1),
                "cht_residual": round(cht.residual, 1),
                "cht_drift": round(cht.ewma, 1),
                "egt_residual": round(egt.residual, 1) if egt else None,
                "egt_drift": round(egt.ewma, 1) if egt else None,
                "trim_divergence_pct": round(trim_div * 100.0, 2),
                "egt_trim_divergence_c": round(egt_trim_div, 1),
                "persistence": round(persistence, 3),
                "agreement": round(agreement, 3),
            },
        )

    def _score_global(
        self, residuals: dict[str, ChannelResidual], flights_observed: int
    ) -> list[Anomaly]:
        specs = [
            ("OIL_PRESS", "oil_press_psi", "OIL PRESSURE", "LUBRICATION", 2.2, "bearing_wear"),
            ("OIL_TEMP", "oil_temp_c", "OIL TEMPERATURE", "LUBRICATION", 3.0, "bearing_wear"),
            ("FUEL", "fuel_flow_gph", "FUEL FLOW", "INDUCTION / FUEL", 0.35, None),
            ("MAP", "map_inhg", "MANIFOLD PRESSURE", "INDUCTION / FUEL", 0.45, None),
            ("RPM", "rpm", "ENGINE RPM", "OPERATING POINT", 28.0, None),
        ]
        out: list[Anomaly] = []
        for key, channel, title, subsystem, norm, mechanism in specs:
            res = residuals.get(channel)
            if res is None:
                continue
            track = self._track(key)
            f_drift = _cap(res.ewma / norm)
            f_cusum = _cap(res.cusum / NORM_CUSUM)
            f_z = _cap(res.normalised / NORM_Z)
            logit = BIAS + 1.15 * abs(f_drift) + 0.80 * f_cusum + 0.40 * abs(f_z)
            score = sigmoid(logit)
            persistence = track.active_samples / max(1, track.samples)
            confidence, confidence_raw, abstained, reason = self._calibrate(
                score, len(track.regimes), max(flights_observed, len(track.flights)),
                min(1.0, abs(f_drift) / 2.0), persistence, track.samples,
            )
            out.append(
                Anomaly(
                    id=f"ANOM-{key}",
                    rank=0,
                    title=title,
                    subsystem=subsystem,
                    cylinder=None,
                    severity=_severity(score, abstained),
                    score=score,
                    confidence=confidence,
                    confidence_raw=confidence_raw,
                    abstained=abstained,
                    abstain_reason=reason,
                    mechanism=None if abstained else mechanism,
                    mechanism_label=(
                        FAILURE_MODES[mechanism]["label"]
                        if mechanism and not abstained else None
                    ),
                    mechanism_qualifier=_qualifier(confidence, abstained),
                    summary=(
                        f"{title} residual drift {res.ewma:+.2f} {res.unit} "
                        f"against physics expectation."
                    ),
                    residual=res.residual,
                    residual_unit=res.unit,
                    trend=_trend_label(res.ewma, res.cusum),
                    regimes=sorted(track.regimes),
                    flights=max(flights_observed, len(track.flights)),
                    samples=track.samples,
                    first_seen_t=track.first_seen_t,
                    last_seen_t=track.last_seen_t,
                    contributions=[
                        FeatureContribution(f"{channel}_drift", f"{title} drift",
                                            res.ewma, res.unit, 1.15 * abs(f_drift)),
                        FeatureContribution(f"{channel}_persistence",
                                            f"{title} persistence (CUSUM)", res.cusum,
                                            "σ·n", 0.80 * f_cusum),
                        FeatureContribution(f"{channel}_normalised",
                                            f"{title} normalised residual",
                                            res.normalised, "σ", 0.40 * abs(f_z)),
                    ],
                    supporting={
                        "expected": round(res.expected, 2),
                        "observed": round(res.observed, 2),
                        "residual": round(res.residual, 2),
                        "drift": round(res.ewma, 3),
                        "persistence": round(persistence, 3),
                    },
                )
            )
        return out

    # -- calibrated confidence + abstention ---------------------------------

    @staticmethod
    def _calibrate(
        score: float, regimes: int, flights: int, agreement: float,
        persistence: float, samples: int,
    ) -> tuple[float, float, bool, str | None]:
        regime_term = min(regimes, 4) / 4.0
        flight_term = min(flights, 8) / 8.0
        logit = (
            C_BIAS
            + C_SCORE * score
            + C_REGIME * regime_term
            + C_FLIGHT * flight_term
            + C_AGREEMENT * agreement
            + C_PERSISTENCE * persistence
        )
        raw = sigmoid(logit)
        # The fitted reliability correction, if the validation harness produced
        # enough evidence to fit one. Identity otherwise - never a made-up shift.
        confidence = calibrator.apply(raw)

        if score < 0.30:
            return confidence, raw, False, None
        if regimes < ABSTAIN_MIN_REGIMES:
            return confidence, raw, True, (
                f"Observed in only {regimes} operating regime"
                f"{'s' if regimes != 1 else ''}. A single-regime deviation cannot be "
                "separated from a model bias. Additional telemetry across a "
                "different power or altitude band is required."
            )
        if samples < ABSTAIN_MIN_SAMPLES:
            return confidence, raw, True, (
                f"Only {samples} steady-state samples accumulated. Evidence base "
                "is below the minimum for a fault classification."
            )
        if confidence < ABSTAIN_MIN_CONFIDENCE:
            return confidence, raw, True, (
                "Calibrated confidence is below the classification floor. The "
                "system will not issue a fault classification on this evidence."
            )
        return confidence, raw, False, None


# --------------------------------------------------------------------------
# Hard threshold safety floor - retained, never replaced by prediction
# --------------------------------------------------------------------------

def threshold_alerts(channels: dict[str, float]) -> list[dict]:
    """Absolute-limit alarms. These run underneath the predictive layer.

    Oil pressure loss is a seconds-level emergency, not a degradation trend.
    Some failures need an instant reflex, not a prediction.
    """
    alerts: list[dict] = []

    for i in range(1, 5):
        cht = channels.get(f"cht_{i}")
        if cht is None:
            continue
        if cht >= ENGINE["cht_redline_c"]:
            alerts.append(_alert("CRITICAL", f"CHT-{i} ABOVE REDLINE",
                                 f"{cht:.0f} °C / limit {ENGINE['cht_redline_c']:.0f} °C",
                                 "Reduce power and enrich mixture immediately."))
        elif cht >= ENGINE["cht_caution_c"]:
            alerts.append(_alert("WARNING", f"CHT-{i} IN CAUTION BAND",
                                 f"{cht:.0f} °C / caution {ENGINE['cht_caution_c']:.0f} °C",
                                 "Monitor. Consider power or mixture adjustment."))
        egt = channels.get(f"egt_{i}")
        if egt is not None and egt >= ENGINE["egt_redline_c"]:
            alerts.append(_alert("CRITICAL", f"EGT-{i} ABOVE REDLINE",
                                 f"{egt:.0f} °C / limit {ENGINE['egt_redline_c']:.0f} °C",
                                 "Enrich mixture and reduce power."))

    oil_p = channels.get("oil_press_psi")
    if oil_p is not None:
        if oil_p <= ENGINE["oil_press_min_psi"]:
            alerts.append(_alert("CRITICAL", "OIL PRESSURE BELOW SAFETY THRESHOLD",
                                 f"{oil_p:.0f} psi / minimum {ENGINE['oil_press_min_psi']:.0f} psi",
                                 "Immediate operator attention required. Oil starvation "
                                 "is catastrophic within seconds."))
        elif oil_p <= ENGINE["oil_press_caution_psi"]:
            alerts.append(_alert("WARNING", "OIL PRESSURE LOW",
                                 f"{oil_p:.0f} psi / caution {ENGINE['oil_press_caution_psi']:.0f} psi",
                                 "Reduce power and prepare to divert."))

    oil_t = channels.get("oil_temp_c")
    if oil_t is not None and oil_t >= ENGINE["oil_temp_redline_c"]:
        alerts.append(_alert("CRITICAL", "OIL TEMPERATURE ABOVE REDLINE",
                             f"{oil_t:.0f} °C / limit {ENGINE['oil_temp_redline_c']:.0f} °C",
                             "Reduce power and increase cooling airflow."))
    return alerts


def _alert(level: str, title: str, detail: str, action: str) -> dict:
    return {"level": level, "title": title, "detail": detail, "action": action,
            "origin": "THRESHOLD SAFETY FLOOR"}


# --------------------------------------------------------------------------


def _agreement(cht_asym: float, egt_asym: float, trim_div: float) -> float:
    """Do independent channels tell the same story?

    A CHT rise with a matching EGT rise on the same cylinder is a physical
    story. A CHT rise alone is as likely to be an instrumentation or model
    problem, and the confidence must reflect that.
    """
    if abs(cht_asym) < 0.8:
        return 0.0
    signals = 0.0
    if egt_asym * cht_asym > 0 and abs(egt_asym) > 3.0:
        signals += 0.55
    if trim_div * cht_asym > 0 and abs(trim_div) > 0.004:
        signals += 0.45
    return min(1.0, signals)


def _infer_mechanism(cht_asym: float, egt_asym: float, trim_div: float) -> str:
    """Map the residual *signature* onto a named physical failure mode.

    Direction matters here even though magnitude drives the score:

        CHT up   + EGT up    -> hot gas past a failing exhaust valve
        CHT up   + EGT down  -> head losing combustion gas, not burning hotter
        CHT down + EGT down  -> a cylinder that has stopped contributing
        CHT up   + EGT flat  -> abnormal combustion at high load
    """
    if cht_asym < -1.0 and egt_asym < -10.0:
        return "plug_fouling"
    if cht_asym > 6.0 and abs(egt_asym) < 4.0:
        return "detonation"
    if cht_asym > 1.0 and egt_asym < -6.0:
        return "cylinder_head_cracking"
    return "exhaust_valve_distress"


def _qualifier(confidence: float, abstained: bool) -> str:
    if abstained:
        return "ABSTAIN"
    if confidence >= 0.75:
        return "LIKELY"
    if confidence >= 0.55:
        return "POSSIBLE"
    return "LOW CONFIDENCE"


def _severity(score: float, abstained: bool) -> str:
    if abstained:
        return "UNCLASSIFIED"
    for threshold, label in SEVERITY_BANDS:
        if score >= threshold:
            return label
    return "INFO"


def _trend_label(ewma: float, cusum: float) -> str:
    if cusum > 120 and abs(ewma) > 1.0:
        return "PERSISTENT DRIFT" if ewma > 0 else "PERSISTENT NEGATIVE DRIFT"
    if abs(ewma) > 1.0:
        return "DRIFTING" if ewma > 0 else "DRIFTING LOW"
    if cusum > 60:
        return "INTERMITTENT"
    return "STABLE"
