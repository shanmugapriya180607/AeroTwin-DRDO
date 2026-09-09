/**
 * The first-entry film, as data.
 *
 * One rule governs this file: the picture explains, the words label. Every act
 * carries at most a two-word title and a handful of glyph-length markers, and
 * an act that can be understood without any text carries none. What the
 * operator is meant to take away - environment, aircraft, engine, twin,
 * residual, anomaly, advisory - is carried by the camera and the geometry.
 *
 * Nothing here claims the sequence shows measured data. It is a rendered
 * explanation of the method, and the footer says so.
 */

export type ActId =
  | 'HORIZON' | 'CONTACT' | 'AIRFRAME' | 'SCAN' | 'SYNC'
  | 'ENGINE' | 'MODES' | 'SENSE' | 'RESIDUAL' | 'ANOMALY'
  | 'AI' | 'ADVISORY' | 'BRAND'

export interface Act {
  id: ActId
  /** Chapter label in the rail. */
  chapter: string
  /** Seconds. The last act runs until the operator enters. */
  duration: number
  /** The single word or short pair shown over the frame. Empty means silence. */
  title: string
  /** A monospace marker under it - an identifier or a reading, never a phrase. */
  marker: string
}

export const ACTS: Act[] = [
  { id: 'HORIZON',  chapter: 'RANGE',       duration: 7.0,  title: '',              marker: '' },
  { id: 'CONTACT',  chapter: 'CONTACT',     duration: 6.5,  title: '',              marker: 'UAV-01' },
  { id: 'AIRFRAME', chapter: 'AIRFRAME',    duration: 7.5,  title: 'UAV-01',        marker: 'ISR' },
  { id: 'SCAN',     chapter: 'DIGITAL TWIN',duration: 9.0,  title: 'AEROTWIN',      marker: 'PROPULSION INTELLIGENCE' },
  { id: 'SYNC',     chapter: 'TWIN SYNC',   duration: 7.0,  title: '',              marker: 'SYNC 99.3%' },
  { id: 'ENGINE',   chapter: 'PROPULSION',  duration: 8.0,  title: 'ENGINE',        marker: 'AERO-01' },
  { id: 'MODES',    chapter: 'ENGINE',      duration: 10.0, title: '',              marker: '' },
  { id: 'SENSE',    chapter: 'TELEMETRY',   duration: 6.0,  title: 'TELEMETRY',     marker: '' },
  { id: 'RESIDUAL', chapter: 'RESIDUAL',    duration: 7.5,  title: '',              marker: '' },
  { id: 'ANOMALY',  chapter: 'ANOMALY',     duration: 8.5,  title: 'ANOMALY',       marker: 'CYL 3' },
  { id: 'AI',       chapter: 'AI',          duration: 6.5,  title: '',              marker: '' },
  { id: 'ADVISORY', chapter: 'MAINTENANCE', duration: 5.5,  title: 'MAINTENANCE',   marker: 'CYL 3 · INSPECT' },
  { id: 'BRAND',    chapter: 'ENTER',       duration: 3600, title: 'AEROTWIN',      marker: 'PROPULSION INTELLIGENCE' },
]

/** The three words under the wordmark on the final frame. */
export const PILLARS = ['MONITOR', 'PREDICT', 'MAINTAIN']

/** Sensor channels that light up on the engine during SENSE. */
export const SENSORS = ['CHT', 'EGT', 'RPM', 'PRESSURE']

/** The four engine views walked through during MODES, in order. */
export const ENGINE_MODES = ['PHYSICAL', 'THERMAL', 'AIRFLOW', 'DIGITAL TWIN'] as const

export const ACT_STARTS: number[] = ACTS.reduce<number[]>((acc, _act, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + ACTS[i - 1].duration)
  return acc
}, [])

export const TOTAL_BEFORE_BRAND = ACT_STARTS[ACTS.length - 1]

/** Index lookup, so the scene can compare against a name rather than a number. */
export const ACT: Record<ActId, number> = ACTS.reduce((acc, a, i) => {
  acc[a.id] = i
  return acc
}, {} as Record<ActId, number>)

/** Which act is running at t seconds, and how far through it we are. */
export function actAt(t: number): { index: number; progress: number } {
  let index = 0
  for (let i = 0; i < ACTS.length; i += 1) {
    if (t >= ACT_STARTS[i]) index = i
  }
  const local = t - ACT_STARTS[index]
  return { index, progress: Math.max(0, Math.min(1, local / ACTS[index].duration)) }
}

/* ---------------------------------------------------------------- easing -- */

export const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeIn = (t: number) => t * t * t

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Ramp up, hold, ramp down - for anything that appears and then leaves. */
export const pulse = (x: number, inA: number, inB: number, outA: number, outB: number) =>
  smoothstep(inA, inB, x) * (1 - smoothstep(outA, outB, x))
