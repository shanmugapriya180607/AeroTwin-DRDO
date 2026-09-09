/**
 * The operator's options.
 *
 * AeroTwin does not fly the aircraft: it says what it would do and a person
 * decides. The regression these guard is the console quietly making that
 * decision by withholding controls - RETURN TO BASE appearing only once the
 * engine looked bad enough, and ABORT MISSION only at CRITICAL, so an operator
 * who wanted to recall or abort a healthy aircraft had no button to do it
 * with.
 *
 * What the risk level is allowed to change is which command is *advised*.
 */

import { describe, expect, it } from 'vitest'
import { assess } from './decision'
import type { AlertFrame, Anomaly, EngineSummary } from '../types'

function engine(over: Partial<EngineSummary> = {}): EngineSummary {
  return { status: 'NORMAL', health_index: 98, ...over } as EngineSummary
}

function finding(over: Partial<Anomaly> = {}): Anomaly {
  return {
    id: 'A', severity: 'MEDIUM', score: 0.5, cylinder: 2, abstained: false, ...over,
  } as Anomaly
}

function alerts(over: Partial<AlertFrame> = {}): AlertFrame {
  return { anomalies: [], advisories: [], threshold: [], engine_state: 'NORMAL', engine_reason: '', ...over } as AlertFrame
}

/** One case per risk band the assessment can reach. */
const CASES: Array<[string, EngineSummary, AlertFrame]> = [
  ['nominal', engine(), alerts()],
  ['moderate', engine({ health_index: 88 }), alerts({ anomalies: [finding()] })],
  ['high', engine({ status: 'DEGRADED', health_index: 84 }), alerts({ engine_state: 'DEGRADED' })],
  ['critical', engine({ status: 'CRITICAL', health_index: 52 }), alerts({ engine_state: 'CRITICAL' })],
]

describe('operator commands', () => {
  it('offers continue, return and abort at every risk level', () => {
    for (const [name, e, a] of CASES) {
      const view = assess(e, a)
      expect(view.commands, `${name}: missing a command`).toEqual([
        'CONTINUE', 'RETURN_TO_BASE', 'ABORT',
      ])
    }
  })

  it('advises one of the commands it offers', () => {
    for (const [name, e, a] of CASES) {
      const view = assess(e, a)
      expect(view.commands, `${name}`).toContain(view.advised)
    }
  })

  it('advises returning as the picture worsens, and continuing when it is clean', () => {
    expect(assess(...([CASES[0][1], CASES[0][2]] as const)).advised).toBe('CONTINUE')
    expect(assess(...([CASES[2][1], CASES[2][2]] as const)).advised).toBe('RETURN_TO_BASE')
    expect(assess(...([CASES[3][1], CASES[3][2]] as const)).advised).toBe('RETURN_TO_BASE')
  })

  it('states a reason for every recommendation', () => {
    for (const [name, e, a] of CASES) {
      expect(assess(e, a).because, `${name}`).toBeTruthy()
    }
  })

  it('an abstained finding does not raise the risk', () => {
    const view = assess(engine(), alerts({ anomalies: [finding({ abstained: true, severity: 'HIGH' })] }))
    expect(view.risk).toBe('LOW')
    expect(view.advised).toBe('CONTINUE')
  })

  it('a high-severity finding names the cylinder it was found on', () => {
    const view = assess(engine(), alerts({ anomalies: [finding({ severity: 'HIGH', cylinder: 4 })] }))
    expect(view.risk).toBe('HIGH')
    expect(view.because).toContain('cylinder 4')
  })
})
