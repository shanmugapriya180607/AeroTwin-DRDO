"""REST API surface."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..core.constants import (AIRWORTHINESS_NOTICE, CHANNELS, DATASET_NGAFID,
                              DEPLOYMENT_PHASES, ENGINE, FAILURE_MODES, LIMITATIONS,
                              OUT_OF_SCOPE, REJECTED_DATASETS)
from ..analytics.calibration import calibrator
from ..core.eventlog import event_log
from ..ml import feature_engineering
from ..ml.anomaly_model import MIN_TRAIN_SAMPLES, SKLEARN_AVAILABLE, anomaly_model
from ..ml.predict import predict_engine_state
from ..ml.preprocessing import DATA_DICTIONARY, DATA_DICTIONARY_NOTE, ingest_report
from ..mission import route as mission_route
from ..service import TICK_INTERVAL, service

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------
# System
# --------------------------------------------------------------------------

@router.get("/system/status")
def system_status() -> dict:
    return service.system_status()


@router.get("/system/log")
def system_log(limit: int = Query(120, ge=1, le=600), level: str | None = None) -> dict:
    return {"events": event_log.tail(limit=limit, level=level)}


@router.get("/system/architecture")
def architecture() -> dict:
    return {
        "lanes": [
            {
                "id": "sources", "title": "DATA SOURCES",
                "nodes": [
                    # The sub-label follows the corpus that is mounted: the
                    # bundled flights are a format sample, not flight data.
                    {"id": "ngafid", "label": "NGAFID-MC",
                     "sub": ("REAL FLIGHT DATA"
                             if service.ngafid_status()["mode"] == "REAL"
                             else "DEMO CORPUS"),
                     "state": service.ngafid_status()["mode"]},
                    {"id": "jsbsim", "label": "JSBSim FGPiston", "sub": "PHYSICS MODEL",
                     "state": "ACTIVE"},
                    {"id": "can", "label": "LIVE CAN", "sub": "DEPLOYMENT INTERFACE",
                     "state": "INTERFACE READY"},
                ],
            },
            {
                "id": "core", "title": "TWIN CORE",
                "nodes": [
                    {"id": "ingest", "label": "Data Ingestion", "sub": "1 Hz contract", "state": "ACTIVE"},
                    {"id": "replay", "label": "Flight Replay", "sub": "lockstep clock", "state": "ACTIVE"},
                    {"id": "physics", "label": "Physics Model", "sub": "FGPiston class", "state": "RUNNING"},
                    {"id": "residual", "label": "Residual Engine", "sub": "per channel, per cylinder",
                     "state": "ACTIVE"},
                    {"id": "estimator", "label": "State Estimation", "sub": "feedback to model",
                     "state": service.runtime.estimator.status.state},
                ],
            },
            {
                "id": "analytics", "title": "ANALYTICS",
                "nodes": [
                    {"id": "anomaly", "label": "Anomaly Detection", "sub": "on residuals", "state": "ACTIVE"},
                    {"id": "health", "label": "Health Index", "sub": "per cylinder first", "state": "ACTIVE"},
                    {"id": "rul", "label": "RUL", "sub": DATASET_NGAFID["benchmark_task"], "state": "ACTIVE"},
                    {"id": "calibration", "label": "Calibration", "sub": "confidence + abstention",
                     "state": "ACTIVE"},
                    {"id": "explain", "label": "Explainability", "sub": "feature attribution",
                     "state": "ACTIVE"},
                ],
            },
            {
                "id": "output", "title": "OUTPUT",
                "nodes": [
                    {"id": "gcs", "label": "Ground Station", "sub": "this interface", "state": "ACTIVE"},
                    {"id": "advisory", "label": "Maintenance Advisory", "sub": "with evidence trail",
                     "state": "ACTIVE"},
                    {"id": "simulation", "label": "Mission Simulation", "sub": "four conditions",
                     "state": "ACTIVE"},
                    {"id": "deploy", "label": "Deployment", "sub": "on-premise, air-gapped",
                     "state": "DOCUMENTED"},
                ],
            },
        ],
        "feedback": {
            "from": "estimator", "to": "physics",
            "label": "STATE FEEDBACK",
            "detail": (
                "Volumetric efficiency, cooling effectiveness and per-cylinder trim "
                "are estimated online and fed back to re-tune the model. Without "
                "this arm the system would be a simulation running next to a sensor "
                "feed, not a twin."
            ),
        },
        "deployment_chain": [
            {"id": "uav", "label": "UAV", "sub": "ECU / FADEC"},
            {"id": "edge", "label": "EDGE", "sub": "residual + threshold safety"},
            {"id": "link", "label": "SECURE TELEMETRY PATH", "sub": "CAN → datalink"},
            {"id": "gcs", "label": "GROUND CONTROL STATION", "sub": "operator interface"},
            {"id": "twin", "label": "LOCAL DIGITAL TWIN", "sub": "physics + analytics"},
            {"id": "db", "label": "LOCAL DATABASE", "sub": "on-premise time series"},
        ],
        "deployment_tags": ["ON-PREMISE", "AIR-GAPPED READY", "NO CLOUD", "NO EXTERNAL AI"],
    }


class DatalinkRequest(BaseModel):
    connected: bool


@router.post("/system/datalink")
def set_datalink(request: DatalinkRequest) -> dict:
    service.set_datalink(request.connected)
    return service.datalink_state()


# --------------------------------------------------------------------------
# Mission
# --------------------------------------------------------------------------

@router.get("/mission/current")
def mission_current() -> dict:
    return service.mission_frame()


@router.get("/mission/sector")
def mission_sector() -> dict:
    return mission_route.sector()


@router.get("/mission/profiles")
def mission_profiles() -> dict:
    return {"profiles": service.profile_catalogue()}


# --------------------------------------------------------------------------
# Engine
# --------------------------------------------------------------------------

@router.get("/engine/status")
def engine_status() -> dict:
    return service.engine_summary()


@router.get("/engine/cylinders")
def engine_cylinders() -> dict:
    return {
        "cylinders": [c.as_dict() for c in service.runtime.cylinders],
        "asymmetry": service.runtime.cylinder_asymmetry(),
        "limits": {
            "cht_caution_c": ENGINE["cht_caution_c"],
            "cht_redline_c": ENGINE["cht_redline_c"],
            "egt_redline_c": ENGINE["egt_redline_c"],
        },
        "note": (
            "A failing cylinder shows up as asymmetry between the four channels, "
            "not as a change in the average."
        ),
    }


@router.get("/engine/comparison")
def engine_comparison() -> dict:
    """Expected vs actual, side by side. Reveals the affected cylinder at a glance."""
    tick = service.runtime.current
    if tick is None:
        return {"rows": []}
    rows = []
    for key, residual in tick.residuals.items():
        rows.append({
            "channel": key,
            "label": next((c["label"] for c in CHANNELS if c["key"] == key), key),
            "unit": residual.unit,
            "expected": round(residual.expected, 1),
            "actual": round(residual.observed, 1),
            "residual": round(residual.residual, 1),
            "normalised": round(residual.normalised, 2),
            "drift": round(residual.ewma, 2),
            "provenance": next(
                (c["provenance"] for c in CHANNELS if c["key"] == key), "REAL"),
        })
    return {"rows": rows, "regime": tick.regime, "phase": tick.phase, "t": round(tick.t, 1)}


# --------------------------------------------------------------------------
# Telemetry and residuals
# --------------------------------------------------------------------------

@router.get("/telemetry/latest")
def telemetry_latest() -> dict:
    frame = service.telemetry_frame()
    if not frame:
        raise HTTPException(status_code=503, detail="Telemetry not yet available")
    return frame


@router.get("/telemetry/channels")
def telemetry_channels() -> dict:
    return service.provenance()


@router.get("/telemetry/series")
def telemetry_series(
    channel: str = Query(..., description="Residual channel key"),
    limit: int = Query(600, ge=10, le=5400),
) -> dict:
    if channel not in service.runtime.residuals.channels:
        raise HTTPException(status_code=404, detail=f"Unknown channel {channel}")
    return {"channel": channel, "points": service.runtime.series(channel, limit)}


@router.get("/residuals")
def residuals() -> dict:
    frame = service.residual_frame()
    if not frame:
        raise HTTPException(status_code=503, detail="Residuals not yet available")
    return frame


@router.get("/twin/state")
def twin_state() -> dict:
    runtime = service.runtime
    return {
        "pipeline": [
            {"id": "telemetry", "label": "TELEMETRY",
             "state": "1 Hz" if service.datalink else "HOLD",
             "active": service.datalink},
            {"id": "physics", "label": "PHYSICS MODEL", "state": "RUNNING", "active": True},
            {"id": "expected", "label": "EXPECTED STATE", "state": "COMPUTED", "active": True},
            {"id": "actual", "label": "ACTUAL STATE", "state": "MEASURED", "active": service.datalink},
            {"id": "residual", "label": "RESIDUAL", "state": "ACTIVE", "active": True},
            {"id": "estimation", "label": "STATE ESTIMATION",
             "state": runtime.estimator.status.state, "active": True},
            {"id": "diagnostics", "label": "DIAGNOSTICS",
             "state": "ACTIVE" if service.datalink else "PAUSED", "active": service.datalink},
        ],
        "sync_pct": round(runtime.sync_pct, 2),
        "model": runtime.model_meta(),
        "estimator": runtime.estimator.snapshot(),
        "physics_inputs": (runtime.current.inputs if runtime.current else {}),
        "operating_point": {
            "rpm": round(runtime.current.channels.get("rpm", 0.0)) if runtime.current else 0,
            "map_inhg": round(runtime.current.channels.get("map_inhg", 0.0), 2) if runtime.current else 0,
            "altitude_ft": round(runtime.current.inputs.get("altitude_ft", 0.0)) if runtime.current else 0,
            "oat_c": round(runtime.current.inputs.get("oat_c", 0.0), 1) if runtime.current else 0,
            "ias_kt": round(runtime.current.inputs.get("ias_kt", 0.0), 1) if runtime.current else 0,
            "power_hp": round(runtime.current.power_hp, 1) if runtime.current else 0,
            "power_pct": round(runtime.current.power_fraction * 100, 1) if runtime.current else 0,
        },
        "fidelity_statement": (
            "JSBSim FGPiston is a validated open thermodynamic model, not a "
            "crank-angle-resolved CFD simulation. Model divergence is reported "
            "on the Validation page."
        ),
    }


# --------------------------------------------------------------------------
# Analytics
# --------------------------------------------------------------------------

@router.get("/anomalies")
def anomalies() -> dict:
    return service.alert_frame()


@router.get("/anomalies/{anomaly_id}/explain")
def anomaly_explain(anomaly_id: str) -> dict:
    explanation = service.explanation(anomaly_id)
    if explanation is None:
        raise HTTPException(status_code=404, detail=f"Unknown anomaly {anomaly_id}")
    return explanation


@router.get("/prediction")
def prediction() -> dict:
    runtime = service.runtime
    prognosis = runtime.prognosis.as_dict() if runtime.prognosis else None
    history = [
        {"flight_id": r.flight_id, "health": round(r.health_index, 1),
         "profile_id": r.profile_id, "status": r.status}
        for r in runtime.flights
    ]
    return {
        "health_index": round(runtime.health_index, 1),
        "history": history,
        "prognosis": prognosis,
        "benchmark": {
            "task": DATASET_NGAFID["benchmark_task"],
            "dataset": DATASET_NGAFID["id"],
            "detail": (
                "The published benchmark task is binary serviceability. No "
                "continuous hours-remaining figure is produced, because none is "
                "validated behind this prototype."
            ),
        },
        "airworthiness_notice": AIRWORTHINESS_NOTICE,
    }


@router.get("/maintenance")
def maintenance() -> dict:
    return {
        "advisories": [a.as_dict() for a in service.runtime.advisories],
        "engine_state": service.runtime.engine_state_label,
        "reason": service.runtime.engine_state_reason,
        "failure_modes": FAILURE_MODES,
    }


@router.get("/validation")
def validation() -> dict:
    report = service.validation
    return {
        "report": report.as_dict() if report else {"status": "RUNNING"},
        "calibration": calibrator.as_dict(),
        "dataset": DATASET_NGAFID,
        "rejected_datasets": REJECTED_DATASETS,
        "limitations": LIMITATIONS,
        "out_of_scope": [
            {"item": item, "why": why, "presented_as": presented}
            for item, why, presented in OUT_OF_SCOPE
        ],
        "deployment_phases": DEPLOYMENT_PHASES,
        "domain_gap": {
            "from": "Cessna 172 / Lycoming IO-360",
            "bridge": "Same engine class: 4-cylinder horizontally opposed, ~180 hp, air-cooled, fuel-injected",
            "to": "MALE UAV aero piston engine",
            # Two words each. The console renders these as tags, and a tag that
            # needs a sentence to be read is not a tag.
            "transfers": [
                {"tag": "THERMODYNAMICS", "detail": "Cycle and combustion behaviour"},
                {"tag": "EGT / CHT", "detail": "Per-cylinder instrumentation and its meaning"},
                {"tag": "FAILURE MODES", "detail": "Valve distress, head cracking, detonation, bearing wear"},
                {"tag": "COOLING", "detail": "Dependence on airspeed, altitude and ambient temperature"},
            ],
            "does_not_transfer": [
                {"tag": "DUTY CYCLE", "detail": "A MALE sortie is far longer than a training flight"},
                {"tag": "INSTALLATION", "detail": "Airframe, cowling and cooling-air path"},
                {"tag": "PROP WASH", "detail": "Pusher-propeller induced flow at the engine bay"},
                {"tag": "MISSION PROFILE", "detail": "Statistics and inactivity-driven corrosion"},
            ],
            "statement": (
                "Operational validation on DRDO / VRDE engine data is outside "
                "the current prototype scope."
            ),
        },
        "airworthiness_notice": AIRWORTHINESS_NOTICE,
        "ngafid": service.ngafid_status(),
    }


@router.get("/sources")
def sources() -> dict:
    return {"sources": service.all_sources(), "active": service.source_descriptor()}


# --------------------------------------------------------------------------
# Flights
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Dataset
# --------------------------------------------------------------------------

@router.get("/dataset/status")
def dataset_status() -> dict:
    """What is actually in the mounted corpus.

    Every figure is counted off the filesystem on each call - files, rows,
    valid rows, blank fields, sampling rate, label distribution - so the
    dataset page never shows a number that was written into the source.
    """
    return service.dataset_report()


@router.get("/dataset/validate")
def dataset_validate() -> dict:
    """Per-file validation, as PASS / WARNING / ERROR with the reason."""
    report = service.dataset_report()
    return {
        "status": report["status"],
        "detail": report["detail"],
        "files": [
            {
                "name": f["name"],
                "status": f["status"],
                "detail": f["detail"],
                "rows": f["rows"],
                "valid_rows": f["valid_rows"],
                "invalid_rows": f["invalid_rows"],
                "missing_values": f["missing_values"],
                "missing_columns": f["missing_columns"],
                "sample_rate_hz": f["sample_rate_hz"],
            }
            for f in report["files"]
        ],
        "unsupported": report["unsupported"],
        "capability_note": report["capability_note"],
    }


class ActivateRequest(BaseModel):
    file: str | None = None


@router.post("/dataset/activate")
def dataset_activate(request: ActivateRequest | None = None) -> dict:
    """Put the team corpus on the live seat."""
    return service.activate_team_corpus(request.file if request else None)


@router.post("/dataset/restore")
def dataset_restore() -> dict:
    """Hand the live seat back to the demonstration simulator."""
    return service.restore_default_source()


@router.get("/flights")
def flights() -> dict:
    return {"flights": service.flight_list()}


@router.get("/flights/{flight_id}")
def flight(flight_id: str) -> dict:
    record = service.flight_replay(flight_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown flight {flight_id}")
    return record


# --------------------------------------------------------------------------
# Simulation and demo control
# --------------------------------------------------------------------------

class SimulationRequest(BaseModel):
    profile_id: str = Field(default="ISR_STANDARD")
    altitude_ft: float | None = None
    oat_c: float | None = None
    ias_kt: float | None = None
    throttle_pct: float | None = None
    duration_s: float | None = None
    transients: bool = False


@router.post("/simulation/start")
def simulation_start(request: SimulationRequest) -> dict:
    custom = {
        "altitude_ft": request.altitude_ft if request.altitude_ft is not None else 15000,
        "oat_c": request.oat_c if request.oat_c is not None else 20,
        "ias_kt": request.ias_kt if request.ias_kt is not None else 88,
        "throttle_pct": request.throttle_pct if request.throttle_pct is not None else 78,
        "duration_s": request.duration_s if request.duration_s is not None else 23400,
        "transients": request.transients,
    }
    result = service.run_mission_simulation(request.profile_id, custom)
    return result.as_dict()


@router.post("/simulation/stop")
def simulation_stop() -> dict:
    return {"stopped": True}


@router.get("/simulation/{run_id}")
def simulation_get(run_id: str) -> dict:
    result = service.simulations.get(run_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown simulation {run_id}")
    return result.as_dict()


class SpeedRequest(BaseModel):
    time_scale: float


@router.post("/replay/speed")
def replay_speed(request: SpeedRequest) -> dict:
    service.set_speed(request.time_scale)
    return {"time_scale": service.time_scale}


@router.post("/replay/pause")
async def replay_pause() -> dict:
    """Hold the replay, and report exactly where it stopped.

    The index matters. The console pauses optimistically so the interface is
    held the instant the button is pressed, which leaves it a fraction of a
    tick behind the server; the twin is holding at *this* sample, and that is
    the one the operator has to be looking at.

    Two details make the number trustworthy. It is read *after* yielding long
    enough for the tick already in progress to finish, so it is not a reading
    taken mid-batch. And it comes off `runtime.current` rather than the
    service's sample counter, which is the same object `/telemetry/latest`
    reports from - so the index the console settles onto and the frame it
    displays are the same sample by construction, not by coincidence.
    """
    service.pause()
    await asyncio.sleep(TICK_INTERVAL * 1.5)
    return {"paused": True, **_held_position()}


def _held_position() -> dict:
    tick = service.runtime.current
    t = float(tick.t) if tick else float(service._sim_t)
    return {"t": round(t, 1), "index": int(t)}


@router.post("/replay/resume")
def replay_resume() -> dict:
    service.resume()
    return {"paused": False, **_held_position()}


class StepRequest(BaseModel):
    samples: int = 1


@router.post("/replay/step")
def replay_step(request: StepRequest | None = None) -> dict:
    """Advance exactly N 1 Hz timesteps while held, then hold again."""
    result = service.step((request.samples if request else 1) or 1)
    # Same source as the pause position, for the same reason.
    return {**result, **_held_position()}


@router.post("/replay/stop")
def replay_stop() -> dict:
    """Hold the replay and mark the sortie stopped. State is kept."""
    return service.stop_stream()


@router.post("/replay/reset")
def replay_reset() -> dict:
    """Cold restart: rewind the source and clear every derived quantity."""
    return service.reset_run()


class SeekRequest(BaseModel):
    t: float


@router.post("/replay/seek")
def replay_seek(request: SeekRequest) -> dict:
    service.seek(request.t)
    return {"t": request.t}


# --------------------------------------------------------------------------
# ML layer
# --------------------------------------------------------------------------

@router.get("/ml/status")
def ml_status() -> dict:
    """Model card for the learned half of the analytics stack."""
    return {
        "learned_model": anomaly_model.status(),
        "baseline_model": {
            "name": "PHYSICS RESIDUAL GLM",
            "supervision": "TRANSPARENT / HAND-WEIGHTED",
            "state": "ACTIVE",
            "input": "RESIDUAL FEATURES (observed - physics expected)",
            "note": (
                "Built first on purpose. A learned model that cannot beat an "
                "interpretable baseline is a finding, not a failure."
            ),
        },
        "features": feature_engineering.describe(),
        "fusion": {
            "weight_baseline": 0.65,
            "weight_learned": 0.35,
            "rule": (
                "An untrained or unavailable learned model contributes zero. "
                "Disagreement between the two detectors is published, not "
                "averaged away."
            ),
        },
        "fault_classification": {
            "state": "INSUFFICIENT LABEL SUPPORT",
            "detail": (
                "NGAFID-MC labels 2,111 unplanned maintenance events across 36 "
                "issue types at the FLIGHT level. There is no per-cylinder, "
                "per-second fault label anywhere in the corpus, so a supervised "
                "per-cylinder classifier would have to invent its own targets. "
                "Diagnosis therefore runs on unsupervised residual anomaly "
                "detection plus a named physical mechanism, and the mechanism "
                "is always reported as LIKELY CONTRIBUTING, never as confirmed."
            ),
            "what_would_change_it": (
                "A labelled test-rig campaign - induced valve distress, plug "
                "fouling, cooling-baffle damage - through the same adapter."
            ),
        },
        "environment": {
            "sklearn": SKLEARN_AVAILABLE,
            "required_train_samples": MIN_TRAIN_SAMPLES,
        },
    }


@router.get("/data/dictionary")
def data_dictionary() -> dict:
    return {
        "channels": DATA_DICTIONARY,
        "note": DATA_DICTIONARY_NOTE,
        "ingest": ingest_report(),
        "adapter_contract": {
            "interface": "DataSource",
            "methods": ["descriptor", "reset", "next_frame"],
            "frame": {
                "t": "seconds since flight start",
                "channels": "channel key -> value, at 1 Hz",
                "inputs": "throttle, mixture, altitude_ft, oat_c, ias_kt",
                "phase": "mission phase label",
            },
            "implementations": [
                "NgafidReplaySource - real corpus",
                "SyntheticFlightSource - demo telemetry, tagged DEMO",
                "SocketCanSource - live CAN deployment path",
            ],
            "note": (
                "Anything satisfying this interface drops in without a change "
                "downstream. That is the answer to data that cannot leave its "
                "own facility."
            ),
        },
    }


@router.post("/data/dictionary/refresh")
def data_dictionary_refresh() -> dict:
    return {"ingest": ingest_report(refresh=True)}


class PredictRequest(BaseModel):
    channels: dict[str, float] | None = None
    inputs: dict[str, float] | None = None


@router.post("/predict")
def predict(request: PredictRequest | None = None) -> dict:
    """The deployment entry point.

    With a body, scores that observation against the physics model. Without
    one, returns the twin's verdict on the live tick.
    """
    payload = None
    if request and (request.channels or request.inputs):
        payload = {"channels": request.channels or {}, "inputs": request.inputs or {}}
    return predict_engine_state(payload)


@router.get("/predict")
def predict_live() -> dict:
    return predict_engine_state(None)


@router.post("/demo/start")
def demo_start() -> dict:
    return service.start_demo()


@router.post("/demo/stop")
def demo_stop() -> dict:
    service.stop_demo()
    return {"demo": False}
