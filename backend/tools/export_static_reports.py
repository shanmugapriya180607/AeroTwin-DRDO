"""
Export the reference screens' data as static files, for backend-less hosting.

AEROTWIN deploys two ways: served by the ground station, or as a static bundle
on a host with no Python behind it. The console itself works either way - it
falls back to a reduced model in the browser and labels everything DEMO - but
four screens read the backend directly and had nothing to show without one:

    Dataset          what corpus is mounted, counted
    Data & Models    the data dictionary, the ingest report, the model cards
    Validation       the harness metrics, calibration, limitations
    Architecture     the system graph

Showing BACKEND UNREACHABLE on all four reads as a broken build rather than as
the accurate statement it is. So the same payloads the API serves are written
to disk here, and the pages fall back to them.

The figures are identical because they come from the same functions over the
same files. What differs is *when* they were produced, and each page says
BUILD SNAPSHOT rather than passing one off as a live reading. Anything that is
a property of a *running* twin - the live seat, the current tick, whether the
detector has trained yet - is stripped rather than frozen, because a frozen
copy of a live value is exactly the kind of thing this project must not ship.

    cd backend && python -m tools.export_static_reports
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api import routes                                   # noqa: E402
from app.service import service                              # noqa: E402
from app.sources.team_corpus import corpus_report            # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "reports"

#: How long to let the boot sequence run before giving up on it. The harness
#: replays flight history through the twin and fits the detector, so this is
#: not instant.
BOOT_TIMEOUT_S = 180


def _stamp(payload: dict) -> dict:
    """Mark a payload as a snapshot. Both fields are load-bearing: the console
    renders a BUILD SNAPSHOT badge off `snapshot` and shows `generated_at`."""
    payload["snapshot"] = True
    payload["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return payload


async def _boot() -> None:
    print("booting the twin (replaying history, fitting the detector)...", flush=True)
    await service.startup()
    waited = 0.0
    while service.boot.status != "READY" and waited < BOOT_TIMEOUT_S:
        await asyncio.sleep(1.0)
        waited += 1.0
    if service.boot.status != "READY":
        raise RuntimeError(f"boot did not complete in {BOOT_TIMEOUT_S}s "
                           f"(status {service.boot.status})")
    print(f"  ready after {waited:.0f}s", flush=True)


async def main() -> int:
    await _boot()

    dataset = _stamp(corpus_report())
    # Which source holds the live seat is a property of a running backend, not
    # of the corpus. Left null rather than frozen to a value that will be wrong.
    dataset["active"] = False
    dataset["active_source"] = None

    reports: dict[str, dict] = {
        "dataset": dataset,
        "dictionary": _stamp(routes.data_dictionary()),
        "ml": _stamp(routes.ml_status()),
        "validation": _stamp(routes.validation()),
        "architecture": _stamp(routes.architecture()),
    }

    OUT.mkdir(parents=True, exist_ok=True)
    for name, payload in reports.items():
        path = OUT / f"{name}.json"
        path.write_text(json.dumps(payload, indent=1, default=str), encoding="utf-8")
        print(f"  {path.name:<18} {path.stat().st_size / 1024:6.1f} KB", flush=True)

    # The dataset report keeps its original location too: it shipped there
    # first and the Dataset screen already reads it.
    legacy = OUT.parent / "dataset-report.json"
    legacy.write_text(json.dumps(dataset, indent=1, default=str), encoding="utf-8")
    print(f"  {legacy.name:<18} {legacy.stat().st_size / 1024:6.1f} KB", flush=True)

    await service.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
