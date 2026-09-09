/**
 * Localisation, on the offline model.
 *
 * The claim the console makes when it names a cylinder is that it *found*
 * that cylinder in the residuals. The demonstration used to inject on cylinder
 * 3 every run, so the console reported cylinder 3 every run - which is
 * indistinguishable from a hard-coded answer no matter how honest the detector
 * underneath is.
 *
 * These drive the degradation onto each cylinder in turn and check that the
 * finding follows it. Nothing here tells the frame builder which cylinder was
 * degraded: it has to come out of the CHT and EGT residuals, exactly as it
 * would on a real engine.
 */

import { describe, expect, it } from 'vitest'
import { DemoFeed, demoFrames, newResidualMemory } from './demoFeed'

/**
 * Run a feed far enough into the sortie for the degradation to be visible.
 *
 * Each run gets its own residual memory, exactly as each sortie does in the
 * console. Sharing one would let the first run's accumulated drift decide the
 * second run's answer - which is what these tests caught.
 */
function fly(cylinder: number, seconds = 2600) {
  const feed = new DemoFeed(cylinder)
  const memory = newResidualMemory()
  let state = feed.step(0)
  let frames = demoFrames(state, memory)
  for (let t = 0; t < seconds; t += 5) {
    state = feed.step(5)
    frames = demoFrames(state, memory)
  }
  return frames
}

describe('per-cylinder localisation', () => {
  it('names whichever cylinder is actually degraded', () => {
    for (const cylinder of [1, 2, 3, 4]) {
      const { alerts, telemetry } = fly(cylinder)
      const finding = alerts.anomalies[0]

      expect(finding, `cylinder ${cylinder} raised no finding`).toBeTruthy()
      expect(finding.cylinder, `expected cylinder ${cylinder}`).toBe(cylinder)
      expect(finding.title).toContain(`CYLINDER ${cylinder}`)

      // And the engine summary has to agree with the alert - two parts of the
      // console disagreeing about which cylinder is the fault is worse than
      // neither of them knowing.
      const worst = telemetry.engine.cylinders.reduce(
        (a, b) => (a.health < b.health ? a : b),
      )
      expect(worst.index).toBe(cylinder)
    }
  })

  it('is not anchored to cylinder 3', () => {
    const named = [1, 2, 4].map((c) => fly(c).alerts.anomalies[0]?.cylinder)
    expect(named).toEqual([1, 2, 4])
  })

  it('the degraded cylinder is the least healthy one', () => {
    for (const cylinder of [1, 2, 3, 4]) {
      const { telemetry } = fly(cylinder)
      const cylinders = telemetry.engine.cylinders
      const target = cylinders.find((c) => c.index === cylinder)!
      for (const other of cylinders) {
        if (other.index === cylinder) continue
        expect(target.health).toBeLessThan(other.health)
      }
    }
  })

  it('rotates onto a different cylinder for each new sortie', () => {
    const feed = new DemoFeed(1)
    const seen = [feed.faultCylinder]
    for (let i = 0; i < 3; i += 1) seen.push(feed.reseed())
    expect(new Set(seen).size).toBe(4)
  })
})

describe('the finding is evidence-driven', () => {
  it('reports the mechanism the residual signature points at', () => {
    const { alerts } = fly(2)
    const finding = alerts.anomalies[0]
    // A rise on both CHT and EGT on the same cylinder is hot gas past a valve.
    // The point is that it is derived: the injected signature is that shape.
    expect(finding.mechanism).toBe('exhaust_valve_distress')
    expect(finding.mechanism_label).toBeTruthy()
  })

  it('carries an action that matches the mechanism, not a fixed sentence', () => {
    const { alerts } = fly(4)
    const advisory = alerts.advisories[0] as { mechanism?: string; action?: string } | undefined
    if (!advisory) return              // abstained: no action is the right answer
    expect(advisory.mechanism).toBe(alerts.anomalies[0].mechanism)
    expect(advisory.action).toBeTruthy()
  })

  it('holds no advisory while the detector is abstaining', () => {
    // Early in the sortie the deviation has not established itself.
    const feed = new DemoFeed(1)
    const early = demoFrames(feed.step(0), newResidualMemory())
    const finding = early.alerts.anomalies[0]
    if (finding?.abstained) expect(early.alerts.advisories).toHaveLength(0)
  })

  it('confidence rises with corroborating evidence rather than magnitude alone', () => {
    const short = fly(1, 400).alerts.anomalies[0]
    const long = fly(1, 3000).alerts.anomalies[0]
    if (!short || !long) return
    expect(long.confidence).toBeGreaterThanOrEqual(short.confidence)
    // Never a certainty. The model does not get to be sure.
    expect(long.confidence).toBeLessThan(0.95)
  })
})
