# Sample corpus

One flight file in the **NGAFID / Garmin G1000 column naming**, generated so the
ingest adapter can be exercised without downloading the 5.4 GB reference corpus.

**This is a sample of the FORMAT, not of the data.** It is synthetic and is
reported as such by the ingest report. It exists to demonstrate that the twin
core reads a contract rather than a file, which is the property that lets an
operator swap in their own data without changing anything downstream.

Mount it:

```bash
export AEROTWIN_NGAFID_DIR="$(pwd)/backend/sample_corpus"
```

Then open **Data & Models** — the ingest report shows which columns mapped,
which are absent, and the measured null rate and range of each.

To use the real corpus instead, point the same variable at a directory of
NGAFID-MC Parquet or CSV flight files. Nothing else changes.
