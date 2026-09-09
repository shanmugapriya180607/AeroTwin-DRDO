/**
 * Flight Replay.
 *
 * The replay controls already existed - in the top bar, next to the demo
 * buttons, where they read as part of the demonstration rather than as a way
 * to work through a recorded sortie. This screen is the same controls given
 * the room to be an instrument: the flight being replayed, where the clock is
 * inside it, and what the twin made of it as it went past.
 *
 * Nothing here is a new control surface. Every button goes through the same
 * simulation engine the top bar uses, which is what makes them work against a
 * ground station and against the local model without knowing the difference.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Gauge, History, Pause, Play, RotateCcw, SkipForward, Square,
} from 'lucide-react'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { controlsFor, useSimulation } from '../simulation'
import { ExpectedActualChart } from '../components/charts/Charts'
import {
  Badge, Empty, Loading, Meter, Metrics, Note, PageHead, Panel, ProvenanceTag,
  StatusBadge, clock, fmt, signed,
} from '../components/ui/Primitives'

const SPEEDS = [1, 20, 60, 200]

/** As `/api/flights` returns them. */
interface FlightRow {
  flight_id: string | number
  label?: string
  profile_id?: string
  duration_s?: number
  health_index?: number
  peak_cylinder?: number | null
  peak_residual_c?: number | null
  status?: string
  samples?: number
  notes?: string | null
}

export default function FlightReplay() {
  const sim = useSimulation()
  const telemetry = useTwin((s) => s.telemetry)
  const alerts = useTwin((s) => s.alerts)
  const history = useTwin((s) => s.history)
  const mode = useTwin((s) => s.mode)
  const selected = useTwin((s) => s.selectedCylinder)

  const pauseSim = useTwin((s) => s.pauseSim)
  const resumeSim = useTwin((s) => s.resumeSim)
  const stopSim = useTwin((s) => s.stopSim)
  const resetSim = useTwin((s) => s.resetSim)
  const stepSim = useTwin((s) => s.stepSim)
  const setSpeed = useTwin((s) => s.setSpeed)
  const startDemo = useTwin((s) => s.startDemo)

  const [flights, setFlights] = useState<FlightRow[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api.flights().then((rows) => {
      if (!live) return
      setFlights(Array.isArray(rows) ? rows : rows?.flights ?? [])
    })
    return () => { live = false }
  }, [])

  const can = controlsFor(sim.status)
  const held = busy || can.busy

  const run = async (fn: () => Promise<unknown> | unknown) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const engine = telemetry?.engine
  const chtSeries = history[`cht_${selected}`] ?? []

  /* The engine's own clock, not the telemetry frame's: while the simulation is
     held, no frame arrives by design, and reading the frame would make a
     paused replay look like it had lost its position. */
  const t = sim.currentTime
  /* Percentage only when the source has published a length. Without one the
     position is an elapsed clock - a completion figure we cannot support is
     worse than no completion figure. */
  const known = sim.totalSteps > 0
  const progress = known ? Math.min(100, sim.progress * 100) : null

  const statusTone =
    sim.status === 'running' ? 'ok'
      : sim.status === 'paused' ? 'caution'
        : sim.status === 'error' ? 'crit' : 'neutral'

  const flagged = alerts?.anomalies?.filter((a) => !a.abstained) ?? []

  const cells = useMemo(() => ([
    { k: 'Replay clock', v: clock(t) },
    { k: 'Rate', v: String(Math.round(sim.speed)), unit: '×' },
    {
      k: 'Health index',
      v: fmt(engine?.health_index, 1),
      tone: (engine?.health_index ?? 100) >= 90 ? 'ok' : 'warn',
    },
    { k: 'Deviations', v: String(flagged.length), tone: flagged.length ? 'warn' : 'ok' },
  ]), [t, sim.speed, engine, flagged.length])

  return (
    <>
      <PageHead
        title="Flight Replay"
        sub="Step a recorded sortie through the twin at the rate you want to read it. The clock, the charts, the residuals and the engine all move together."
        actions={
          <div className="row row--tight">
            <Badge tone={statusTone as never} dot live={sim.status === 'running'}>
              {sim.status.toUpperCase()}
            </Badge>
            <ProvenanceTag provenance={mode === 'DEMO' ? 'DEMO' : 'REAL'} />
          </div>
        }
      />

      <Metrics cells={cells} />

      <div className="grid grid--2" style={{ marginTop: 'var(--gap-4)' }}>
        <Panel
          title="Transport"
          sub="REPLAY CONTROL"
          actions={<Badge tone="info">{Math.round(sim.speed)}× RATE</Badge>}
        >
          <div className="stack stack--lg">
            {/* ---- position ------------------------------------------- */}
            <div className="field">
              <div className="field__row">
                <span className="stat__k">Position</span>
                <span className="field__v">
                  {clock(t)}
                  {known ? `  ·  step ${sim.currentIndex + 1} / ${sim.totalSteps}` : ''}
                </span>
              </div>
              {progress === null ? (
                <Note>
                  The sortie's length is not published by this source, so the position is an
                  elapsed clock rather than a percentage.
                </Note>
              ) : (
                <Meter value={progress} tall />
              )}
            </div>

            {/* ---- transport ------------------------------------------ */}
            <div className="row row--wrap">
              {can.canResume ? (
                <button className="btn btn--primary" disabled={held} onClick={() => run(resumeSim)}>
                  <Play size={13} /> Play
                </button>
              ) : (
                <button className="btn btn--primary" disabled={held || !can.canPause} onClick={() => run(pauseSim)}>
                  <Pause size={13} /> Pause
                </button>
              )}

              <button className="btn" disabled={held || !can.canStep} onClick={() => run(stepSim)}>
                <SkipForward size={13} /> Step
              </button>

              <button className="btn" disabled={held || !can.canStop} onClick={() => run(stopSim)}>
                <Square size={13} /> Stop
              </button>

              <button className="btn" disabled={held || !can.canReset} onClick={() => run(resetSim)}>
                <RotateCcw size={13} /> Reset
              </button>

              <span className="spacer" />

              <button className="btn" disabled={held} onClick={() => run(startDemo)}>
                <History size={13} /> Replay demonstration sortie
              </button>
            </div>

            {/* ---- rate ------------------------------------------------- */}
            <div className="field">
              <div className="field__row">
                <span className="stat__k">Replay rate</span>
                <span className="field__v">{Math.round(sim.speed)}×</span>
              </div>
              <div className="btn-group">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    className={`btn btn--sm ${Math.round(sim.speed) === s ? 'btn--active' : ''}`}
                    disabled={held}
                    onClick={() => run(() => setSpeed(s))}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>

            <Note tone={sim.status === 'paused' ? 'warn' : undefined}>
              {sim.status === 'paused'
                ? 'Held. The twin, the charts and the engine are all frozen at this timestep - nothing behind them is still advancing.'
                : 'Pause holds the whole console at one timestep, so a deviation can be read rather than watched going past.'}
            </Note>
          </div>
        </Panel>

        <Panel
          title={`Expected vs actual · CHT ${selected}`}
          sub="AS REPLAYED"
          actions={<Gauge size={13} />}
        >
          {chtSeries.length ? (
            <ExpectedActualChart series={chtSeries} unit="°C" height={230} />
          ) : (
            <Empty
              label="Awaiting frames"
              detail="Start or resume the replay and the trace fills as the sortie plays through the twin."
            />
          )}
        </Panel>
      </div>

      <Panel
        title="Flight history"
        sub="AVAILABLE SORTIES"
        className="panel--flush"
        bodyClass="panel__body--flush"
        style={{ marginTop: 'var(--gap-4)' }}
      >
        {flights === null ? (
          <div style={{ padding: 'var(--gap-4)' }}><Loading height={140} /></div>
        ) : flights.length === 0 ? (
          <Empty
            label="No completed sorties"
            detail="The flight register fills as sorties finish. With no ground station answering, the local model reports only the sortie it is flying now."
          />
        ) : (
          <div className="scroll-y" style={{ maxHeight: 320 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Flight</th>
                  <th>Profile</th>
                  <th className="num">Duration</th>
                  <th className="num">Health</th>
                  <th>Peak cylinder</th>
                  <th className="num">Peak residual</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {flights.map((row) => (
                  <tr key={String(row.flight_id)}>
                    <td className="mono">#{row.flight_id}</td>
                    <td>{(row.profile_id ?? '—').replace(/_/g, ' ')}</td>
                    <td className="num">{row.duration_s ? clock(row.duration_s) : '—'}</td>
                    <td className="num">{fmt(row.health_index, 1)}</td>
                    <td>{row.peak_cylinder ? `CYL ${row.peak_cylinder}` : '—'}</td>
                    <td className="num">
                      {row.peak_residual_c === null || row.peak_residual_c === undefined
                        ? '—'
                        : `${signed(row.peak_residual_c, 1)} °C`}
                    </td>
                    <td><StatusBadge status={row.status} dot={false} /></td>
                    <td style={{ whiteSpace: 'normal', minWidth: '22ch' }}>{row.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  )
}
