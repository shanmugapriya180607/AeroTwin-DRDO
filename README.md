# AEROTWIN

### UAV Piston Engine Digital Twin & Predictive Maintenance Platform

AEROTWIN is a Digital Twin platform for monitoring UAV piston-engine health by
combining telemetry, physics-informed modelling, anomaly detection and
predictive maintenance visualization.

A physics model of the engine runs in lockstep with the engine itself. The
difference between what physics expects and what the sensors report — the
**residual** — is what everything downstream reads.

> ### 📄 [**Download the full technical documentation (PDF, 16 pages)**](docs/AEROTWIN-Technical-Documentation.pdf)
>
> How every layer works — the data contract, the physics model, the residual
> engine, state estimation, detection and fusion, the abstention rules, the
> simulation clock, the API surface, verification results and the stated
> limitations.

---

## Problem Statement

- **Limited Engine Monitoring** — Multiple engine parameters are difficult to monitor together.
- **Delayed Fault Detection** — Early engine abnormalities may go unnoticed.
- **No Real-Time Digital Twin** — Existing systems lack a continuously updated virtual engine model.
- **Difficult Predictive Maintenance** — Faults and engine degradation are difficult to predict early.

---

## Proposed Solution

### Digital Twin
Creates a virtual model of the UAV piston engine and compares expected and actual behaviour.

### Fault Detection
Identifies abnormal engine parameters and detects early-stage faults.

### Predictive Maintenance
Uses engine-health trends to support timely maintenance decisions.

### 3D Visualization
Provides an interactive view of the UAV, engine, telemetry and Digital Twin.

---

## Key Features

- 3D UAV visualization
- Piston engine visualization
- Real-time telemetry simulation
- Digital Twin synchronization
- Expected vs Actual comparison
- Residual analysis
- Cylinder-level anomaly visualization
- Thermal visualization
- Airflow visualization
- Engine health monitoring
- Predictive maintenance workflow
- Dataset and model monitoring
- Demo mode
- Cinematic UAV environment

---

## System Workflow

```
              UAV
               ↓
       ENGINE TELEMETRY
               ↓
       DATA PROCESSING
               ↓
        DIGITAL TWIN
               ↓
     EXPECTED vs ACTUAL
               ↓
      RESIDUAL ANALYSIS
               ↓
           ANOMALY
               ↓
         PREDICTION
               ↓
        MAINTENANCE
```

---

## Technology Stack

**Frontend**
- React 18 + TypeScript
- Vite
- Three.js / React Three Fiber / drei
- Framer Motion
- Zustand
- Apache ECharts
- React Router

**Backend**
- Python + FastAPI
- Uvicorn (REST + WebSocket)
- Pydantic

**Analytics**
- NumPy / SciPy
- scikit-learn — Isolation Forest over residual features

**Data**
- CSV flight files (NGAFID / Garmin G1000 column naming)

All analytics run locally, in-process. The platform requires **no external AI
service and no API keys** — there is no LLM, no inference API and no vendor SDK
anywhere in the stack.

The only off-host request the application makes is a web-font stylesheet, loaded
without blocking render. On an offline or air-gapped host it falls back to the
system stack and everything else runs unchanged; vendor the two families into
`frontend/public/` to remove it entirely.

---

## Dataset

The platform reads a *contract*, not a file — the source is a swappable adapter,
so the twin core is unchanged whichever corpus is mounted.

| | `DEMO` (default) | `REAL` |
|---|---|---|
| Corpus | `data/demo/flights/` | `$AEROTWIN_NGAFID_DIR` |
| Nature | **Synthetic** — format sample | Measured flight data |
| Status | `ACTIVE` | `CONNECTED` |
| Channel badges | `DEMO` | `REAL` |

### DEMO / SIMULATED data

Three synthetic sorties ship at [`data/demo/flights/`](data/demo/flights/) in
NGAFID / Garmin G1000 column naming. They exist so the ingest path, the Digital
Twin workflow and the full demonstration run out of the box. They are
**synthetic**, and every value they produce is badged `DEMO` in the UI, in every
API response and in every export.

### Team corpus

The engine-telemetry corpus produced by the team's data workstream
(`MONISHA-tech316/aerotwin-person1`) ships at
[`data/team_corpus/`](data/team_corpus/) — 4,200 rows at 1 Hz across a normal
regime, a degradation ramp and four injected fault modes, with the generator's
own `state` / `fault` columns as ground truth.

It is **generated, not measured** — its own generator adds Gaussian noise to
fixed baselines — so it is tagged `SIMULATED` everywhere and its labels are
described as generator labels, never as maintenance findings.

The **Dataset** screen shows what is in it, counted off the filesystem on every
load: files, rows, valid rows, blank fields, sampling rate, label distribution,
the channel mapping with its unit conversions, and the channels it does *not*
carry. Press `REPLAY` on any file to put it on the live seat and watch the twin
run against it.

### REAL data

Point `AEROTWIN_NGAFID_DIR` at a directory of NGAFID-MC (Zenodo 6624956,
CC-BY-4.0) Parquet or CSV flight files and the real-data adapter takes over.
The badges flip from `DEMO` to `REAL`. Nothing else changes.

```bash
export AEROTWIN_NGAFID_DIR=/path/to/ngafid
```

Parquet requires `pyarrow` or `fastparquet`; CSV requires nothing. Parquet is
reported `OPTIONAL` unless Parquet files are actually present.

**The repository contains no proprietary, operational or classified data.**

---

## Model Envelope and Abstention

The twin's expectation comes from a model calibrated for a 180 hp, 2,700 rpm,
four-cylinder air-cooled aero engine. Hand it a corpus recorded from a
different machine and every residual is enormous — not because anything is
wrong with that engine, but because the model was not built for it.

Reporting a failing engine from that would be the worst thing this system could
do, so it checks first
([`analytics/envelope.py`](backend/app/analytics/envelope.py)):

| Verdict | Meaning | Behaviour |
|---|---|---|
| `IN ENVELOPE` | the model applies | diagnose normally |
| `REDUCED` | model applies, instrumentation incomplete | diagnose what is covered, name what is not |
| `OUT OF ENVELOPE` | operating point outside calibration | **abstain** — no health verdict, no anomalies, no advisory |

On abstention `health_index` is returned as `null`, not `0`, and the gauge
draws a dash. Absolute threshold alerts still fire: a redline is a redline
whatever model is running.

Replaying the team corpus is a live demonstration of this. It runs at 4,800 rpm
and carries one bulk temperature rather than eight cylinder thermocouples, so
the twin reports:

> **MODEL ABSTENTION** — Crankshaft speed 4,726 rpm is above the model's
> calibrated ceiling of 3,105 rpm (Lycoming IO-360 class, rated 2,700 rpm).
> This is a different class of engine.
> This source has engine-level instrumentation only, so a finding cannot be
> attributed to a cylinder.

---

## Data Channels

Eighteen channels at 1 Hz. Sixteen are measurable from the corpus; two have no
counterpart in it and are generated by the physics model, tagged `SIMULATED`
everywhere they appear.

| Channel | Unit | Group | Provenance |
|---|---|---|---|
| RPM | rpm | Operating point | Measurable |
| Manifold pressure | inHg | Operating point | Measurable |
| Fuel flow | gph | Operating point | Measurable |
| EGT 1–4 | °C | Combustion | Measurable |
| CHT 1–4 | °C | Thermal | Measurable |
| Oil pressure | psi | Lubrication | Measurable |
| Oil temperature | °C | Lubrication | Measurable |
| OAT | °C | Ambient | Measurable |
| Altitude | ft | Ambient | Measurable |
| Indicated airspeed | kt | Ambient | Measurable |
| Vibration | g rms | Mechanical | **SIMULATED** |
| Injection timing | °BTDC | Mechanical | **SIMULATED** |

Per-cylinder EGT and CHT are the diagnostic basis: a failing cylinder shows up
as **asymmetry** between the four channels, not as a change in the average.

---

## Project Structure

```
AEROTWIN/
├── backend/
│   ├── app/
│   │   ├── analytics/        residual detection, calibration, explanation,
│   │   │                     model-envelope check and abstention
│   │   ├── api/              REST routes
│   │   ├── core/             channel registry, constants, event log
│   │   ├── mission/          mission profiles, route, simulator
│   │   ├── ml/               Isolation Forest, features, ingest, prediction
│   │   ├── physics/          piston engine thermodynamic model
│   │   ├── sources/          swappable data adapters — NGAFID replay,
│   │   │                     team corpus, demo simulator, SocketCAN
│   │   ├── store/            flight history
│   │   ├── twin/             twin runtime — the lockstep loop
│   │   ├── ws/               WebSocket hub
│   │   ├── main.py           FastAPI app
│   │   └── service.py        orchestration
│   ├── sample_corpus/        single-flight format sample
│   ├── tools/                build-time dataset report export
│   └── requirements.txt
├── data/
│   ├── demo/flights/         synthetic demo corpus (CSV)
│   └── team_corpus/          team engine-telemetry corpus (CSV, SIMULATED)
├── frontend/
│   ├── public/
│   │   └── dataset-report.json   build-time corpus count, for static hosts
│   ├── src/
│   │   ├── components/       3D stages, charts, intro, demo theatre, UI
│   │   ├── pages/            the console screens
│   │   ├── services/         API client, WebSocket, local demo model
│   │   ├── simulation/       the authoritative clock and its two transports
│   │   ├── store/            Zustand store
│   │   ├── styles/           design tokens and stylesheets
│   │   └── types/
│   ├── package.json
│   ├── vercel.json           static-host deployment config
│   └── vite.config.ts
├── start.ps1                 one-command launch (Windows)
├── start.sh                  one-command launch (POSIX)
└── README.md
```

---

## Installation

```bash
git clone https://github.com/shanmugapriya180607/AeroTwin-AI.git
cd AeroTwin-AI
```

**Backend**

```bash
cd backend
pip install -r requirements.txt
```

**Frontend**

```bash
cd frontend
npm install
```

Requires Python 3.11+ and Node 18+.

---

## Running the Project

**One command**

```bash
./start.sh          # macOS / Linux / Git Bash
```

```powershell
.\start.ps1         # Windows PowerShell
```

Both start the backend on `127.0.0.1:8011`, the Vite dev server on
`127.0.0.1:5173`, and open the ground station.

**Manually**

```bash
# terminal 1 — backend
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8011

# terminal 2 — frontend
cd frontend
npm run dev
```

**Production build**

```bash
cd frontend
npm run build       # emits frontend/dist
```

The backend serves `frontend/dist` when it exists, so after building, the whole
platform is available on `http://127.0.0.1:8011/` alone.

API documentation: `http://127.0.0.1:8011/docs`

---

## Testing

```bash
cd frontend
npm test          # 53 invariants: simulation engine, recall, localisation (vitest)
npx tsc -b        # type check
npm run build     # production bundle
```

The simulation engine takes no DOM dependency beyond an injectable scheduler,
so its invariants are asserted exactly rather than by waiting on wall-clock
time.

---

## Deployment

The platform is two processes: a React console and a Python ground station.

### Vercel — the console

Import the repository at [vercel.com/new](https://vercel.com/new). The root
[`vercel.json`](vercel.json) supplies the build command, the output directory
and the rewrite that makes `/intro`, `/uav`, `/dashboard` and the rest resolve
on direct navigation and on refresh — without it those are React Router paths
with no file behind them and return 404. No settings to change; **Deploy** is
enough.

Deploying from the `frontend` directory instead also works — set **Root
Directory** to `frontend` and [`frontend/vercel.json`](frontend/vercel.json)
takes over.

### The backend cannot run on Vercel

Not a shortcut — an architectural constraint worth stating plainly. Vercel runs
serverless functions: an invocation handles one request and is then frozen.
This backend needs three things that model cannot provide.

| Requirement | Why serverless cannot host it |
|---|---|
| A twin loop advancing at 5 Hz between requests | Nothing runs between invocations |
| Four WebSocket topics streaming telemetry | Vercel functions do not accept WebSocket upgrades |
| ~10 s boot — history replay, detector fit | Paid on every cold start, above the Hobby execution limit |

So the ground station belongs on a host that runs a process: Render, Railway,
Fly.io, or any container host. Point the console at it with a Vercel
environment variable and redeploy:

```
VITE_API_BASE=https://your-backend-host
```

The REST client and the WebSocket transport both follow it. Left unset, both
use the same origin — correct for local development, and for the single-host
deployment where the backend serves the built console itself.

### What the console does without a backend

This is the important part, because it is what a Vercel-only deployment is.
**Every screen works and every control works.** The local transport takes the
seat, `DEMO` appears on every value it produces, and the simulation state
machine is identical — start, pause, resume, step, stop, reset, speed, the
narrated story, the 3D intro, the UAV showcase, telemetry, Expected vs Actual,
residuals, anomalies, engine health.

The four reference screens — **Dataset**, **Data & Models**, **Validation**,
**Architecture** — read a build-time snapshot produced by the same functions
the API serves:

```bash
cd backend
python -m tools.export_static_reports   # writes frontend/public/reports/*.json
```

The figures are identical because they come from the same code over the same
files. Only *when* they were produced differs, and each screen carries a
`BUILD SNAPSHOT` badge rather than passing one off as a live reading. Two
things are deliberately **not** snapshotted, because a frozen copy of a live
value is exactly what this project must never ship:

- **the live prediction endpoint** on Data & Models — a reading of a running
  twin, so it says `LIVE ENDPOINT` and names what would exercise it;
- **which source holds the live seat**, and replaying a corpus file through the
  twin — both need a twin to be running, and the buttons say so.

Verified with the backend deliberately stopped: 13 routes, zero error states,
pause/step/start/story all working.

Screens that read the backend directly — Data & Models, Validation,
Architecture — show their empty state instead. For a complete demonstration,
host the backend and set `VITE_API_BASE`.

---

## Demo Flow

1. Open AEROTWIN.
2. Watch the cinematic UAV introduction.
3. Inspect the UAV.
4. Inspect the piston engine.
5. Open the Digital Twin.
6. Start the demo.
7. Monitor telemetry.
8. Observe Expected vs Actual.
9. Observe residual deviation.
10. Observe cylinder anomaly.
11. View prediction.
12. View maintenance state.

**Routes**

| Route | |
|---|---|
| `/intro` | Cinematic first-entry sequence — skippable, replayable |
| `/uav` | Interactive 3D aircraft and engine inspection |
| `/dashboard` | Command Center and the eleven other console screens |

`RUN STORY` plays the whole chain full screen over the aircraft in about ninety
seconds, with the engine assembly in frame and every number read live. It reads
the sortie already in progress rather than rewinding it, so the aircraft is at
altitude and the deviation is already developing when the narration reaches it.

---

## Simulation Control

Everything that moves because the *simulation* is moving — telemetry, charts,
the residual, the twin, the UAV's mission track, the pistons, the airflow
particles, the narration — derives from one clock
([`frontend/src/simulation/`](frontend/src/simulation/)). Nothing else in the
console owns a timer that advances simulation state.

| Control | Behaviour |
|---|---|
| `START DEMO` | full start-up: dataset → simulation → twin → AI → telemetry, each stage named. Never disabled — it restarts the sortie as the compressed demonstration, and reads `RESTART DEMO` while one is running |
| `PAUSE` | the clock, the index, the charts, the twin, the pistons and the aircraft all hold on the same sample |
| `RESUME` | continues from exactly that timestep — never restarts, never skips |
| `STEP` | advances exactly one 1 Hz sample, then holds again |
| `STOP` | ends the sortie; everything computed stays inspectable |
| `RESET` | rewinds and clears every derived quantity — no residual baseline carried over |
| `1× … 200×` | replay rate; changing it never resumes a held simulation and never spawns a second loop |

The offered buttons are derived from the simulation status, so `PAUSE` is never
offered on an already-held simulation and `STEP` is never offered on a running
one.

The state machine is identical whether frames come from the ground station or
from the reduced model that runs in the browser when no backend answers — only
the transport differs. That is what makes the controls work on a static
deployment, where they previously did nothing at all.

**Invariants under test.** `npm test` in `frontend/` runs 53 assertions across
four suites.

*The clock*, against a fake scheduler: pressing `START` twice creates exactly
one loop; a held simulation's index does not change across a hundred ticks; a
live frame that arrives after `PAUSE` is dropped; `RESUME` does not re-prepare
the source; `STEP` advances exactly one sample and leaves the simulation held.

*The recall*: a diversion routes home from where the aircraft actually is,
begins descending on the command rather than when a fixed glidepath catches up,
never commands a climb, and arrives at circuit height overhead the field.

*Localisation*: the degradation is driven onto each cylinder in turn and the
finding has to follow it — nothing tells the frame builder which cylinder was
degraded, so it has to come out of the CHT and EGT residuals. The engine
summary and the alert must name the same one.

*The operator's options*: every command the situation allows stays available at
every risk level, and the risk level only changes which one is advised.

---

## Mission Control

AEROTWIN does not fly the aircraft. It reads the engine, states how confident it
is and says what it would do — and then a person decides. That separation is the
product, so it is modelled explicitly rather than implied by which buttons
happen to be enabled.

The console publishes a mission risk (LOW / MODERATE / HIGH / CRITICAL) derived
from the engine's own published state, the severity of the strongest finding the
detector has not abstained on, and the health index. The state wins where they
disagree — it is the twin's verdict, and second-guessing it here would mean two
parts of the console giving different answers about the same engine.

| Command | Behaviour |
|---|---|
| `CONTINUE TO FLY` | Releases the aircraft back onto the planned route. Deliberately clears nothing: the deviation is still there and the health index still says what it said. Continuing is a choice to accept a known risk, not a way of making it go away |
| `RETURN TO BASE` | Builds a diversion from where the aircraft actually is, not from the next waypoint. The height to lose is spread over the range there was to run, so the descent begins on the command and reaches circuit height overhead the field |
| `ABORT MISSION` | Ends the sortie where it stands, behind a confirmation. The clock stops, the aircraft holds its last position and altitude, and every computed quantity stays on screen for review |

**All three are offered at every risk level while the sortie is live.** The risk
level decides what is *advised* and the layout weights it; it does not decide
what a person is allowed to do. A panel that only offers the answer it wants is
not decision support.

Mission phase is tracked separately from the replay clock: `READY` through the
pre-flight and launch phases to `ACTIVE`, then `RETURNING_TO_BASE`, `ABORTED` or
`COMPLETED`. `ABORTED` is distinct from a stopped replay — a stopped replay can
be restarted, an aborted sortie cannot, and `CONTINUE TO FLY` will not resurrect
one. `RESET` returns the console to `READY` for a fresh sortie.

Nothing is raised as an alert before the aircraft is away. A cylinder deviation
announced over a pre-flight checklist is noise at the one moment the operator is
watching something else.

---

## How It Works

The physics model and the engine consume the same inputs each second. Their
outputs are differenced per channel and per cylinder to produce residuals. A
transparent baseline detector — a linear model a propulsion engineer can read
and argue with — scores those residuals, and an Isolation Forest fitted online
to *this* engine's healthy residual distribution scores them independently. The
two are fused.

The system abstains rather than guessing: where evidence is thin it reports
`INSUFFICIENT EVIDENCE` instead of a diagnosis, and a mechanism is always named
as `LIKELY CONTRIBUTING`, never as confirmed.

Provenance is a product feature, not a footnote. `REAL` describes the data
*contract*; whether a channel was actually measured depends on the mounted
source, so anything produced by the simulator or the demo corpus is badged
`DEMO` everywhere it appears.

---

## Disclaimer

Demo telemetry and simulated datasets are used where real operational UAV engine
data is unavailable. The prototype does not claim access to proprietary
operational or classified data.

The sector, mission and aircraft identifiers are fictional. Positions are
reported as a local grid reference, never as latitude and longitude.
