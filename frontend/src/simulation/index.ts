/**
 * The console's simulation singleton, and the hooks that read it.
 *
 * One engine per tab. Components subscribe through `useSimulation` for state
 * that belongs in a render, and read `simClock` directly inside `useFrame` for
 * state that belongs in an animation frame.
 */

import { useSyncExternalStore } from 'react'
import { SimulationEngine } from './SimulationEngine'
import type { SimStatus, SimulationSnapshot } from './types'

export * from './types'
export { SimulationEngine, TICK_MS, isHeld } from './SimulationEngine'
export { LiveTransport, LocalTransport } from './transports'

export const simulation = new SimulationEngine()

/** The mutable clock. Read this inside render loops; never write to it. */
export const simClock = simulation.clock

/** The whole snapshot. Re-renders on any simulation state change. */
export function useSimulation(): SimulationSnapshot {
  return useSyncExternalStore(
    (fn) => simulation.subscribe(fn),
    () => simulation.getState(),
    () => simulation.getState(),
  )
}

/** Just the status, for the many components that only need to know whether
 *  simulation time is moving. */
export function useSimStatus(): SimStatus {
  return useSyncExternalStore(
    (fn) => simulation.subscribe(fn),
    () => simulation.getState().status,
    () => simulation.getState().status,
  )
}

/** True while simulation time is advancing. The gate for every
 *  simulation-driven animation that lives in React rather than in a frame
 *  loop. Decorative motion does not consult this. */
export function useSimRunning(): boolean {
  return useSimStatus() === 'running'
}

/**
 * Which controls apply in a given state.
 *
 * Kept here rather than in the toolbar so the button set and the state machine
 * cannot drift apart - PAUSE is never offered on an already-held simulation.
 */
export function controlsFor(status: SimStatus) {
  return {
    /** Whether a *cold* start applies. The toolbar does not gate START DEMO on
     *  this - that command restarts the sortie and is valid from any state -
     *  but it is what distinguishes a first start from a restart. */
    canStart: status === 'idle' || status === 'stopped' || status === 'completed' || status === 'error',
    canPause: status === 'running',
    canResume: status === 'paused',
    canStop: status === 'running' || status === 'paused',
    canStep: status === 'paused' || status === 'stopped' || status === 'completed',
    canReset: status !== 'idle' && status !== 'starting',
    busy: status === 'starting' || status === 'stopping',
  }
}
