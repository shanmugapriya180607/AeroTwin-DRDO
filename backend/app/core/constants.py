"""
Static domain constants: engine specification, sensor channel registry with
provenance tags, dataset facts and product identity.

Every fact in DATASET_NGAFID is sourced from the project solution document
(NGAFID-MC, Zenodo record 6624956, CC-BY-4.0). Nothing here is invented.
"""

from __future__ import annotations

from typing import Literal, TypedDict

# --------------------------------------------------------------------------
# Product identity
# --------------------------------------------------------------------------

PRODUCT_NAME = "AEROTWIN"
PRODUCT_SUBTITLE = "AI-Powered Propulsion Intelligence for MALE UAVs"
PRODUCT_TAGLINE = "PROPULSION INTELLIGENCE SYSTEM"
PROGRAMME_REF = "PS-26054"
BUILD_STATUS = "RESEARCH PROTOTYPE / DECISION SUPPORT"
AIRWORTHINESS_NOTICE = (
    "Not certified for airworthiness decisions. Research demonstrator only."
)

MODEL_ID = "FGPISTON-180"
MODEL_VERSION = "1.0.0"

# --------------------------------------------------------------------------
# Engine specification - Lycoming IO-360 class (the NGAFID-MC engine)
# --------------------------------------------------------------------------

ENGINE = {
    "designation": "AERO-01",
    "class_label": "4-cylinder horizontally opposed, air-cooled, fuel-injected",
    "reference_engine": "Lycoming IO-360 class",
    "rated_power_hp": 180.0,
    "rated_rpm": 2700.0,
    "idle_rpm": 700.0,
    "cylinders": 4,
    "displacement_in3": 361.0,
    "cycles": 4,
    "bsfc_lb_per_hp_hr": 0.45,
    "cht_redline_c": 260.0,
    "cht_caution_c": 232.0,
    "egt_redline_c": 843.0,
    "oil_temp_redline_c": 118.0,
    "oil_press_min_psi": 25.0,
    "oil_press_caution_psi": 45.0,
    "oil_press_max_psi": 95.0,
}

# Per-cylinder installation asymmetry of a real air-cooled opposed engine:
# rear cylinders sit in a degraded cooling-air path and run marginally hotter.
CYLINDER_COOLING_BIAS = [0.0, -2.1, 1.4, -1.0]      # degC on CHT
CYLINDER_EGT_BIAS = [0.0, -6.0, 4.0, -3.0]          # degC on EGT

# --------------------------------------------------------------------------
# Sensor channel registry -- provenance is a first-class property
# --------------------------------------------------------------------------

Provenance = Literal["REAL", "SIMULATED"]


class Channel(TypedDict):
    key: str
    label: str
    unit: str
    group: str
    provenance: Provenance
    per_cylinder: bool
    note: str


def _real(key: str, label: str, unit: str, group: str, per_cyl: bool = False) -> Channel:
    return {
        "key": key,
        "label": label,
        "unit": unit,
        "group": group,
        "provenance": "REAL",
        "per_cylinder": per_cyl,
        "note": (
            "Measured channel. Present in the NGAFID-MC corpus at 1 Hz and "
            "replayed verbatim; in demo mode it is produced by the telemetry "
            "simulator against the same data contract."
        ),
    }


def _sim(key: str, label: str, unit: str, group: str, why: str) -> Channel:
    return {
        "key": key,
        "label": label,
        "unit": unit,
        "group": group,
        "provenance": "SIMULATED",
        "per_cylinder": False,
        "note": why,
    }


CHANNELS: list[Channel] = [
    _real("rpm", "ENGINE RPM", "rpm", "OPERATING POINT"),
    _real("map_inhg", "MANIFOLD PRESSURE", "inHg", "OPERATING POINT"),
    _real("fuel_flow_gph", "FUEL FLOW", "gph", "OPERATING POINT"),
    _real("egt_1", "EGT 1", "°C", "COMBUSTION", True),
    _real("egt_2", "EGT 2", "°C", "COMBUSTION", True),
    _real("egt_3", "EGT 3", "°C", "COMBUSTION", True),
    _real("egt_4", "EGT 4", "°C", "COMBUSTION", True),
    _real("cht_1", "CHT 1", "°C", "THERMAL", True),
    _real("cht_2", "CHT 2", "°C", "THERMAL", True),
    _real("cht_3", "CHT 3", "°C", "THERMAL", True),
    _real("cht_4", "CHT 4", "°C", "THERMAL", True),
    _real("oil_press_psi", "OIL PRESSURE", "psi", "LUBRICATION"),
    _real("oil_temp_c", "OIL TEMPERATURE", "°C", "LUBRICATION"),
    _real("oat_c", "OUTSIDE AIR TEMP", "°C", "AMBIENT"),
    _real("altitude_ft", "PRESSURE ALTITUDE", "ft", "AMBIENT"),
    _real("ias_kt", "INDICATED AIRSPEED", "kt", "AMBIENT"),
    _sim(
        "vibration_g",
        "VIBRATION",
        "g rms",
        "MECHANICAL",
        "No real counterpart. NGAFID-MC carries no accelerometer channel, so "
        "vibration is generated from the physics model's combustion-balance "
        "state and tagged synthetic everywhere it appears.",
    ),
    _sim(
        "inj_timing_deg",
        "INJECTION TIMING",
        "°BTDC",
        "MECHANICAL",
        "No real counterpart. Injection/ignition timing is not published in "
        "NGAFID-MC; it is derived from the physics model's operating point and "
        "tagged synthetic everywhere it appears.",
    ),
]

CHANNEL_BY_KEY = {c["key"]: c for c in CHANNELS}
REAL_CHANNELS = [c["key"] for c in CHANNELS if c["provenance"] == "REAL"]
SIMULATED_CHANNELS = [c["key"] for c in CHANNELS if c["provenance"] == "SIMULATED"]

# Channels for which the physics model produces an expectation, and therefore
# for which a residual exists. This is the analytics feature source.
RESIDUAL_CHANNELS = [
    "cht_1", "cht_2", "cht_3", "cht_4",
    "egt_1", "egt_2", "egt_3", "egt_4",
    "map_inhg", "rpm", "oil_press_psi", "oil_temp_c", "fuel_flow_gph",
]

# --------------------------------------------------------------------------
# Dataset facts (sourced -- do not edit without a source)
# --------------------------------------------------------------------------

DATASET_NGAFID = {
    "id": "NGAFID-MC",
    "name": "NGAFID Maintenance Classification",
    "flights": 28935,
    "flight_hours": 31177,
    "aircraft": "Cessna 172",
    "engine": "Lycoming IO-360",
    "rated_power_hp": 180,
    "engine_class": "4-cylinder horizontally opposed piston",
    "sensors": 23,
    "sample_rate_hz": 1,
    "size_gb": 5.4,
    "maintenance_events": 2111,
    "issue_types": 36,
    "licence": "CC-BY-4.0",
    "doi": "10.5281/zenodo.6624956",
    "url": "https://zenodo.org/records/6624956",
    "paper": "https://arxiv.org/abs/2210.07317",
    "loader": "https://github.com/hyang0129/NGAFIDDATASET",
    "benchmark_task": "P(RUL > 2 days)",
}

REJECTED_DATASETS = [
    {
        "id": "NASA C-MAPSS / N-CMAPSS",
        "verdict": "REJECTED",
        "reason": (
            "Turbofan. Brayton cycle, spools at 10,000-50,000 rpm, degradation "
            "by blade fouling. It contains no per-cylinder channels at all - "
            "and per-cylinder asymmetry is the entire diagnostic basis of "
            "piston-engine condition monitoring."
        ),
    },
    {
        "id": "NASA PCoE Prognostics Repository",
        "verdict": "REJECTED",
        "reason": "Bearings, batteries, IGBTs, milling. No piston engine data.",
    },
    {
        "id": "Case Western / IMS / Paderborn",
        "verdict": "PARTIAL",
        "reason": "Rolling-element bearing vibration only - a component, not an engine.",
    },
    {
        "id": "Unattributed Kaggle 'engine fault' sets",
        "verdict": "REJECTED",
        "reason": "No provenance. The question 'which engine?' has no answer.",
    },
    {
        "id": "DRDO / VRDE test-rig data",
        "verdict": "UNAVAILABLE",
        "reason": "Classified. Will not be released. The architecture is built to accept it without code change.",
    },
]

# --------------------------------------------------------------------------
# Failure-mode library used by the diagnostic reasoner
# --------------------------------------------------------------------------

FAILURE_MODES = {
    "exhaust_valve_distress": {
        "label": "Early exhaust valve distress",
        "signature": "Single-cylinder CHT and EGT rise together, persistent across regimes",
        "consequence": "Progressive valve burn, compression loss, possible cylinder failure",
        "action": "Borescope inspection of the affected cylinder exhaust valve",
    },
    "cylinder_head_cracking": {
        "label": "Cylinder head thermal fatigue",
        "signature": "CHT asymmetry with compression loss, EGT largely unchanged",
        "consequence": "Head cracking, combustion gas leakage",
        "action": "Compression check and head inspection",
    },
    "detonation": {
        "label": "Detonation / pre-ignition",
        "signature": "Rapid CHT spike with vibration energy rise at high load",
        "consequence": "Piston and ring-land destruction within minutes",
        "action": "Reduce power, enrich mixture, inspect plugs and induction",
    },
    "plug_fouling": {
        "label": "Spark plug fouling",
        "signature": "EGT drop on one cylinder, rough running, CHT unchanged or lower",
        "consequence": "Power loss, incomplete combustion",
        "action": "Plug removal, cleaning and gap check",
    },
    "bearing_wear": {
        "label": "Crankshaft bearing wear",
        "signature": "Oil pressure downward trend with vibration energy rise",
        "consequence": "Bearing failure, oil starvation",
        "action": "Oil filter inspection for metal, oil analysis",
    },
    "oil_starvation": {
        "label": "Oil starvation",
        "signature": "Oil pressure collapse",
        "consequence": "Catastrophic within seconds - not a degradation trend",
        "action": "Immediate power reduction and landing. Threshold interlock, not prediction.",
    },
    "camshaft_spalling": {
        "label": "Camshaft / lifter spalling",
        "signature": "Progressive, broad power-side degradation; driven by corrosion during inactivity",
        "consequence": "Leading cause of premature overhaul in irregularly flown aircraft",
        "action": "Oil filter metal check; inspect at next scheduled access",
    },
}

# --------------------------------------------------------------------------
# Declared limitations (product-visible honesty layer)
# --------------------------------------------------------------------------

LIMITATIONS = [
    {
        "id": 1,
        "tag": "AIRFRAME",
        "state": "GAP",
        "severity": "HIGH",
        "title": "Real data is from a Cessna 172, not a MALE UAV",
        "detail": (
            "Same engine class: 4-cylinder horizontally opposed, ~180 hp, "
            "air-cooled, fuel-injected. The thermodynamics, failure modes and "
            "sensor channels transfer. Duty cycle and airframe do not."
        ),
        "mitigation": "Domain gap stated explicitly and quantified; feature layer is engine-configurable.",
    },
    {
        "id": 2,
        "tag": "VIBRATION DATA",
        "state": "SIMULATED",
        "severity": "HIGH",
        "title": "Vibration and injection timing have no real data",
        "detail": "Two of the required channels are generated by the physics model.",
        "mitigation": "Tagged SIMULATED in the UI, in the API payload and in every export. The boundary is never blurred.",
    },
    {
        "id": 3,
        "tag": "OPERATIONAL DATA",
        "state": "GAP",
        "severity": "HIGH",
        "title": "No operational validation on DRDO / VRDE engine data",
        "detail": "Operational validation on a VRDE engine is outside the current prototype scope.",
        "mitigation": "Validated against NGAFID-MC labelled maintenance events and the published benchmark task.",
    },
    {
        "id": 4,
        "tag": "PHYSICS MODEL",
        "state": "SIMPLIFIED",
        "severity": "MEDIUM",
        "title": "The physics model is a simplification",
        "detail": (
            "JSBSim FGPiston is a validated open thermodynamic model but it is "
            "not a crank-angle-resolved CFD simulation."
        ),
        "mitigation": "Model-vs-data divergence is reported on the Validation page rather than hidden.",
    },
    {
        "id": 5,
        "tag": "RUL BENCHMARK",
        "state": "COARSE",
        "severity": "MEDIUM",
        "title": "The published RUL benchmark is coarse",
        "detail": "The NGAFID benchmark task is P(RUL > 2 days), a binary serviceability question.",
        "mitigation": "Reported as published. No continuous hours-remaining curve is invented.",
    },
    {
        "id": 6,
        "tag": "LIVE FLIGHT",
        "state": "OUT OF SCOPE",
        "severity": "MEDIUM",
        "title": "'Real-time' means near-real-time on replayed flights",
        "detail": (
            "The physics model runs faster than 1 Hz so lockstep is genuinely "
            "achievable, but the demonstration uses replayed flights, not a live aircraft."
        ),
        "mitigation": "Live aircraft demonstration is declared out of scope.",
    },
    {
        "id": 7,
        "tag": "REAL UAV DATA",
        "state": "GAP",
        "severity": "LOW",
        "title": "No CAN bus hardware",
        "detail": "The SocketCAN interface is implemented and demonstrable over the vcan0 virtual device.",
        "mitigation": "The code path is real; only the wire is virtual.",
    },
    {
        "id": 8,
        "tag": "VALIDATION SET",
        "state": "GAP",
        "severity": "LOW",
        "title": "Single engine type in the corpus",
        "detail": "Generalisation across engine families is unproven.",
        "mitigation": "Feature layer is engine-configurable; reported as a limitation on generalisation.",
    },
]

DEPLOYMENT_PHASES = [
    {"phase": "PHASE 01", "title": "Open-data validation", "state": "IN PROGRESS",
     "detail": "NGAFID-MC replay, residual loop, benchmark reproduction."},
    {"phase": "PHASE 02", "title": "Test-rig validation", "state": "PLANNED",
     "detail": "Same data contract against DRDO / VRDE test-rig instrumentation."},
    {"phase": "PHASE 03", "title": "Classified-data retraining", "state": "PLANNED",
     "detail": "Retrain in place at VRDE. No application code change required."},
    {"phase": "PHASE 04", "title": "Hardware-in-the-loop", "state": "PLANNED",
     "detail": "Physical CAN bus, engine controller in loop, edge residual path."},
    {"phase": "PHASE 05", "title": "Operational evaluation", "state": "PLANNED",
     "detail": "Ground control station integration and flight-line trial."},
]

OUT_OF_SCOPE = [
    ("Federated learning", "Requires multiple data holders", "Future work - architecture supports it"),
    ("Secure telemetry / encryption layer", "Not the core contribution", "Future work - deployment concern"),
    ("Onboard edge deployment on real hardware", "No hardware budget; category is software",
     "Edge / GCS split is shown in the architecture"),
    ("3D engine visualisation", "Decoration", "Explicitly rejected"),
    ("Mobile application", "No user need for a ground control station", "Explicitly rejected"),
    ("Public cloud deployment", "Defence data does not go to public cloud",
     "Deliberately rejected - on-premise is a requirement"),
]
