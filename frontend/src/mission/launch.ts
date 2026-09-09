/**
 * The launch sequence.
 *
 * One state machine for the whole thing. The status line, the checklist, the
 * notification, the spoken callout, whether the flight model may move
 * horizontally and whether normal mission alerting is allowed all read from
 * the same phase - so they cannot disagree, and a transition cannot
 * half-happen.
 *
 * That is why this is a module and not a handful of `setTimeout`s in a
 * component: separate timers driving the HUD, the voice and the telemetry is
 * how you get an aircraft announced as airborne while its altitude still reads
 * zero. Here there is one ticker, one ordered list of phases, and every phase
 * fires its side effects exactly once on entry.
 *
 * It integrates nothing. Altitude is flown by the existing flight model; this
 * only says what to climb to and when the route may be released.
 */

import { flightDynamics } from '../components/uav/flight'
import { CHECKS, blocked, type CheckContext, type CheckResult } from './preflight'

export type LaunchPhase =
  | 'INITIALIZING'
  | 'PRE_FLIGHT'
  | 'PRE_FLIGHT_COMPLETE'
  | 'ENGINE_STARTING'
  | 'ENGINE_READY'
  | 'TAKEOFF'
  | 'CLIMB'
  | 'SAFE_ALTITUDE'
  | 'ACTIVE'
  | 'PRE_FLIGHT_FAILED'

/**
 * Above this the aircraft is away and the route is released.
 *
 * 330 ft, about 100 m - the gate the climb-out has to clear before the route
 * is handed back, not a cruise altitude. Deliberately low: it makes the climb
 * a six-second sequence at the model's rate, which is long enough to watch and
 * short enough that nobody clicks past it, and the route then carries the
 * aircraft on up to its own cruise figures.
 */
export const SAFE_ALTITUDE_FT = 330

/** Commanded during the climb - above the gate, so the aircraft is still
 *  climbing when it crosses it rather than levelling exactly on it. The route
 *  takes the altitude back at MISSION ACTIVE and carries on up to cruise. */
const CLIMB_TARGET_FT = SAFE_ALTITUDE_FT + 110

/** A condition-gated phase gives up after this and moves on. A stuck phase
 *  is worse than an early one: it would strand the console short of ACTIVE
 *  with the route never released. */
const CONDITION_TIMEOUT_MS = 45_000

export interface PhaseSpec {
  phase: LaunchPhase
  /** Shown as the mission status. */
  label: string
  /** One line in the feed. Null means the phase is silent. */
  notice: string | null
  /** Spoken once, on entry. Null means say nothing. */
  say: string | null
  /** Dwell in ms. Undefined means the phase ends on a condition instead. */
  hold?: number
}

export const SEQUENCE: PhaseSpec[] = [
  {
    phase: 'INITIALIZING',
    label: 'MISSION INITIALIZING',
    notice: 'Mission initialization started',
    say: 'Mission initialization started.',
    hold: 1500,
  },
  {
    // Ends when the checklist has run, not on a timer.
    phase: 'PRE_FLIGHT',
    label: 'PRE-FLIGHT CHECK',
    notice: 'Pre-flight check initiated',
    say: 'Pre-flight check initiated.',
  },
  {
    phase: 'PRE_FLIGHT_COMPLETE',
    label: 'ALL SYSTEMS READY',
    notice: 'All systems ready',
    say: 'All systems ready.',
    hold: 1500,
  },
  {
    phase: 'ENGINE_STARTING',
    label: 'ENGINE STARTING',
    notice: 'Engine starting',
    say: 'Engine starting.',
    hold: 2600,
  },
  {
    phase: 'ENGINE_READY',
    label: 'ENGINE READY',
    notice: 'Engine ready',
    say: null,
    hold: 1200,
  },
  {
    phase: 'TAKEOFF',
    label: 'TAKEOFF INITIATED',
    notice: 'Takeoff initiated',
    say: 'Takeoff initiated.',
    hold: 1800,
  },
  {
    // Ends on the altimeter, not a stopwatch. An announcement of safe altitude
    // that the altimeter does not support is exactly what this console must
    // never do.
    phase: 'CLIMB',
    label: 'CLIMBING',
    notice: 'Climbing to safe altitude',
    say: 'U A V climbing.',
  },
  {
    phase: 'SAFE_ALTITUDE',
    label: 'SAFE ALTITUDE REACHED',
    notice: 'Safe altitude reached',
    say: 'Safe altitude reached.',
    hold: 1400,
  },
  {
    phase: 'ACTIVE',
    label: 'MISSION ACTIVE',
    notice: 'Mission active',
    say: 'Mission active.',
  },
]

export interface SequencerHooks {
  onPhase: (spec: PhaseSpec) => void
  /** A check moved. Reported one at a time so the panel can show the sweep. */
  onCheck: (id: string, state: 'CHECKING' | 'READY' | 'WARNING' | 'FAILED', detail?: string) => void
  /** Critical item failed: the launch stops here. */
  onFailed: (label: string, detail: string) => void
  /** Live state for the checks to interrogate. */
  context: () => CheckContext
  /** True while the simulation clock is advancing. Everything here holds when
   *  the console is paused, so a launch cannot complete behind a frozen
   *  aircraft, and resuming carries on from the same item. */
  isRunning: () => boolean
  /** Spoken per-check callout, if the check asks for one. */
  say: (line: string) => void
}

/** How long each item spends CHECKING before it reports. */
const CHECK_MS = 420

export class LaunchSequencer {
  private index = -1
  private ticker: number | undefined
  private hooks: SequencerHooks | null = null
  private elapsed = 0
  /** Which checklist item is being worked, while in PRE_FLIGHT. */
  private checkIndex = -1
  private results: Record<string, CheckResult | undefined> = {}

  get running(): boolean {
    return this.index >= 0
  }

  get phase(): LaunchPhase | 'IDLE' {
    return this.index < 0 ? 'IDLE' : SEQUENCE[this.index].phase
  }

  /**
   * Begin. Idempotent by design: pressing ENTER MISSION five times starts one
   * launch, which is the difference between a sequencer and five timers.
   */
  begin(hooks: SequencerHooks): void {
    if (this.running) return
    this.hooks = hooks
    this.results = {}
    this.checkIndex = -1
    flightDynamics.groundHold = true
    flightDynamics.frozen = false
    this.index = -1
    this.advance()
  }

  /** Abandon the sequence and put the aircraft back on the ground. */
  reset(): void {
    this.stop()
    this.index = -1
    this.elapsed = 0
    this.checkIndex = -1
    this.results = {}
    flightDynamics.groundHold = true
    flightDynamics.state.altitudeFt = 0
    flightDynamics.state.speedKt = 0
    flightDynamics.state.pitch = 0
  }

  /**
   * Stop the sequence where it is, without touching the aircraft.
   *
   * `reset` puts it back on the ground, which is right when a launch is being
   * abandoned before it ever flew and wrong when the mission is aborted in the
   * air: an abort has to leave the aircraft at the altitude it was at, and
   * zeroing the altimeter would destroy the state the abort exists to
   * preserve. The ground hold is released so the model is not left in its
   * vertical-only mode.
   */
  abandon(): void {
    this.stop()
    this.index = -1
    this.elapsed = 0
    this.checkIndex = -1
    this.results = {}
    flightDynamics.groundHold = false
  }

  private stop(): void {
    if (this.ticker !== undefined) {
      window.clearInterval(this.ticker)
      this.ticker = undefined
    }
  }

  /** The altitude the flight model should be flying toward right now, or null
   *  once the route owns it again. */
  commandedAltitudeFt(): number | null {
    const p = this.phase
    if (p === 'IDLE') return null
    if (p === 'ACTIVE') return null
    if (p === 'TAKEOFF' || p === 'CLIMB' || p === 'SAFE_ALTITUDE') return CLIMB_TARGET_FT
    return 0                                  // on the ground through the checks
  }

  private advance = (): void => {
    this.stop()
    this.index += 1
    if (this.index >= SEQUENCE.length) return

    const spec = SEQUENCE[this.index]
    this.elapsed = 0
    this.hooks?.onPhase(spec)

    if (spec.phase === 'ACTIVE') {
      // Away. The route takes over and normal alerting is released.
      flightDynamics.groundHold = false
      return
    }

    /* One ticker for every phase. Ticked rather than scheduled so a pause
       suspends the sequence instead of letting it run to completion behind a
       frozen aircraft, and so resume continues from the same item. */
    const step = 100
    this.ticker = window.setInterval(() => {
      if (!this.hooks?.isRunning()) return
      this.elapsed += step

      if (spec.phase === 'PRE_FLIGHT') { this.tickChecks(); return }

      if (spec.phase === 'CLIMB') {
        if (flightDynamics.state.altitudeFt >= SAFE_ALTITUDE_FT) { this.advance(); return }
        if (this.elapsed >= CONDITION_TIMEOUT_MS) this.advance()
        return
      }

      if (spec.hold !== undefined && this.elapsed >= spec.hold) this.advance()
    }, step)
  }

  /**
   * Walk the checklist, one item at a time.
   *
   * Each item shows CHECKING for a beat and then reports what it actually
   * found. The dwell is theatre; the verdict is not - it comes from the
   * predicate reading live state, and a critical failure stops the launch here
   * rather than being carried into a takeoff.
   */
  private tickChecks(): void {
    const hooks = this.hooks
    if (!hooks) return

    const slot = Math.floor(this.elapsed / CHECK_MS)
    if (slot === this.checkIndex) return
    this.checkIndex = slot

    if (slot > 0) {
      // Report the item that has just finished its dwell.
      const done = CHECKS[slot - 1]
      if (done) {
        const result = done.run(hooks.context())
        this.results[done.id] = result
        hooks.onCheck(done.id, result.state, result.detail)
        if (result.state !== 'FAILED' && done.say) hooks.say(done.say)
      }
    }

    if (slot >= CHECKS.length) {
      const stopper = blocked(this.results)
      if (stopper) {
        this.stop()
        this.index = SEQUENCE.length          // no further phases
        hooks.onFailed(stopper.label, this.results[stopper.id]?.detail ?? 'Unavailable')
        return
      }
      this.advance()
      return
    }

    hooks.onCheck(CHECKS[slot].id, 'CHECKING')
  }
}

export const launchSequencer = new LaunchSequencer()
