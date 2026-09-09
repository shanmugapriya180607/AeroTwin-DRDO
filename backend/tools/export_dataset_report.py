"""
Export the corpus report as a static file for backend-less deployments.

The console is deployable two ways: served by the ground station, or as a
static bundle on a host with no Python behind it at all. In the second case
`/api/dataset/status` has nobody to answer it, and the dataset page had nothing
to show but BACKEND UNREACHABLE - which reads as a broken build rather than as
the honest statement it is.

So the same report the API serves is also written to disk at build time. The
figures are identical because they come from the same function over the same
files; the only difference is *when* they were counted, and the page says so
rather than passing a build-time snapshot off as a live inspection.

    python -m tools.export_dataset_report        (from backend/)
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.sources.team_corpus import corpus_report  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "frontend" / "public" / "dataset-report.json"


def main() -> int:
    report = corpus_report()
    # The two fields that keep the snapshot honest about being one.
    report["snapshot"] = True
    report["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # Live-seat state is a property of a running backend, not of the corpus.
    report["active"] = False
    report["active_source"] = None

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(
        f"{OUT.relative_to(Path.cwd()) if OUT.is_relative_to(Path.cwd()) else OUT}: "
        f"{report['file_count']} files, {report['rows']:,} rows, status {report['status']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
