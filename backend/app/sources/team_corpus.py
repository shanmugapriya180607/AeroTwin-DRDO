"""
Adapter for the team engine-telemetry corpus (`aerotwin-person1`).

This is the second real implementation of the `DataSource` contract, and it
exists to prove the claim that contract is making: a corpus with a completely
different schema, different units and a different level of instrumentation
drops into the same live seat as everything else, and nothing downstream of
`base.TelemetryFrame` has to know.

WHAT THIS CORPUS IS
-------------------
Three CSV files produced by `data/telemetry_generator.py` in the team
repository: a normal regime, a degradation ramp, and four injected fault modes.
It is **generated, not measured** - the generator adds Gaussian noise to fixed
baselines - so every frame this adapter emits is tagged SIMULATED. It is never
presented as sensor data, and the label columns are the generator's own ground
truth rather than maintenance findings.

WHAT IT CAN AND CANNOT DRIVE
----------------------------
The corpus carries eight numeric channels and two label columns. Four of the
eight map onto AEROTWIN channels directly or by unit conversion. What it does
*not* carry is per-cylinder instrumentation: there is one bulk `temperature`,
not four CHTs and four EGTs.

That matters, and it is reported rather than papered over. The residual
pipeline runs on every channel this corpus supplies, but per-cylinder
localisation - the part of the product that says *cylinder 3* - has nothing to
localise with here. `unsupported_signals()` says so, the dataset page shows it,
and the adapter does not manufacture four cylinders out of one thermocouple.

UNIT DECISIONS
--------------
Each mapping below is a judgement about what the generator's baseline value
physically is, and each is recorded with its original column and factor so the
data dictionary can show the conversion rather than hide it:

  pressure    4.2 bar  x14.5038 -> 60.9 psi     oil pressure for this class
  temperature 78 C     as-is    -> oil temp     head temps run 150-250 C; 78 C
                                                is an oil temperature, and the
                                                OVERHEATING mode taking it to
                                                105-125 C fits that reading
  fuel_flow   12.5 kg/h /2.7255 -> 4.6 gph      avgas at 0.72 kg/L
  altitude    1500 m   x3.28084 -> 4921 ft
  ambient_temperature -> OAT, rpm -> rpm, vibration -> vibration, both direct

The original row is preserved on every frame under `raw`, so nothing here is
lossy and the conversion can always be checked against the source.
"""

from __future__ import annotations

import csv
import math
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .base import DataSource, SourceDescriptor, TelemetryFrame

# The environment variable that points at an alternative copy of the corpus.
# The three files are small enough to live in the repository, so unlike the
# 5.4 GB NGAFID corpus this one does not have to be mounted to work.
ENV_DIR = "AEROTWIN_TEAM_CORPUS_DIR"

REPO_DIR = Path(__file__).resolve().parents[3] / "data" / "team_corpus"

SOURCE_REF = "MONISHA-tech316/aerotwin-person1"

#: The schema the generator commits to, in its own words: "agreed Day-1
#: contract - do not rename these columns".
REQUIRED_COLUMNS = (
    "timestamp", "rpm", "temperature", "pressure", "vibration",
    "load", "fuel_flow", "altitude", "ambient_temperature", "state", "fault",
)

BAR_TO_PSI = 14.503773773
M_TO_FT = 3.280839895
#: Avgas at 0.72 kg/L, 3.78541 L per US gallon.
KGH_TO_GPH = 1.0 / (0.72 * 3.78541)


@dataclass(frozen=True)
class ChannelMapping:
    """One source column, and what it becomes."""

    source: str
    target: str
    factor: float
    offset: float
    source_unit: str
    target_unit: str
    note: str


MAPPINGS: tuple[ChannelMapping, ...] = (
    ChannelMapping("rpm", "rpm", 1.0, 0.0, "rpm", "rpm", "direct"),
    ChannelMapping("pressure", "oil_press_psi", BAR_TO_PSI, 0.0, "bar", "psi",
                   "oil pressure; 4.2 bar baseline is nominal for this engine class"),
    ChannelMapping("temperature", "oil_temp_c", 1.0, 0.0, "degC", "degC",
                   "bulk oil temperature; too low to be a cylinder head temperature"),
    ChannelMapping("fuel_flow", "fuel_flow_gph", KGH_TO_GPH, 0.0, "kg/h", "gph",
                   "avgas at 0.72 kg/L"),
    ChannelMapping("vibration", "vibration_g", 1.0, 0.0, "g", "g rms",
                   "generator units are declared as g"),
    ChannelMapping("ambient_temperature", "oat_c", 1.0, 0.0, "degC", "degC", "direct"),
    ChannelMapping("altitude", "altitude_ft", M_TO_FT, 0.0, "m", "ft", "direct"),
)

#: AEROTWIN channels this corpus has no column for. Reported, never invented.
UNSUPPORTED = (
    ("cht_1", "per-cylinder head temperature"),
    ("cht_2", "per-cylinder head temperature"),
    ("cht_3", "per-cylinder head temperature"),
    ("cht_4", "per-cylinder head temperature"),
    ("egt_1", "per-cylinder exhaust gas temperature"),
    ("egt_2", "per-cylinder exhaust gas temperature"),
    ("egt_3", "per-cylinder exhaust gas temperature"),
    ("egt_4", "per-cylinder exhaust gas temperature"),
    ("map_inhg", "manifold pressure"),
    ("ias_kt", "indicated airspeed"),
    ("inj_timing_deg", "injection timing"),
)


def corpus_dir() -> Path:
    """Where the corpus is. The environment wins; the repository copy is the
    fallback, so the adapter path is exercised out of the box."""
    override = os.environ.get(ENV_DIR, "").strip()
    if override:
        return Path(override).expanduser()
    return REPO_DIR


def discover_files() -> list[Path]:
    directory = corpus_dir()
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.glob("*.csv") if p.is_file())


def available() -> bool:
    return bool(discover_files())


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------

@dataclass
class FileReport:
    """What one file actually contains. Every number is counted, not assumed."""

    name: str
    rows: int = 0
    valid_rows: int = 0
    invalid_rows: int = 0
    missing_values: int = 0
    columns: list[str] | None = None
    missing_columns: list[str] | None = None
    sample_rate_hz: float | None = None
    duration_s: float | None = None
    first_timestamp: str | None = None
    last_timestamp: str | None = None
    labels: dict[str, int] | None = None
    states: dict[str, int] | None = None
    status: str = "PASS"
    detail: str = ""

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "rows": self.rows,
            "valid_rows": self.valid_rows,
            "invalid_rows": self.invalid_rows,
            "missing_values": self.missing_values,
            "columns": self.columns or [],
            "missing_columns": self.missing_columns or [],
            "sample_rate_hz": self.sample_rate_hz,
            "duration_s": self.duration_s,
            "first_timestamp": self.first_timestamp,
            "last_timestamp": self.last_timestamp,
            "labels": self.labels or {},
            "states": self.states or {},
            "status": self.status,
            "detail": self.detail,
        }


def _parse_timestamp(value: str) -> datetime | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        # A few plausible alternatives before giving up. The row is counted as
        # invalid rather than dropped silently if none of them parse.
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%H:%M:%S"):
            try:
                return datetime.strptime(value, fmt)
            except ValueError:
                continue
    return None


def inspect_file(path: Path) -> FileReport:
    """Read a file end to end and report what is in it.

    Deliberately not sampled: the whole point of the dataset page is that the
    figures on it were counted, and 2,000 rows is nothing to walk.
    """
    report = FileReport(name=path.name)
    try:
        with path.open("r", newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            columns = list(reader.fieldnames or [])
            report.columns = columns
            missing = [c for c in REQUIRED_COLUMNS if c not in columns]
            report.missing_columns = missing
            if missing:
                report.status = "ERROR"
                report.detail = f"missing columns: {', '.join(missing)}"
                return report

            labels: dict[str, int] = {}
            states: dict[str, int] = {}
            first: datetime | None = None
            last: datetime | None = None
            first_raw = last_raw = None

            for row in reader:
                report.rows += 1
                blanks = sum(1 for c in REQUIRED_COLUMNS if not (row.get(c) or "").strip())
                report.missing_values += blanks

                stamp = _parse_timestamp(row.get("timestamp", ""))
                numeric_ok = True
                for mapping in MAPPINGS:
                    try:
                        float(row[mapping.source])
                    except (TypeError, ValueError):
                        numeric_ok = False
                        break

                if stamp is None or not numeric_ok:
                    report.invalid_rows += 1
                    continue

                report.valid_rows += 1
                if first is None:
                    first, first_raw = stamp, row.get("timestamp")
                last, last_raw = stamp, row.get("timestamp")
                labels[row.get("fault", "?")] = labels.get(row.get("fault", "?"), 0) + 1
                states[row.get("state", "?")] = states.get(row.get("state", "?"), 0) + 1

            report.labels = labels
            report.states = states
            report.first_timestamp = first_raw
            report.last_timestamp = last_raw
            if first and last and report.valid_rows > 1:
                span = (last - first).total_seconds()
                report.duration_s = round(span, 1)
                if span > 0:
                    report.sample_rate_hz = round((report.valid_rows - 1) / span, 3)

            if report.invalid_rows:
                report.status = "WARNING"
                report.detail = f"{report.invalid_rows} unparseable rows skipped"
            elif report.missing_values:
                report.status = "WARNING"
                report.detail = f"{report.missing_values} blank fields"
    except OSError as exc:
        report.status = "ERROR"
        report.detail = str(exc)
    return report


def corpus_report() -> dict:
    """The whole corpus, counted. This is what the dataset page renders."""
    files = discover_files()
    directory = corpus_dir()
    reports = [inspect_file(p) for p in files]

    rows = sum(r.rows for r in reports)
    valid = sum(r.valid_rows for r in reports)
    invalid = sum(r.invalid_rows for r in reports)
    missing = sum(r.missing_values for r in reports)
    rates = [r.sample_rate_hz for r in reports if r.sample_rate_hz]

    labels: dict[str, int] = {}
    states: dict[str, int] = {}
    for r in reports:
        for key, count in (r.labels or {}).items():
            labels[key] = labels.get(key, 0) + count
        for key, count in (r.states or {}).items():
            states[key] = states.get(key, 0) + count

    if not files:
        status, detail = "UNAVAILABLE", f"No CSV files under {directory}"
    elif any(r.status == "ERROR" for r in reports):
        status, detail = "ERROR", "; ".join(r.detail for r in reports if r.status == "ERROR")
    elif any(r.status == "WARNING" for r in reports):
        status, detail = "WARNING", "; ".join(r.detail for r in reports if r.status == "WARNING")
    else:
        status, detail = "READY", ""

    return {
        "id": "TEAM_CORPUS",
        "label": "AEROTWIN TEAM CORPUS",
        "reference": SOURCE_REF,
        "directory": str(directory),
        "mounted": bool(files),
        "env_var": ENV_DIR,
        "status": status,
        "detail": detail,
        # Generated by a documented simulator, never measured. This is the one
        # field that must never drift.
        "provenance": "SIMULATED",
        # Stated in the operator's terms, not the repository's. The fact that
        # matters - that this is generated, not measured - is carried by the
        # SIMULATED provenance above and repeated here in words a reader who
        # has never seen the source tree can act on.
        "provenance_note": (
            "Generated telemetry, not measured flight data. Every value is "
            "tagged SIMULATED throughout the console."
        ),
        "files": [r.as_dict() for r in reports],
        "file_count": len(files),
        "rows": rows,
        "valid_rows": valid,
        "invalid_rows": invalid,
        "missing_values": missing,
        "sample_rate_hz": round(sum(rates) / len(rates), 3) if rates else None,
        "signals": len(MAPPINGS),
        "source_columns": list(REQUIRED_COLUMNS),
        "labels": labels,
        "states": states,
        "mapped": [
            {
                "source": m.source,
                "target": m.target,
                "source_unit": m.source_unit,
                "target_unit": m.target_unit,
                "factor": round(m.factor, 6),
                "note": m.note,
            }
            for m in MAPPINGS
        ],
        "unsupported": [
            {"channel": key, "reason": f"no {reason} column in this corpus"}
            for key, reason in UNSUPPORTED
        ],
        "capability_note": (
            "This corpus carries a single engine temperature rather than one "
            "per cylinder, so findings are reported at engine level."
        ),
    }


# --------------------------------------------------------------------------
# the source
# --------------------------------------------------------------------------

class TeamCorpusSource(DataSource):
    """Replay one file of the team corpus as 1 Hz frames.

    Rows that fail validation are skipped rather than emitted as zeros - a
    dropped sample is honest, a zeroed one manufactures a residual.
    """

    def __init__(self, path: Path, flight_id: str | None = None) -> None:
        self.path = Path(path)
        self.flight_id = flight_id or self.path.stem
        self._rows: list[dict] = []
        self._index = 0
        self._t0: datetime | None = None
        self.report: FileReport | None = None

    # -- contract -----------------------------------------------------------

    @property
    def descriptor(self) -> SourceDescriptor:
        rows = len(self._rows)
        return SourceDescriptor(
            id=f"TEAM_{self.path.stem.upper()}",
            label=f"TEAM CORPUS / {self.path.stem.upper()}",
            kind="REPLAY",
            provenance="SIMULATED",
            available=self.path.is_file(),
            detail=(
                f"{SOURCE_REF} / {self.path.name}"
                + (f" - {rows:,} samples" if rows else "")
                + ". Generated telemetry, tagged SIMULATED throughout. "
                "Engine-level instrumentation; no per-cylinder probes."
            ),
            rate_hz=1.0,
        )

    def open(self, **kwargs) -> None:
        if self._rows:
            self._index = 0
            return
        self.report = inspect_file(self.path)
        if self.report.status == "ERROR":
            raise ValueError(f"{self.path.name}: {self.report.detail}")

        with self.path.open("r", newline="", encoding="utf-8-sig") as handle:
            for row in csv.DictReader(handle):
                stamp = _parse_timestamp(row.get("timestamp", ""))
                if stamp is None:
                    continue
                try:
                    parsed = {m.source: float(row[m.source]) for m in MAPPINGS}
                except (TypeError, ValueError):
                    continue
                parsed["load"] = _safe_float(row.get("load"), 0.0)
                self._rows.append({
                    "stamp": stamp,
                    "values": parsed,
                    "state": (row.get("state") or "").strip(),
                    "fault": (row.get("fault") or "").strip(),
                    "raw": dict(row),
                })
        if not self._rows:
            raise ValueError(f"{self.path.name}: no valid rows")
        self._t0 = self._rows[0]["stamp"]
        self._index = 0

    def read(self) -> TelemetryFrame | None:
        if self._index >= len(self._rows):
            return None
        frame = self._frame(self._index)
        self._index += 1
        return frame

    def close(self) -> None:
        self._rows = []
        self._index = 0

    # -- helpers ------------------------------------------------------------

    def __len__(self) -> int:
        return len(self._rows)

    def seek(self, t: float) -> None:
        self._index = max(0, min(len(self._rows), int(round(t))))

    @property
    def labels(self) -> list[str]:
        """The generator's ground truth, in row order. Available for
        validation; never consulted by the detector."""
        return [r["fault"] for r in self._rows]

    def _frame(self, index: int) -> TelemetryFrame:
        row = self._rows[index]
        values = row["values"]
        stamp: datetime = row["stamp"]
        t = (stamp - self._t0).total_seconds() if self._t0 else float(index)

        channels: dict[str, float] = {}
        for mapping in MAPPINGS:
            channels[mapping.target] = values[mapping.source] * mapping.factor + mapping.offset

        load = max(0.0, min(100.0, values.get("load", 0.0)))
        altitude_ft = channels.get("altitude_ft", 0.0)
        oat_c = channels.get("oat_c", 15.0)

        # The twin needs the same control and ambient inputs the physics model
        # runs on. This corpus has no throttle column, so load fraction stands
        # in for it - stated here rather than presented as a measurement.
        inputs = {
            "throttle": load / 100.0,
            "mixture": 0.62,
            "altitude_ft": altitude_ft,
            "oat_c": oat_c,
            "ias_kt": _ias_from(altitude_ft, load),
        }

        return TelemetryFrame(
            t=round(t, 3),
            wall_clock=stamp.isoformat(timespec="seconds"),
            flight_id=self.flight_id,
            source_id=self.descriptor.id,
            phase=_phase_for(altitude_ft, load),
            channels=channels,
            inputs=inputs,
            # Every channel from this corpus is generated. No exceptions, and
            # no per-channel override that could quietly promote one to REAL.
            provenance={key: "SIMULATED" for key in channels},
        )


def _safe_float(value, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _ias_from(altitude_ft: float, load_pct: float) -> float:
    """A stand-in airspeed.

    The corpus has no airspeed column, and the cooling term in the physics
    model needs one. This is a declared derivation, not a measurement: it is
    reported as DERIVED, and the dataset page lists airspeed as unsupported.
    """
    density_ratio = max(0.35, (1 - 6.875e-6 * altitude_ft) ** 4.2561)
    return 70.0 + 0.45 * load_pct / max(0.6, math.sqrt(density_ratio))


def _phase_for(altitude_ft: float, load_pct: float) -> str:
    if altitude_ft < 500:
        return "GROUND"
    if load_pct > 85:
        return "CLIMB"
    if altitude_ft > 3000:
        return "CRUISE"
    return "TRANSIT"
