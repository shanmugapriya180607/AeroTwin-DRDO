/**
 * The pre-flight panel.
 *
 * Visible only while the sortie is being launched: standby, the checklist, the
 * engine start, the climb-out. Once the aircraft is away it removes itself
 * rather than sitting on the screen as permanent chrome.
 *
 * Every row reports what its check actually found - the grid reference, the
 * channel count, the twin's sync figure, the risk engine's own verdict. None
 * of it is a fixed READY: a checklist that always passes is a decoration, and
 * a decoration where a reader expects a safety check is worse than no panel.
 */

import { useEffect, useRef } from 'react'
import { AlertTriangle, Check, CircleDashed, Play, TriangleAlert } from 'lucide-react'
import { useTwin } from '../../store/useTwin'
import { flightDynamics } from '../uav/flight'
import { CHECKS } from '../../mission/preflight'
import { SAFE_ALTITUDE_FT } from '../../mission/launch'

const LAUNCHING = new Set([
  'INITIALIZING', 'PRE_FLIGHT', 'PRE_FLIGHT_COMPLETE',
  'ENGINE_STARTING', 'ENGINE_READY', 'TAKEOFF', 'CLIMB', 'SAFE_ALTITUDE',
])

const CLIMBING = new Set(['TAKEOFF', 'CLIMB', 'SAFE_ALTITUDE'])

function Mark({ state }: { state?: string }) {
  if (state === 'READY') return <Check size={12} strokeWidth={3} />
  if (state === 'WARNING') return <TriangleAlert size={12} strokeWidth={2.5} />
  if (state === 'FAILED') return <AlertTriangle size={12} strokeWidth={2.5} />
  if (state === 'CHECKING') return <CircleDashed size={12} strokeWidth={2.5} className="pf__spin" />
  return <span className="pf__dot" />
}

/**
 * Height and rate, read off the flight model each frame.
 *
 * Written straight into the DOM: this is the one part of the launch that has
 * to update continuously, and putting sixty altitude changes a second through
 * the store would re-render the page for a number that moved three feet.
 */
function ClimbReadout() {
  const altRef = useRef<HTMLSpanElement>(null)
  const vsRef = useRef<HTMLSpanElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    let lastAlt = flightDynamics.state.altitudeFt
    let lastT = performance.now()
    const tick = () => {
      const now = performance.now()
      const alt = flightDynamics.state.altitudeFt
      if (altRef.current) altRef.current.textContent = `${Math.round(alt * 0.3048)} m`
      if (barRef.current) {
        barRef.current.style.height = `${Math.min(100, (alt / SAFE_ALTITUDE_FT) * 100)}%`
      }
      if (now - lastT > 250) {
        const ms = ((alt - lastAlt) / ((now - lastT) / 1000)) * 0.3048
        if (vsRef.current) vsRef.current.textContent = `${ms >= 0 ? '+' : ''}${ms.toFixed(1)} m/s`
        lastAlt = alt
        lastT = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="pf__climb">
      {/* A vertical tape, because a climb is a vertical quantity. */}
      <div className="pf__tape"><div className="pf__tape-fill" ref={barRef} /></div>
      <div className="pf__climb-figs">
        <div>
          <span className="pf__k">ALTITUDE</span>
          <span className="pf__v mono" ref={altRef}>0 m</span>
        </div>
        <div>
          <span className="pf__k">VERTICAL SPEED</span>
          <span className="pf__v mono" ref={vsRef}>+0.0 m/s</span>
        </div>
      </div>
    </div>
  )
}

export function PreFlight() {
  const phase = useTwin((s) => s.missionPhase)
  const label = useTwin((s) => s.missionLabel)
  const checks = useTwin((s) => s.preflight)
  const failure = useTwin((s) => s.preflightFailure)
  const launch = useTwin((s) => s.launchMission)
  const reset = useTwin((s) => s.resetSim)

  const launching = LAUNCHING.has(phase)
  const failed = phase === 'PRE_FLIGHT_FAILED'
  const standby = phase === 'READY'

  // Gone once the aircraft is away, or handed over to the operator panel.
  if (!launching && !failed && !standby) return null

  return (
    <section className={`panel pf ${failed ? 'pf--failed' : ''}`}>
      <header className="panel__head">
        <Play size={13} color="var(--accent-ink)" />
        <h2 className="panel__title">{failed ? 'Pre-flight failed' : 'Pre-flight'}</h2>
        <span className="panel__spacer" />
        <span className={`pf__phase ${failed ? 'pf__phase--failed' : ''}`}>{label}</span>
      </header>

      <div className="panel__body">
        {standby && (
          <>
            <p className="note">
              The aircraft is on the ground at BASE ALPHA. Altitude 0, engine stopped, nothing
              on the route is advancing. Press ENTER MISSION to run the pre-flight and launch.
            </p>
            <button className="btn btn--primary btn--block" style={{ marginTop: 12 }} onClick={() => void launch()}>
              <Play size={13} /> Enter mission
            </button>
          </>
        )}

        {(launching || failed) && (
          <ol className="pf__list">
            {CHECKS.map((c) => {
              const r = checks[c.id]
              const state = r?.state ?? 'PENDING'
              return (
                <li key={c.id} className={`pf__row pf__row--${state.toLowerCase()}`}>
                  <span className="pf__mark"><Mark state={state} /></span>
                  <span className="pf__label">{c.label}</span>
                  <span className="pf__state">
                    {state === 'PENDING' ? '' : state === 'CHECKING' ? 'CHECKING…' : state}
                  </span>
                  {r?.detail && <span className="pf__detail">{r.detail}</span>}
                </li>
              )
            })}
          </ol>
        )}

        {CLIMBING.has(phase) && <ClimbReadout />}

        {failed && failure && (
          <>
            <p className="note note--crit" style={{ marginTop: 12 }}>
              <strong>{failure.label}</strong> — {failure.detail}. Takeoff is inhibited; the
              aircraft stays on the ground until the subsystem reports.
            </p>
            <button className="btn btn--block" style={{ marginTop: 10 }} onClick={() => void reset()}>
              Reset and retry
            </button>
          </>
        )}
      </div>
    </section>
  )
}
