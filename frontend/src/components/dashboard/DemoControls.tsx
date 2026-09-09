/**
 * Replay and demonstration controls.
 *
 * Every button here goes through the simulation engine, never straight at the
 * backend. That is what makes them work with no backend at all: the engine
 * swaps the transport underneath and the control surface does not change.
 *
 * The button *set* is derived from the simulation status rather than written
 * out by hand, so PAUSE is never offered on an already-held simulation and
 * STEP is never offered on a running one.
 */

import { useState } from 'react'
import {
  Clapperboard, Pause, Play, RotateCcw, Radio, Sparkles, SkipForward, Square,
} from 'lucide-react'
import { api } from '../../services/api'
import { useTwin } from '../../store/useTwin'
import { controlsFor, useSimulation } from '../../simulation'
import { launchStory } from '../demo/DemoStory'

/** The offered replay rates. The backend's demonstration rate is one of them,
 *  so the active chip always reflects what the clock is actually doing. */
const SPEEDS = [1, 20, 60, 200]

export function DemoControls() {
  const status = useTwin((s) => s.status)
  const sim = useSimulation()
  const startDemo = useTwin((s) => s.startDemo)
  const pauseSim = useTwin((s) => s.pauseSim)
  const resumeSim = useTwin((s) => s.resumeSim)
  const stopSim = useTwin((s) => s.stopSim)
  const resetSim = useTwin((s) => s.resetSim)
  const stepSim = useTwin((s) => s.stepSim)
  const setSpeed = useTwin((s) => s.setSpeed)
  const refreshStatus = useTwin((s) => s.refreshStatus)
  const storyRunning = useTwin((s) => s.storyStep) >= 0
  const setStoryStep = useTwin((s) => s.setStoryStep)
  const [busy, setBusy] = useState(false)

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

  /** One command, named for what it does from the current state.
   *
   *  It is never disabled. START DEMO does not mean "begin" - it means
   *  "restart this sortie as the compressed demonstration", which an operator
   *  must be able to ask for at any time. Greying it out because a sortie was
   *  already running made the console's most prominent button look broken. */
  const startLabel =
    sim.status === 'running' || sim.status === 'paused' ? 'Restart demo'
      : sim.status === 'stopped' ? 'Restart'
        : sim.status === 'completed' ? 'Replay'
          : sim.status === 'error' ? 'Retry' : 'Start demo'

  return (
    <div className="row row--tight">
      <div className="btn-group" title="Replay rate">
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

      {can.canPause && (
        <button
          className="btn btn--icon"
          disabled={held}
          title="Pause - the clock, the charts, the twin and the engine all hold"
          onClick={() => run(pauseSim)}
        >
          <Pause size={14} />
        </button>
      )}

      {can.canResume && (
        <button
          className="btn btn--icon btn--primary"
          disabled={held}
          title="Resume from the same timestep"
          onClick={() => run(resumeSim)}
        >
          <Play size={14} />
        </button>
      )}

      {can.canStep && (
        <button
          className="btn btn--icon"
          disabled={held}
          title="Advance exactly one 1 Hz timestep, then hold"
          onClick={() => run(stepSim)}
        >
          <SkipForward size={14} />
        </button>
      )}

      {can.canStop && (
        <button
          className="btn btn--icon"
          disabled={held}
          title="Stop the sortie - state is kept for inspection"
          onClick={() => run(stopSim)}
        >
          <Square size={13} />
        </button>
      )}

      {can.canReset && (
        <button
          className="btn btn--icon"
          disabled={held}
          title="Reset - rewind and clear every derived quantity"
          onClick={() => run(resetSim)}
        >
          <RotateCcw size={13} />
        </button>
      )}

      <button
        className="btn btn--icon"
        disabled={held || sim.transport === 'LOCAL'}
        title={
          sim.transport === 'LOCAL'
            ? 'Data link simulation needs the ground-station backend'
            : status?.datalink?.connected
              ? 'Simulate data link interruption - the twin holds rather than guessing'
              : 'Restore data link'
        }
        onClick={() => run(async () => {
          await api.setDatalink(!status?.datalink?.connected)
          await refreshStatus()
        })}
      >
        <Radio size={14} color={status?.datalink?.connected ? undefined : 'var(--crit-ink)'} />
      </button>

      <button
        className="btn btn--sm"
        disabled={held}
        title="Run the scripted sortie from the top: healthy, then a developing deviation"
        onClick={() => run(startDemo)}
      >
        <Sparkles size={13} />
        {can.busy ? sim.stage ?? 'Starting' : startLabel}
      </button>

      {/* The narrated version: ninety seconds, sensor to advisory, with the
          live evidence shown at each beat. */}
      <button
        className={`btn btn--sm ${storyRunning ? 'btn--danger' : 'btn--primary'}`}
        title="Narrated demonstration - the whole chain in ninety seconds"
        onClick={() => (storyRunning ? setStoryStep(-1) : void launchStory())}
      >
        <Clapperboard size={13} />
        {storyRunning ? 'Stop story' : 'Run story'}
      </button>
    </div>
  )
}
