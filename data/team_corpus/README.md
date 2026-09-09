# Team engine-telemetry corpus

Source: [`MONISHA-tech316/aerotwin-person1`](https://github.com/MONISHA-tech316/aerotwin-person1)

## Provenance — read this first

**This data is generated, not measured.** It is produced by
`telemetry_generator.py` in the source repository, which adds Gaussian noise to
fixed baselines for three regimes. It is tagged `SIMULATED` everywhere it
appears in AEROTWIN, and the `state` / `fault` columns are the generator's own
ground truth — not maintenance findings on real hardware.

| File | Rows | Rate | Ground truth |
|---|---:|---:|---|
| `normal.csv` | 2,000 | 1 Hz | `NONE` |
| `degradation.csv` | 1,000 | 1 Hz | `MECHANICAL_DEGRADATION` |
| `faults.csv` | 1,200 | 1 Hz | `OVERHEATING`, `VIBRATION`, `PRESSURE_DROP`, `MECHANICAL_DEGRADATION` (300 each) |

## Schema

The generator commits to this column set ("agreed Day-1 contract — do not
rename these columns"):

```
timestamp, rpm, temperature, pressure, vibration,
load, fuel_flow, altitude, ambient_temperature, state, fault
```

## How AEROTWIN reads it

[`backend/app/sources/team_corpus.py`](../../backend/app/sources/team_corpus.py)
implements the standard `DataSource` contract over these files, with the unit
conversions documented in that module and rendered on the **Dataset** screen.
The original row is preserved on every frame, so the conversion can always be
checked against the source.

## What it cannot support

There is one bulk `temperature` column, not four CHTs and four EGTs. Per-cylinder
localisation — the part of AEROTWIN that names a cylinder — has nothing to
localise with here, and the adapter reports that gap rather than synthesising
the missing channels.

The engine it was generated for also runs at ~4,800 rpm, well above the
calibrated ceiling of AEROTWIN's physics model (Lycoming IO-360 class, rated
2,700 rpm). Replaying it therefore puts the twin into `MODEL ABSTENTION` with
that reason stated — which is the intended behaviour, and a live demonstration
of the envelope check.

## Pointing elsewhere

```bash
export AEROTWIN_TEAM_CORPUS_DIR=/path/to/csvs
```
