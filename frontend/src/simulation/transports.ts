/**
 * The two ways frames reach the console.
 *
 * LIVE is the ground-station backend: it owns a twin loop, a physics model, a
 * residual engine and the learned detector, and it streams the result over
 * four websockets. LOCAL is the reduced model that runs in the browser when no
 * backend answers - a static deployment, or a judge opening the build before
 * anything has been started.
 *
 * Both satisfy the same interface, so the state machine above them, the
 * controls, and every panel behave identically. The only difference the
 * operator ever sees is the provenance badge, which says DEMO for LOCAL on
 * every value it produces.
 */

import { api } from '../services/api'
import { DemoFeed, demoFrames, newResidualMemory } from '../services/demoFeed'
import type { SimulationTransport } from './types'

/** Long enough for the start-up stage to be read, short enough not to be a
 *  wait. The LIVE transport reports the same stages while its calls are in
 *  flight, so both start-ups read the same. */
const STAGE_MS = 190

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/**
 * The backend's twin loop.
 *
 * `advance` is empty on purpose: the backend owns its own clock, so this
 * transport's job is to command it and let `observeFrame` follow the frames it
 * sends back. Every call is checked - a null answer means the backend went
 * away mid-run, and the caller falls back to LOCAL rather than presenting a
 * console whose buttons quietly do nothing.
 */
export class LiveTransport implements SimulationTransport {
  readonly kind = 'LIVE' as const

  constructor(private demo: boolean) {}

  async prepare(report: (stage: string) => void): Promise<{ totalSteps: number }> {
    report('LOADING DATASET')
    const status = await api.systemStatus()
    if (!status) throw new Error('BACKEND UNREACHABLE')

    report('INITIALISING SIMULATION')
    // START DEMO restarts the sortie as the compressed demonstration; a plain
    // start just releases whatever the backend is already replaying.
    const started = this.demo ? await api.startDemo() : await api.resume()
    if (!started) throw new Error('SIMULATION START REFUSED')

    report('INITIALISING DIGITAL TWIN')
    const twin = await api.twinState()
    if (!twin) throw new Error('DIGITAL TWIN UNAVAILABLE')

    report('INITIALISING AI ENGINE')
    // The detector is allowed to be absent: the transparent baseline runs
    // without it and the learned model abstains cleanly. Not a start failure.
    await api.mlStatus()

    report('STARTING TELEMETRY')
    await api.resume()
    await wait(STAGE_MS)

    const duration =
      Number(started.duration_s) ||
      Number(status.mission?.duration_s) ||
      0
    return { totalSteps: duration }
  }

  advance(): void {
    /* the backend advances its own clock */
  }

  async stepOnce(): Promise<{ t: number } | void> {
    const result = await api.step(1)
    if (result && Number.isFinite(result.t)) return { t: Number(result.t) }
    return undefined
  }

  async setSpeed(speed: number): Promise<void> {
    await api.setSpeed(speed)
  }

  async pause(): Promise<{ t: number } | void> {
    const result = await api.pause()
    if (result && Number.isFinite(result.t)) return { t: Number(result.t) }
    return undefined
  }

  async resume(): Promise<{ t: number } | void> {
    const result = await api.resume()
    if (result && Number.isFinite(result.t)) return { t: Number(result.t) }
    return undefined
  }

  async stop(): Promise<void> {
    await api.stopDemo()
    await api.stopReplay()
  }

  async reset(): Promise<void> {
    await api.resetReplay()
  }
}

/**
 * The in-browser reduced model.
 *
 * Owns a `DemoFeed` and nothing else: the engine calls `advance` with the
 * simulation delta and the store's advance listener turns the resulting state
 * into the same frame shapes the websockets deliver. There is no timer in
 * here - that was the bug.
 */
export class LocalTransport implements SimulationTransport {
  readonly kind = 'LOCAL' as const
  readonly feed = new DemoFeed()

  private state = this.feed.step(0)
  /** The residual estimator's running state, owned by the run rather than by
   *  the tab - so starting or resetting a sortie genuinely starts from a clean
   *  baseline instead of inheriting the last one's accumulated CUSUM. */
  private memory = newResidualMemory()

  async prepare(report: (stage: string) => void): Promise<{ totalSteps: number }> {
    report('LOADING DATASET')
    await wait(STAGE_MS)
    report('INITIALISING SIMULATION')
    /* A new sortie degrades the next cylinder round. Nothing downstream is
       told which one - the detector finds it from the residuals - so this is
       what demonstrates that the localisation is a localisation. */
    this.feed.reseed()
    this.feed.seek(0)
    this.memory = newResidualMemory()
    this.state = this.feed.step(0)
    await wait(STAGE_MS)
    report('INITIALISING DIGITAL TWIN')
    await wait(STAGE_MS)
    report('INITIALISING AI ENGINE')
    await wait(STAGE_MS)
    report('STARTING TELEMETRY')
    await wait(STAGE_MS)
    return { totalSteps: this.feed.duration }
  }

  advance(dt: number): void {
    this.state = this.feed.step(dt)
  }

  stepOnce(): void {
    /* Nothing here. The engine follows a local STEP with `advanceBy(1)`,
       which calls `advance` below - stepping the feed here as well would
       advance two samples for one press. */
  }

  setSpeed(): void {
    /* the engine scales the delta it hands to `advance` */
  }

  pause(): void {
    /* nothing to command: the engine simply stops calling `advance` */
  }

  resume(): void {
    /* as above */
  }

  stop(): void {
    /* as above */
  }

  reset(): void {
    this.feed.seek(0)
    this.memory = newResidualMemory()
    this.state = this.feed.step(0)
  }

  /** The frames for the current timestep, in the websocket shapes. */
  frames() {
    return demoFrames(this.state, this.memory)
  }
}
