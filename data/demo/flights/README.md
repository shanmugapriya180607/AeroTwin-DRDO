# Demo corpus

Three sorties in **NGAFID / Garmin G1000 column naming**, bundled so the ingest
adapter can be exercised without downloading the 5.4 GB reference corpus.

**This is a sample of the FORMAT, not of the data.** It is synthetic. It is
reported as `DEMO` everywhere it surfaces — the source badge, the ingest
report, and every frame the replay produces. It is not operational data from
any organisation, and nothing in the product presents it as such.

It exists to demonstrate the property the adapter layer is for: the twin core
reads a *contract*, not a file. Swapping the corpus changes nothing downstream.

## Mounting a real corpus

Point `AEROTWIN_NGAFID_DIR` at a directory of NGAFID-MC Parquet or CSV flight
files:

```bash
export AEROTWIN_NGAFID_DIR=/path/to/ngafid
```

The variable takes precedence over this directory, the source badge flips from
`DEMO` to `REAL`, and nothing else changes.
