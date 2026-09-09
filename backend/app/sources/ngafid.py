"""
NGAFID-MC replay source - the real-data path.

NGAFID-MC (Zenodo 6624956, CC-BY-4.0) is 28,935 Cessna 172 flights, 31,177
flight hours, Lycoming IO-360, 23 channels at 1 Hz, 5.4 GB, with 2,111
labelled unplanned maintenance events.

The corpus is not bundled with this repository. Point ``AEROTWIN_NGAFID_DIR``
at a directory of Parquet or CSV flight files and this source becomes
available; until then it reports ``available=False`` and the runtime falls
back to the clearly-tagged demo telemetry simulator.

Column mapping is table-driven so the loader accommodates the raw NGAFID
column names as well as the names used by the published loader notebooks.
"""

from __future__ import annotations

import csv
import os
from datetime import datetime, timezone
from pathlib import Path

from ..core.constants import DATASET_NGAFID
from ..core.constants import CHANNEL_BY_KEY
from .base import DataSource, SourceDescriptor, TelemetryFrame

# NGAFID / Garmin G1000 column aliases -> AeroTwin channel keys
COLUMN_ALIASES: dict[str, str] = {
    "E1 RPM": "rpm", "rpm": "rpm", "RPM": "rpm",
    "E1 MAP": "map_inhg", "map": "map_inhg", "MAP": "map_inhg",
    "E1 FFlow": "fuel_flow_gph", "fuel_flow": "fuel_flow_gph", "FFlow": "fuel_flow_gph",
    "E1 EGT1": "egt_1", "E1 EGT2": "egt_2", "E1 EGT3": "egt_3", "E1 EGT4": "egt_4",
    "egt1": "egt_1", "egt2": "egt_2", "egt3": "egt_3", "egt4": "egt_4",
    "E1 CHT1": "cht_1", "E1 CHT2": "cht_2", "E1 CHT3": "cht_3", "E1 CHT4": "cht_4",
    "cht1": "cht_1", "cht2": "cht_2", "cht3": "cht_3", "cht4": "cht_4",
    "E1 OilP": "oil_press_psi", "oil_press": "oil_press_psi", "OilP": "oil_press_psi",
    "E1 OilT": "oil_temp_c", "oil_temp": "oil_temp_c", "OilT": "oil_temp_c",
    "OAT": "oat_c", "oat": "oat_c",
    "AltMSL": "altitude_ft", "AltB": "altitude_ft", "altitude": "altitude_ft",
    "IAS": "ias_kt", "ias": "ias_kt",
    "Pitch": "_pitch", "Roll": "_roll",
}

REQUIRED = {"rpm", "cht_1", "cht_2", "cht_3", "cht_4", "egt_1", "egt_2", "egt_3", "egt_4"}


# The corpus bundled with the repository: three synthetic sorties in the same
# column naming as NGAFID-MC. It exists so the ingest path is exercised out of
# the box rather than reporting an unconfigured directory at a demonstration.
DEMO_CORPUS = Path(__file__).resolve().parents[3] / "data" / "demo" / "flights"


def _flight_files(root: Path) -> list[str]:
    try:
        return sorted(
            p.name for p in root.iterdir()
            if p.suffix.lower() in (".parquet", ".csv") and p.is_file()
        )
    except OSError:
        return []


def configured_dir() -> Path | None:
    """The operator's corpus, if AEROTWIN_NGAFID_DIR points at a real one."""
    raw = os.environ.get("AEROTWIN_NGAFID_DIR", "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    return path if path.is_dir() else None


def dataset_dir() -> Path | None:
    """
    Where flight files are read from.

    An operator corpus wins. With none configured this falls back to the demo
    corpus in the repository, which is the difference between a demonstration
    that works out of the box and one that opens on a configuration error.

    The fallback is never silent: `corpus_mode()` reports DEMO, the source
    descriptor carries provenance DEMO, and every frame it produces is tagged
    the same way. Nothing here can make synthetic data look measured.
    """
    configured = configured_dir()
    if configured is not None and _flight_files(configured):
        return configured
    if DEMO_CORPUS.is_dir() and _flight_files(DEMO_CORPUS):
        return DEMO_CORPUS
    return configured


def corpus_mode() -> str:
    """REAL (operator corpus), DEMO (bundled), or ABSENT."""
    configured = configured_dir()
    if configured is not None and _flight_files(configured):
        return "REAL"
    if DEMO_CORPUS.is_dir() and _flight_files(DEMO_CORPUS):
        return "DEMO"
    return "ABSENT"


def discover_flights() -> list[str]:
    root = dataset_dir()
    return _flight_files(root) if root is not None else []


class NgafidReplaySource(DataSource):
    """Replays one NGAFID-MC flight at 1 Hz against the shared data contract."""

    def __init__(self, filename: str | None = None) -> None:
        self.filename = filename
        self._rows: list[dict[str, float]] = []
        self._idx = 0
        self._flight_id = filename or "NGAFID"

    @property
    def descriptor(self) -> SourceDescriptor:
        mode = corpus_mode()
        real = mode == "REAL"
        return SourceDescriptor(
            id="NGAFID_REPLAY",
            label="NGAFID-MC REPLAY" if real else "DEMO CORPUS REPLAY",
            kind="REPLAY",
            # The provenance follows the corpus that is actually mounted. The
            # bundled sorties are synthetic and say so here, which is what every
            # badge downstream reads.
            provenance="REAL" if real else "DEMO",
            available=mode != "ABSENT",
            detail=(
                f"{DATASET_NGAFID['flights']:,} real {DATASET_NGAFID['aircraft']} flights, "
                f"{DATASET_NGAFID['flight_hours']:,} flight hours, "
                f"{DATASET_NGAFID['engine']}, {DATASET_NGAFID['sensors']} sensors at 1 Hz, "
                f"{DATASET_NGAFID['maintenance_events']:,} labelled unplanned maintenance "
                f"events. {DATASET_NGAFID['licence']}."
                if real else
                "Bundled demo corpus - synthetic flights in NGAFID column naming. "
                "Set AEROTWIN_NGAFID_DIR to a real corpus to switch to measured data."
            ),
        )

    # -- loading ------------------------------------------------------------

    def open(self, **kwargs) -> None:
        root = dataset_dir()
        if root is None:
            raise RuntimeError("NGAFID corpus directory is not configured")
        name = self.filename or (discover_flights() or [None])[0]
        if name is None:
            raise RuntimeError("No NGAFID flight files found")
        path = root / name
        self._flight_id = Path(name).stem
        self._rows = _load_parquet(path) if path.suffix.lower() == ".parquet" else _load_csv(path)
        if not self._rows:
            raise RuntimeError(f"No usable rows in {name}")
        missing = REQUIRED - set(self._rows[0])
        if missing:
            raise RuntimeError(f"Flight {name} is missing channels: {sorted(missing)}")
        self._idx = 0

    def read(self) -> TelemetryFrame | None:
        if self._idx >= len(self._rows):
            return None
        row = self._rows[self._idx]
        t = float(self._idx)
        self._idx += 1
        alt = row.get("altitude_ft", 0.0)
        ias = row.get("ias_kt", 0.0)
        oat = row.get("oat_c", 15.0)
        # A channel is only REAL if the mounted corpus is. Replaying the
        # bundled demo flights produces channels that exist in the contract but
        # were never measured, and every one of them says so from here on.
        measured = corpus_mode() == "REAL"
        return TelemetryFrame(
            t=t,
            wall_clock=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            flight_id=self._flight_id,
            source_id="NGAFID_REPLAY",
            phase=_infer_phase(alt, row.get("rpm", 0.0), ias),
            channels=row,
            provenance={
                k: (CHANNEL_BY_KEY[k]["provenance"] if measured else "DEMO")
                for k in row if k in CHANNEL_BY_KEY
            },
            inputs={
                # NGAFID does not publish a throttle channel; the induction
                # state is inverted from measured MAP and pressure altitude.
                "throttle": _invert_throttle(row.get("map_inhg", 20.0), alt, row.get("rpm", 2400.0)),
                "mixture": _infer_mixture(row.get("fuel_flow_gph", 8.0), row.get("rpm", 2400.0),
                                          row.get("map_inhg", 20.0)),
                "altitude_ft": alt,
                "oat_c": oat,
                "ias_kt": ias,
                "progress": self._idx / max(1, len(self._rows)),
            },
        )

    def __len__(self) -> int:
        return len(self._rows)


# --------------------------------------------------------------------------


def _normalise(row: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    for raw_key, value in row.items():
        key = COLUMN_ALIASES.get(str(raw_key).strip())
        if key is None or key.startswith("_"):
            continue
        try:
            out[key] = float(value)
        except (TypeError, ValueError):
            continue
    return out


def _load_csv(path: Path) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    with path.open("r", encoding="utf-8", errors="ignore", newline="") as fh:
        for raw in csv.DictReader(fh):
            norm = _normalise(raw)
            if REQUIRED <= set(norm):
                rows.append(norm)
    return rows


def _load_parquet(path: Path) -> list[dict[str, float]]:
    try:
        import polars as pl  # type: ignore

        frame = pl.read_parquet(path)
        return [r for r in (_normalise(d) for d in frame.iter_rows(named=True)) if REQUIRED <= set(r)]
    except ImportError:
        pass
    try:
        import pandas as pd  # type: ignore

        frame = pd.read_parquet(path)
        return [r for r in (_normalise(d) for d in frame.to_dict("records")) if REQUIRED <= set(r)]
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "Reading NGAFID Parquet requires polars (preferred) or pandas. "
            "pip install polars"
        ) from exc


def _invert_throttle(map_inhg: float, altitude_ft: float, rpm: float) -> float:
    from ..core.atmosphere import pressure_inhg

    p_amb = max(4.0, pressure_inhg(altitude_ft))
    loss = 1.2 * (rpm / 2700.0) ** 2
    plate = (map_inhg + loss) / p_amb
    return max(0.0, min(1.0, (plate - 0.13) / 0.87))


def _infer_mixture(fuel_flow_gph: float, rpm: float, map_inhg: float) -> float:
    """Recover the mixture lever position from measured fuel and air flow."""
    air_lb_hr = max(1.0, 1.427e-2 * map_inhg * rpm)
    phi = (fuel_flow_gph * 6.0) * 14.7 / air_lb_hr
    return max(0.0, min(1.0, (phi - 0.78) / 0.52))


def _infer_phase(altitude_ft: float, rpm: float, ias_kt: float) -> str:
    if rpm < 500:
        return "GROUND"
    if ias_kt < 35:
        return "GROUND"
    if altitude_ft < 1500:
        return "TAKEOFF"
    if altitude_ft < 9000:
        return "CLIMB"
    return "ISR LOITER"
