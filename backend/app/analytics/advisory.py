"""
Maintenance advisory generation.

The output the ground crew actually acts on: a ranked list of items, each with
the reason, the evidence that produced it, the likely physical mechanism, a
calibrated confidence and a recommended action tied to a despatch decision.

Advisories are generated from anomalies. An anomaly the detector abstained on
still produces an advisory - but a *monitoring* one, which explicitly says the
system declined to classify and what additional evidence would settle it.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..core.constants import FAILURE_MODES
from .anomaly import Anomaly
from .explain import build_explanation

PRIORITY_ACTIONS = {
    "HIGH": ("INSPECT BEFORE NEXT SORTIE", "P1"),
    "MEDIUM": ("INSPECT AT NEXT SCHEDULED ACCESS", "P2"),
    "LOW": ("MONITOR - NO ACTION REQUIRED", "P3"),
    "UNCLASSIFIED": ("CONTINUE MONITORING - EVIDENCE INSUFFICIENT", "P3"),
    "INFO": ("NO ACTION", "P4"),
}


@dataclass(slots=True)
class Advisory:
    id: str
    priority: int
    priority_code: str
    title: str
    action: str
    reason: str
    mechanism: str | None
    mechanism_label: str | None
    qualifier: str
    confidence: float
    severity: str
    despatch_impact: str
    evidence: list[dict] = field(default_factory=list)
    evidence_trail: dict = field(default_factory=dict)
    procedure: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "priority": self.priority,
            "priority_code": self.priority_code,
            "priority_label": f"PRIORITY {self.priority:02d}",
            "title": self.title,
            "action": self.action,
            "reason": self.reason,
            "mechanism": self.mechanism,
            "mechanism_label": self.mechanism_label,
            "qualifier": self.qualifier,
            "confidence": round(self.confidence, 4),
            "confidence_pct": round(self.confidence * 100.0, 1),
            "severity": self.severity,
            "despatch_impact": self.despatch_impact,
            "evidence": self.evidence,
            "evidence_trail": self.evidence_trail,
            "procedure": self.procedure,
        }


def _despatch_impact(severity: str, abstained: bool) -> str:
    if abstained:
        return "NO DESPATCH RESTRICTION - MONITORING ONLY"
    return {
        "HIGH": "INSPECT BEFORE NEXT SORTIE",
        "MEDIUM": "NO IMMEDIATE RESTRICTION - SCHEDULE INSPECTION",
        "LOW": "NO RESTRICTION",
        "INFO": "NO RESTRICTION",
    }.get(severity, "NO RESTRICTION")


def _procedure(anomaly: Anomaly) -> list[str]:
    if anomaly.abstained:
        return [
            "Continue telemetry collection over the next sortie.",
            "Target a different power and altitude band to widen regime coverage.",
            "Re-evaluate once the evidence threshold is met.",
        ]
    if anomaly.cylinder and anomaly.mechanism == "exhaust_valve_distress":
        return [
            f"Borescope inspection of cylinder {anomaly.cylinder} exhaust valve and seat.",
            f"Differential compression check on cylinder {anomaly.cylinder}.",
            "Inspect exhaust port and valve guide for hot-gas erosion tracking.",
            "Verify the fuel injector nozzle for that cylinder is clear and correctly sized.",
            "Record findings against this advisory ID to close the evidence trail.",
        ]
    if anomaly.mechanism == "bearing_wear":
        return [
            "Cut and inspect the oil filter for ferrous and non-ferrous debris.",
            "Send an oil sample for spectrographic analysis.",
            "Verify oil pressure sender calibration before accepting the trend.",
        ]
    if anomaly.mechanism == "plug_fouling":
        return [
            f"Remove, inspect and gap the spark plugs on cylinder {anomaly.cylinder}.",
            "Check ignition harness continuity for that cylinder.",
        ]
    if anomaly.mechanism == "cylinder_head_cracking":
        return [
            f"Differential compression check on cylinder {anomaly.cylinder}.",
            "Visual and dye-penetrant inspection of the cylinder head casting.",
        ]
    return [
        "Review the residual trend against the maintenance log.",
        "Re-inspect at the next scheduled access.",
    ]


def build_advisories(anomalies: list[Anomaly], threshold_alerts: list[dict]) -> list[Advisory]:
    advisories: list[Advisory] = []
    priority = 1

    # Hard-limit exceedances always outrank predictive findings.
    for alert in threshold_alerts:
        if alert["level"] != "CRITICAL":
            continue
        advisories.append(
            Advisory(
                id=f"ADV-THR-{priority:02d}",
                priority=priority,
                priority_code="P0",
                title=alert["title"],
                action=alert["action"],
                reason=f"{alert['detail']}. Absolute limit exceeded.",
                mechanism=None,
                mechanism_label=None,
                qualifier="THRESHOLD",
                confidence=1.0,
                severity="CRITICAL",
                despatch_impact="AIRCRAFT UNSERVICEABLE UNTIL RECTIFIED",
                evidence=[{"label": "ORIGIN", "value": "THRESHOLD SAFETY FLOOR"},
                          {"label": "MEASUREMENT", "value": alert["detail"]}],
                evidence_trail={"origin": "threshold", "detail": alert["detail"]},
                procedure=["Rectify the limit exceedance before further flight."],
            )
        )
        priority += 1

    for anomaly in anomalies:
        if anomaly.score < 0.30 and not anomaly.abstained:
            continue
        severity = anomaly.severity
        action, code = PRIORITY_ACTIONS.get(severity, ("MONITOR", "P3"))
        mode = FAILURE_MODES.get(anomaly.mechanism or "", {})
        if anomaly.mechanism and not anomaly.abstained:
            action = mode.get("action", action)

        title = (
            f"INSPECT CYLINDER {anomaly.cylinder}"
            if anomaly.cylinder and not anomaly.abstained
            else f"MONITOR {anomaly.title}"
        )

        evidence = [
            {"label": "FLIGHTS", "value": f"{anomaly.flights}"},
            {"label": "OPERATING REGIMES", "value": f"{len(anomaly.regimes)}"},
            {"label": "RESIDUAL DRIFT",
             "value": f"{anomaly.supporting.get('cht_drift', anomaly.supporting.get('drift', 0)):+.1f} "
                      f"{anomaly.residual_unit}"},
            {"label": "STEADY SAMPLES", "value": f"{anomaly.samples:,}"},
            {"label": "TREND", "value": anomaly.trend},
        ]
        if anomaly.cylinder:
            evidence.append({
                "label": "TRIM DIVERGENCE",
                "value": f"{anomaly.supporting.get('trim_divergence_pct', 0):+.1f} %",
            })

        advisories.append(
            Advisory(
                id=f"ADV-{anomaly.id}",
                priority=priority,
                priority_code=code,
                title=title,
                action=action,
                reason=anomaly.summary,
                mechanism=anomaly.mechanism,
                mechanism_label=anomaly.mechanism_label,
                qualifier=anomaly.mechanism_qualifier,
                confidence=anomaly.confidence,
                severity=severity,
                despatch_impact=_despatch_impact(severity, anomaly.abstained),
                evidence=evidence,
                evidence_trail=build_explanation(anomaly),
                procedure=_procedure(anomaly),
            )
        )
        priority += 1

    return advisories
