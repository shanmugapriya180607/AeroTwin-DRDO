/**
 * The one authoritative simulation clock.
 *
 * Everything that moves because the *simulation* is moving - telemetry, the
 * charts, the residual, the twin, the UAV's mission track, the pistons, the
 * demonstration timeline - derives from this object. Nothing else in the
 * console is allowed to own a timer that advances simulation state.
 *
 * That single rule is the fix for the two bugs this class exists to kill:
 *
 *   1. PAUSE did not pause. The console had a second clock of its own - a
 *      220 ms interval driving the in-browser model - which knew nothing about
 *      the backend's paused flag and kept stepping.
 *   2. START DEMO did nothing without a backend, because the controls were
 *      disabled outright whenever the REST call had failed.
 *
 * Both are transport problems, so the transport is now a parameter. The state
 * machine is identical whether the frames come from the backend's twin loop or
 * from the reduced model in the browser; only the transport differs.
 *
 * The class deliberately takes no DOM dependency beyond an injectable
 * scheduler, so the invariants below can be tested in Node.
 */

import type {
  SimStatus, SimTransport, SimulationClock, SimulationSnapshot, SimulationTransport,
} from './types'

/** Wall-clock milliseconds between ticks. The clock advances
 *  `TICK_MS / 1000 * speed` simulation seconds each time. */
export const TICK_MS = 100

export interface Scheduler {
  setInterval(fn: () => void, ms: number): number
  clearInterval(handle: number): void
  now(): number
}

const defaultScheduler: Scheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>),
  now: () => Date.now(),
}

type SnapshotListener = (snapshot: SimulationSnapshot) => void
type AdvanceListener = (dt: number, t: number) => void

const IDLE: SimulationSnapshot = {
  status: 'idle',
  transport: 'LIVE',
  currentIndex: 0,
  currentTime: 0,
  totalSteps: 0,
  speed: 20,
  progress: 0,
  stage: null,
  error: null,
}

export class SimulationEngine {
  /** Read by render loops at display rate. Mutated in place on purpose: a
   *  React render per animation frame would cost more than the whole scene. */
  readonly clock: SimulationClock = { t: 0, dt: 0, running: false, speed: 20 }

  private snapshot: SimulationSnapshot = { ...IDLE }
  private listeners = new Set<SnapshotListener>()
  private advanceListeners = new Set<AdvanceListener>()

  /** The only timer in the application that advances simulation state.
   *  Non-null exactly when a run is live. Guarded on every path. */
  private timer: number | null = null
  private transport: SimulationTransport | null = null
  /** Incremented on every start/stop so a slow `prepare` from an abandoned
   *  run cannot resurrect itself after the operator has moved on. */
  private generation = 0

  /**
   * Incremented by every local control command.
   *
   * The status poll reconciles the console against the backend, and without
   * this a status response that was already in flight when PAUSE was pressed
   * comes back saying `paused: false` and silently undoes the pause. A caller
   * captures this before issuing the request and hands it back; a snapshot
   * that predates a command cannot be used to reverse it.
   */
  private epoch = 0

  /** Read before issuing a status request; pass back to `reconcile`. */
  get commandEpoch(): number {
    return this.epoch
  }

  constructor(private scheduler: Scheduler = defaultScheduler) {}

  // -- observation --------------------------------------------------------

  getState(): SimulationSnapshot {
    return this.snapshot
  }

  subscribe(fn: SnapshotListener): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Called once per advanced tick with the simulation delta. The local
   *  transport's frame generator hangs off this. Never fires while held. */
  onAdvance(fn: AdvanceListener): () => void {
    this.advanceListeners.add(fn)
    return () => { this.advanceListeners.delete(fn) }
  }

  private patch(next: Partial<SimulationSnapshot>): void {
    const merged = { ...this.snapshot, ...next }
    merged.progress = merged.totalSteps > 0
      ? Math.max(0, Math.min(1, merged.currentTime / merged.totalSteps))
      : 0
    this.snapshot = merged
    this.clock.running = merged.status === 'running'
    this.clock.speed = merged.speed
    if (!this.clock.running) this.clock.dt = 0
    this.listeners.forEach((fn) => fn(merged))
  }

  // -- transport ----------------------------------------------------------

  /** Install the transport. Changing it mid-run stops the run first, so the
   *  console can fall back from LIVE to LOCAL without leaking a loop. */
  attach(transport: SimulationTransport): void {
    if (this.transport === transport) return
    if (this.timer !== null) this.teardown()
    this.transport = transport
    this.patch({ transport: transport.kind })
  }

  get transportKind(): SimTransport {
    return this.transport?.kind ?? 'LIVE'
  }

  /**
   * A live frame arrived from the backend.
   *
   * Returns false when the frame must be dropped. While held, a frame already
   * in flight would otherwise move the numbers a beat after PAUSE was pressed,
   * which is exactly the failure this class exists to prevent - so the gate is
   * here and not only on the server.
   */
  observeFrame(t: number): boolean {
    const { status } = this.snapshot
    if (status === 'paused' || status === 'stopped' || status === 'stopping' || status === 'idle') {
      return false
    }
    // The first live frame after a start promotes the run out of 'starting':
    // the stream answering is what 'running' means.
    if (status === 'starting') this.patch({ status: 'running', stage: null })
    const previous = this.clock.t
    this.clock.t = t
    this.clock.dt = Math.max(0, t - previous)
    this.patch({ currentTime: t, currentIndex: Math.round(t) })
    return true
  }

  /**
   * Adopt a stream that is already flowing.
   *
   * The backend runs its twin loop whether or not a console is attached, and a
   * console that opened onto a live sortie should show it rather than sitting
   * idle behind a START button. This is the honest way to say so: the
   * simulation genuinely is running, so the state machine says 'running'
   * without pretending to have gone through a start-up it did not perform.
   *
   * Ignored once anything is under way, so it can never interrupt an operator
   * who has paused or is mid-start.
   */
  adopt(totalSteps = 0, held = false): void {
    const { status } = this.snapshot
    if (status !== 'idle') return
    // A backend that is already paused must be adopted as paused. Showing
    // 'running' over a stream that is not advancing is the same lie as a
    // pause that does not pause, in the other direction.
    this.patch({ status: held ? 'paused' : 'running', stage: null, error: null, totalSteps })
    if (!held) this.startLoop()
  }

  /**
   * Follow the backend when the two disagree about whether it is advancing.
   *
   * In LIVE mode the backend owns the clock, so it is the authority on this.
   * The console can be left showing a running simulation over a server that
   * was paused from somewhere else - another tab, a restart, the previous
   * session - and the status poll is what catches it.
   */
  reconcile(backendPaused: boolean, epoch?: number): void {
    if (this.transport?.kind !== 'LIVE') return
    // A snapshot taken before the operator's last command describes a state
    // that no longer exists. Following it would undo the command.
    if (epoch !== undefined && epoch !== this.epoch) return
    const { status } = this.snapshot
    if (backendPaused && status === 'running') {
      this.patch({ status: 'paused' })
    } else if (!backendPaused && status === 'paused') {
      this.patch({ status: 'running' })
    }
  }

  /**
   * Release a backend that was left held.
   *
   * The ground station keeps its paused flag across console sessions, so a
   * pause from an hour ago - or a STOP nobody resumed - leaves the next
   * operator looking at a console where not one number moves. That is
   * indistinguishable from a broken build.
   *
   * Opening the console is an intent to watch the sortie, so this releases it.
   * The epoch bump matters: without it the status poll already in flight comes
   * back saying `paused` and freezes it again.
   */
  async release(): Promise<void> {
    this.epoch += 1
    await this.transport?.resume()
    if (this.snapshot.status !== 'running') this.patch({ status: 'running', error: null })
    if (this.timer === null) this.startLoop()
  }

  /** The length of the loaded sortie, once it is known. Zero means unknown,
   *  which disables the progress bar rather than inventing a denominator. */
  setTotalSteps(totalSteps: number): void {
    if (!Number.isFinite(totalSteps) || totalSteps <= 0) return
    if (this.snapshot.totalSteps === totalSteps) return
    this.patch({ totalSteps })
  }

  // -- lifecycle ----------------------------------------------------------

  /**
   * Start a run.
   *
   * Idempotent by contract: calling it twice must never produce two loops, so
   * anything already starting or running short-circuits here.
   */
  async start(): Promise<void> {
    const { status } = this.snapshot
    if (status === 'starting' || status === 'running') return
    if (status === 'paused') { await this.resume(); return }

    const transport = this.transport
    if (!transport) {
      this.patch({ status: 'error', error: 'No telemetry transport attached' })
      return
    }

    this.epoch += 1
    const generation = ++this.generation
    this.teardown()
    this.clock.t = 0
    this.clock.dt = 0
    this.patch({
      status: 'starting', stage: 'LOADING DATASET', error: null,
      currentIndex: 0, currentTime: 0, progress: 0,
    })

    let totalSteps = 0
    try {
      const result = await transport.prepare((stage) => {
        if (generation === this.generation) this.patch({ stage })
      })
      totalSteps = result.totalSteps
    } catch (err) {
      if (generation !== this.generation) return
      this.patch({
        status: 'error', stage: null,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // The operator stopped or restarted while `prepare` was in flight.
    if (generation !== this.generation) return

    this.patch({ status: 'running', stage: null, totalSteps })
    this.startLoop()
  }

  /**
   * Start, discarding whatever is currently running.
   *
   * `start()` is idempotent by contract - pressing it twice must never make two
   * loops - which makes it a no-op on an already-running simulation. But START
   * DEMO is not "begin"; it is "restart this sortie as the compressed
   * demonstration", and an operator must be able to press it at any time. So it
   * comes through here, where the current run is torn down first.
   */
  async restart(): Promise<void> {
    this.epoch += 1
    this.generation += 1
    this.teardown()
    this.patch({ status: 'idle', stage: null, error: null })
    await this.start()
  }

  async pause(): Promise<void> {
    if (this.snapshot.status !== 'running') return
    this.epoch += 1
    // Held immediately, before the command has even gone out: the interface
    // must stop on the press, not on the round trip. The loop keeps its handle
    // but the tick returns at once, so RESUME continues from this index rather
    // than re-preparing the source.
    this.patch({ status: 'paused' })
    const at = await this.transport?.pause()
    // Then settle onto the sample the source actually stopped on. Optimistic
    // holding leaves the console a fraction of a tick behind the server, and
    // the index on screen has to be the one the twin is holding at.
    if (at && Number.isFinite(at.t)) this.settle(at.t)
  }

  /** Move the held clock to a known sample without leaving the held state. */
  private settle(t: number): void {
    if (this.snapshot.status === 'running') return
    this.clock.t = t
    this.clock.dt = 0
    this.patch({ currentTime: t, currentIndex: Math.round(t) })
  }

  async resume(): Promise<void> {
    if (this.snapshot.status !== 'paused') return
    this.epoch += 1
    await this.transport?.resume()
    this.patch({ status: 'running' })
    // A run that was stopped and then resumed has no loop; one that was merely
    // paused does. Either way this leaves exactly one.
    if (this.timer === null) this.startLoop()
  }

  async stop(): Promise<void> {
    const { status } = this.snapshot
    if (status === 'idle' || status === 'stopped' || status === 'stopping') return
    this.epoch += 1
    this.generation += 1
    this.patch({ status: 'stopping' })
    this.teardown()
    await this.transport?.stop()
    this.patch({ status: 'stopped', stage: null })
  }

  /** Back to a cold, restartable state. Everything derived is cleared by the
   *  listeners; this clears the clock. */
  async reset(): Promise<void> {
    this.epoch += 1
    this.generation += 1
    this.teardown()
    this.clock.t = 0
    this.clock.dt = 0
    await this.transport?.reset()
    this.patch({
      status: 'idle', stage: null, error: null,
      currentIndex: 0, currentTime: 0, progress: 0,
    })
  }

  /**
   * Advance exactly one dataset timestep, then hold again.
   *
   * Only meaningful while held - stepping a running simulation would race the
   * loop for the same index.
   */
  async step(): Promise<void> {
    const { status } = this.snapshot
    if (status !== 'paused' && status !== 'stopped' && status !== 'completed') return
    this.epoch += 1
    const landed = await this.transport?.stepOnce()
    if (this.transport?.kind === 'LOCAL') {
      // The local model owns its clock, so the engine moves it: one 1 Hz
      // sample, no more, and the frame listeners run once.
      this.advanceBy(1)
    } else if (landed && Number.isFinite(landed.t)) {
      // The backend advanced its own clock. Frames are gated off while held,
      // so the step's own answer is how the engine learns where it landed -
      // without it the controls would step the twin and show the old index.
      this.clock.t = landed.t
      this.clock.dt = 1
      this.patch({ currentTime: landed.t, currentIndex: Math.round(landed.t) })
      this.clock.dt = 0
    }
    // Status is unchanged on purpose: STEP leaves the simulation held.
  }

  async setSpeed(speed: number): Promise<void> {
    const clamped = Math.max(0.5, Math.min(400, speed))
    if (clamped === this.snapshot.speed) return
    // Changing rate must not resume a held simulation, and must not spawn a
    // second loop - the tick reads `speed` from the snapshot, so there is
    // nothing to restart.
    this.patch({ speed: clamped })
    await this.transport?.setSpeed(clamped)
  }

  /** Release the timer. Safe to call in any state, any number of times. */
  dispose(): void {
    this.generation += 1
    this.teardown()
  }

  // -- the loop -----------------------------------------------------------

  private startLoop(): void {
    if (this.timer !== null) return          // the no-second-loop invariant
    // Only the local model needs a clock of its own. The backend advances
    // itself and pushes frames, so a second timer here would be exactly the
    // duplicate clock this class was written to remove.
    if (this.transport?.kind !== 'LOCAL') return
    this.timer = this.scheduler.setInterval(() => this.tick(), TICK_MS)
  }

  private teardown(): void {
    if (this.timer === null) return
    this.scheduler.clearInterval(this.timer)
    this.timer = null
    this.clock.running = false
    this.clock.dt = 0
  }

  private tick(): void {
    // The whole of PAUSE, in one line. Nothing downstream of here runs while
    // the status is anything but 'running'.
    if (this.snapshot.status !== 'running') return
    this.advanceBy((TICK_MS / 1000) * this.snapshot.speed)
  }

  private advanceBy(dt: number): void {
    const total = this.snapshot.totalSteps
    // Clamp before advancing the source, not after: a source that wraps at its
    // own duration would otherwise be stepped back to t=0 for the final frame,
    // and the last thing on screen would be the start of the sortie.
    const capped = total > 0 ? Math.min(dt, Math.max(0, total - this.clock.t)) : dt
    const done = total > 0 && capped < dt

    this.clock.dt = capped
    this.clock.t += capped
    if (capped > 0) this.transport?.advance(capped)

    const t = this.clock.t
    this.advanceListeners.forEach((fn) => fn(capped, t))

    if (done) {
      this.teardown()
      this.patch({ status: 'completed', currentTime: t, currentIndex: Math.round(t) })
      return
    }
    // LIVE gets its index from `observeFrame`; LOCAL has no other source.
    if (this.transport?.kind === 'LOCAL') {
      this.patch({ currentTime: t, currentIndex: Math.round(t) })
    }
  }
}

/** True when the status means "simulation time is not moving". */
export function isHeld(status: SimStatus): boolean {
  return status !== 'running'
}
