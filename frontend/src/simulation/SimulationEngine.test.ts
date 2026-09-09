/**
 * The invariants the console's two worst bugs violated.
 *
 * These are not coverage tests. Each one pins a property that, when it broke,
 * produced a demonstration that lied: a paused simulation whose numbers kept
 * moving, or a START button that quietly started a second clock behind the
 * first. They run against a fake scheduler, so a thousand ticks cost nothing
 * and the assertions are exact rather than timing-dependent.
 */

import { describe, expect, it, vi } from 'vitest'
import { SimulationEngine, TICK_MS, type Scheduler } from './SimulationEngine'
import type { SimulationTransport } from './types'

/** A scheduler whose clock only moves when the test moves it. */
function fakeScheduler() {
  const timers = new Map<number, () => void>()
  let next = 1
  let created = 0

  const scheduler: Scheduler = {
    setInterval(fn) {
      created += 1
      const handle = next++
      timers.set(handle, fn)
      return handle
    },
    clearInterval(handle) {
      timers.delete(handle)
    },
    now: () => 0,
  }

  return {
    scheduler,
    /** How many intervals have ever been created. */
    get created() { return created },
    /** How many are live right now. More than one is the bug. */
    get live() { return timers.size },
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        Array.from(timers.values()).forEach((fn) => fn())
      }
    },
  }
}

function fakeTransport(kind: 'LOCAL' | 'LIVE' = 'LOCAL', totalSteps = 0): SimulationTransport & {
  advanced: number
  calls: string[]
} {
  const calls: string[] = []
  return {
    kind,
    advanced: 0,
    calls,
    async prepare(report) {
      calls.push('prepare')
      report('LOADING DATASET')
      return { totalSteps }
    },
    advance(dt) {
      this.advanced += dt
      calls.push('advance')
    },
    stepOnce() { calls.push('stepOnce') },
    setSpeed() { calls.push('setSpeed') },
    pause() { calls.push('pause') },
    resume() { calls.push('resume') },
    stop() { calls.push('stop') },
    reset() { calls.push('reset') },
  } as SimulationTransport & { advanced: number; calls: string[] }
}

/** Build a started engine at 1x, so one tick is TICK_MS of simulation time. */
async function startedEngine(kind: 'LOCAL' | 'LIVE' = 'LOCAL', totalSteps = 0) {
  const sched = fakeScheduler()
  const engine = new SimulationEngine(sched.scheduler)
  const transport = fakeTransport(kind, totalSteps)
  engine.attach(transport)
  await engine.setSpeed(1)
  await engine.start()
  return { engine, transport, sched }
}

describe('SimulationEngine - the single-loop invariant', () => {
  it('start() twice creates exactly one loop', async () => {
    const { engine, sched } = await startedEngine()
    expect(sched.live).toBe(1)

    await engine.start()
    await engine.start()

    expect(sched.live).toBe(1)
    expect(sched.created).toBe(1)
    expect(engine.getState().status).toBe('running')
  })

  it('resume() twice does not create a second loop', async () => {
    const { engine, sched } = await startedEngine()
    engine.pause()
    await engine.resume()
    await engine.resume()
    expect(sched.live).toBe(1)
    expect(engine.getState().status).toBe('running')
  })

  it('start() after stop() leaves one loop, not two', async () => {
    const { engine, sched } = await startedEngine()
    await engine.stop()
    expect(sched.live).toBe(0)
    await engine.start()
    expect(sched.live).toBe(1)
  })

  it('changing speed while running does not restart the loop', async () => {
    const { engine, sched } = await startedEngine()
    await engine.setSpeed(20)
    await engine.setSpeed(60)
    expect(sched.live).toBe(1)
    expect(sched.created).toBe(1)
  })
})

describe('SimulationEngine - PAUSE holds everything', () => {
  it('freezes the index, the time and the clock', async () => {
    const { engine, sched } = await startedEngine()
    sched.tick(10)
    const moving = engine.getState()
    expect(moving.currentTime).toBeGreaterThan(0)

    engine.pause()
    const held = engine.getState()
    sched.tick(100)
    const after = engine.getState()

    expect(after.status).toBe('paused')
    expect(after.currentIndex).toBe(held.currentIndex)
    expect(after.currentTime).toBe(held.currentTime)
    expect(engine.clock.t).toBe(held.currentTime)
    expect(engine.clock.running).toBe(false)
    expect(engine.clock.dt).toBe(0)
  })

  it('stops calling the transport, so the source cannot advance either', async () => {
    const { engine, transport, sched } = await startedEngine()
    sched.tick(5)
    const advanced = transport.advanced
    engine.pause()
    sched.tick(50)
    expect(transport.advanced).toBe(advanced)
  })

  it('fires no advance listeners while held', async () => {
    const { engine, sched } = await startedEngine()
    const listener = vi.fn()
    engine.onAdvance(listener)
    sched.tick(3)
    expect(listener).toHaveBeenCalledTimes(3)
    engine.pause()
    sched.tick(30)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('drops live frames that arrive after the pause command', async () => {
    const { engine } = await startedEngine('LIVE')
    expect(engine.observeFrame(120)).toBe(true)
    engine.pause()
    // A frame already in flight when PAUSE went out.
    expect(engine.observeFrame(140)).toBe(false)
    expect(engine.getState().currentTime).toBe(120)
  })

  it('pause() twice stays safely paused', async () => {
    const { engine } = await startedEngine()
    engine.pause()
    engine.pause()
    expect(engine.getState().status).toBe('paused')
  })

  it('pause() on an idle engine does nothing', () => {
    const engine = new SimulationEngine(fakeScheduler().scheduler)
    engine.pause()
    expect(engine.getState().status).toBe('idle')
  })

  it('changing speed while paused does not resume', async () => {
    const { engine } = await startedEngine()
    engine.pause()
    await engine.setSpeed(200)
    expect(engine.getState().status).toBe('paused')
    expect(engine.getState().speed).toBe(200)
  })
})

describe('SimulationEngine - RESUME continues, it does not restart', () => {
  it('continues from exactly the paused timestep', async () => {
    const { engine, sched } = await startedEngine()
    sched.tick(10)
    engine.pause()
    const at = engine.getState().currentTime
    sched.tick(40)
    await engine.resume()

    expect(engine.getState().currentTime).toBe(at)
    sched.tick(1)
    expect(engine.getState().currentTime).toBeCloseTo(at + TICK_MS / 1000, 6)
  })

  it('does not re-prepare the source', async () => {
    const { engine, transport } = await startedEngine()
    const prepares = transport.calls.filter((c) => c === 'prepare').length
    engine.pause()
    await engine.resume()
    expect(transport.calls.filter((c) => c === 'prepare').length).toBe(prepares)
  })

  it('resume() on a running engine does nothing', async () => {
    const { engine, sched } = await startedEngine()
    await engine.resume()
    expect(sched.live).toBe(1)
    expect(engine.getState().status).toBe('running')
  })
})

describe('SimulationEngine - STEP advances exactly one timestep', () => {
  it('advances one second and holds', async () => {
    const { engine, sched } = await startedEngine()
    sched.tick(4)
    engine.pause()
    const before = engine.getState().currentTime

    await engine.step()

    expect(engine.getState().currentTime).toBeCloseTo(before + 1, 6)
    expect(engine.getState().status).toBe('paused')
  })

  it('does nothing while running - the loop owns the index', async () => {
    const { engine, sched } = await startedEngine()
    sched.tick(2)
    const before = engine.getState().currentTime
    await engine.step()
    expect(engine.getState().currentTime).toBe(before)
  })

  it('steps the source exactly once per press', async () => {
    const { engine, transport } = await startedEngine('LIVE')
    engine.observeFrame(10)
    engine.pause()
    await engine.step()
    await engine.step()
    expect(transport.calls.filter((c) => c === 'stepOnce').length).toBe(2)
  })
})

describe('SimulationEngine - STOP and RESET', () => {
  it('stop() clears the loop and stops advancing', async () => {
    const { engine, sched } = await startedEngine()
    sched.tick(5)
    const at = engine.getState().currentTime
    await engine.stop()

    expect(engine.getState().status).toBe('stopped')
    expect(sched.live).toBe(0)
    sched.tick(50)
    expect(engine.getState().currentTime).toBe(at)
  })

  it('stop() twice stays safely stopped', async () => {
    const { engine } = await startedEngine()
    await engine.stop()
    await engine.stop()
    expect(engine.getState().status).toBe('stopped')
  })

  it('reset() returns to idle with a zeroed clock', async () => {
    const { engine, sched } = await startedEngine()
    sched.tick(9)
    await engine.reset()

    const state = engine.getState()
    expect(state.status).toBe('idle')
    expect(state.currentTime).toBe(0)
    expect(state.currentIndex).toBe(0)
    expect(state.progress).toBe(0)
    expect(engine.clock.t).toBe(0)
    expect(sched.live).toBe(0)
  })
})

describe('SimulationEngine - start-up and failure', () => {
  it('reports each start-up stage before running', async () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    const stages: (string | null)[] = []
    engine.subscribe((s) => { if (s.status === 'starting') stages.push(s.stage) })
    engine.attach(fakeTransport())
    await engine.start()
    expect(stages).toContain('LOADING DATASET')
    expect(engine.getState().status).toBe('running')
  })

  it('surfaces a start failure instead of pretending to run', async () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    const transport = fakeTransport()
    transport.prepare = async () => { throw new Error('BACKEND UNREACHABLE') }
    engine.attach(transport)

    await engine.start()

    expect(engine.getState().status).toBe('error')
    expect(engine.getState().error).toBe('BACKEND UNREACHABLE')
    expect(sched.live).toBe(0)
  })

  it('holds at the end of the source rather than wrapping', async () => {
    // 2 seconds of source at 1x: twenty ticks and it is done.
    const { engine, sched } = await startedEngine('LOCAL', 2)
    sched.tick(40)

    expect(engine.getState().status).toBe('completed')
    expect(engine.getState().currentTime).toBe(2)
    expect(engine.getState().progress).toBe(1)
    expect(sched.live).toBe(0)
  })

  it('adopts a backend that is already paused as paused', () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    engine.attach(fakeTransport('LIVE'))

    engine.adopt(4550, true)

    expect(engine.getState().status).toBe('paused')
    expect(sched.live).toBe(0)
    // and it stays held: a frame in flight must not move it
    expect(engine.observeFrame(99)).toBe(false)
  })

  it('follows the backend when the two disagree about advancing', () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    engine.attach(fakeTransport('LIVE'))
    engine.adopt(4550)

    engine.reconcile(true)
    expect(engine.getState().status).toBe('paused')
    engine.reconcile(false)
    expect(engine.getState().status).toBe('running')
  })

  it('ignores a status snapshot that predates the operator command', async () => {
    // The exact race that let a paused console start advancing again: a status
    // poll issued before PAUSE, answered after it, saying the server is running.
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    engine.attach(fakeTransport('LIVE'))
    engine.adopt(4550)

    const epoch = engine.commandEpoch      // captured as the request goes out
    await engine.pause()                   // the operator presses PAUSE
    engine.reconcile(false, epoch)         // the stale answer lands

    expect(engine.getState().status).toBe('paused')
    expect(engine.observeFrame(500)).toBe(false)
  })

  it('still follows the backend when the snapshot is current', async () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    engine.attach(fakeTransport('LIVE'))
    engine.adopt(4550)
    await engine.pause()

    // A poll issued after the command, reporting the server released elsewhere.
    engine.reconcile(false, engine.commandEpoch)
    expect(engine.getState().status).toBe('running')
  })

  it('settles onto the sample the source actually stopped on', async () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    const transport = fakeTransport('LIVE')
    // The server was a fraction of a tick ahead when the command landed.
    transport.pause = async () => ({ t: 2000 })
    engine.attach(transport)
    engine.adopt(4550)
    engine.observeFrame(1999)

    await engine.pause()

    expect(engine.getState().status).toBe('paused')
    expect(engine.getState().currentTime).toBe(2000)
    expect(engine.getState().currentIndex).toBe(2000)
    expect(engine.clock.t).toBe(2000)
  })

  it('releases a backend an earlier session left held', async () => {
    // The regression this pins: the ground station keeps its paused flag
    // between console sessions, so a stale pause opened the console onto a
    // sortie where not one number moved.
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    const transport = fakeTransport('LIVE')
    engine.attach(transport)
    engine.adopt(4550, true)
    expect(engine.getState().status).toBe('paused')

    await engine.release()

    expect(engine.getState().status).toBe('running')
    expect(transport.calls).toContain('resume')
    expect(engine.observeFrame(120)).toBe(true)
  })

  it('a status poll from before the release cannot re-freeze it', async () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    engine.attach(fakeTransport('LIVE'))
    engine.adopt(4550, true)

    const stale = engine.commandEpoch
    await engine.release()
    engine.reconcile(true, stale)

    expect(engine.getState().status).toBe('running')
  })

  it('adopt() takes over a stream already flowing, but never interrupts', async () => {
    const sched = fakeScheduler()
    const engine = new SimulationEngine(sched.scheduler)
    engine.attach(fakeTransport('LIVE'))

    engine.adopt(4550)
    expect(engine.getState().status).toBe('running')
    expect(engine.getState().totalSteps).toBe(4550)

    engine.pause()
    engine.adopt(4550)
    expect(engine.getState().status).toBe('paused')
  })
})
