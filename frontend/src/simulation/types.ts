/**
 * The simulation state machine.
 *
 * One vocabulary, shared by the engine, the controls and every panel that
 * has to know whether what it is drawing is moving or held.
 */

export type SimStatus =
  | 'idle'        // nothing loaded, nothing running
  | 'starting'    // loading data, initialising twin/AI - not yet advancing
  | 'running'     // the clock is advancing
  | 'paused'      // the clock is held; index and time do not change
  | 'stopping'    // tearing the run down
  | 'stopped'     // torn down, restartable
  | 'completed'   // the source was exhausted
  | 'error'       // start-up or the transport failed; `error` says why

/** Where the frames come from. LIVE = the backend's twin loop. LOCAL = the
 *  in-browser reduced model, used when no backend answers. */
export type SimTransport = 'LIVE' | 'LOCAL'

/** The start-up stages, in order. Each is reported as it is entered so the
 *  operator sees what is happening rather than an indefinite spinner. */
export const START_STAGES = [
  'LOADING DATASET',
  'INITIALISING SIMULATION',
  'INITIALISING DIGITAL TWIN',
  'INITIALISING AI ENGINE',
  'STARTING TELEMETRY',
] as const

export type StartStage = (typeof START_STAGES)[number]

export interface SimulationSnapshot {
  status: SimStatus
  transport: SimTransport
  /** Dataset timestep index. Never changes while paused. */
  currentIndex: number
  /** Mission-elapsed seconds. Never changes while paused. */
  currentTime: number
  /** Total timesteps in the loaded source, or 0 when unknown. */
  totalSteps: number
  /** Replay rate against real time. */
  speed: number
  /** 0..1 through the source, or 0 when the length is unknown. */
  progress: number
  /** Which start-up stage is in progress, while `status` is 'starting'. */
  stage: string | null
  /** Populated only in the 'error' status. */
  error: string | null
}

/**
 * The mutable clock.
 *
 * Read directly by `useFrame` and other render loops: they run at display rate
 * and must not force a React render per frame, so they read this object rather
 * than subscribing. `running` is the single gate every simulation-driven
 * animation checks.
 */
export interface SimulationClock {
  /** Mission-elapsed seconds. */
  t: number
  /** Simulation seconds advanced on the last tick. Zero while held. */
  dt: number
  /** True only in the 'running' status. */
  running: boolean
  /** Replay rate, for animations that scale with it. */
  speed: number
}

/**
 * What a transport has to provide.
 *
 * LIVE talks to the backend, which owns its own clock; LOCAL advances the
 * in-browser model. The engine drives both through this one interface, so the
 * state machine above is identical in either mode.
 */
export interface SimulationTransport {
  readonly kind: SimTransport
  /** Load and initialise. Reports each stage as it starts. Throws to fail. */
  prepare(report: (stage: string) => void): Promise<{ totalSteps: number }>
  /** Advance by `dt` simulation seconds. LIVE is a no-op: the backend
   *  advances its own clock and the engine follows the frames it sends. */
  advance(dt: number): void
  /** Advance exactly one 1 Hz timestep while held.
   *
   *  A transport that owns its own clock - the backend - reports the time it
   *  landed on, because the engine has no other way to learn it: frames are
   *  gated off while held, which is the whole point of being held. */
  stepOnce(): Promise<{ t: number } | void> | { t: number } | void
  setSpeed(speed: number): Promise<void> | void
  /** Hold. A transport with its own clock reports the sample it stopped on,
   *  so the console can show the index the twin is actually holding at rather
   *  than the last one that reached it before the command went out. */
  pause(): Promise<{ t: number } | void> | { t: number } | void
  resume(): Promise<{ t: number } | void> | { t: number } | void
  stop(): Promise<void> | void
  reset(): Promise<void> | void
}
