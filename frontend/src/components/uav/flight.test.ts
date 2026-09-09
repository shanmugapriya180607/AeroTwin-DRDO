/**
 * The recall.
 *
 * RETURN TO BASE is the one command in the console where AeroTwin flies the
 * aircraft on its own authority, so it is the one that has to be visibly true:
 * the altimeter has to answer the button. The regression these guard is a
 * recall that changed the ground track and nothing else - an aeroplane heading
 * home at fourteen thousand feet, still in the ISR cruise, for three quarters
 * of the transit, because the descent was hung off a fixed three-degree
 * glidepath that started sixty thousand feet above it.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { FlightDynamics, type RouteLeg } from './flight'

const BASE = { x: 18, y: 22 }
const ISR = { x: 168, y: 144 }
const CRUISE_FT = 14000

const ROUTE: RouteLeg[] = [
  { id: 'BASE', x: 18, y: 22, altitudeFt: 900, speedKt: 72 },
  { id: 'ISR', x: 168, y: 144, altitudeFt: 15400, speedKt: 86 },
]

/** An aircraft on station in the ISR orbit, at cruise. */
function onStation(): FlightDynamics {
  const air = new FlightDynamics()
  air.setRoute(ROUTE)
  air.groundHold = false
  air.state.position.set(ISR.x, 0, ISR.y)
  air.state.altitudeFt = CRUISE_FT
  air.state.speedKt = 86
  return air
}

describe('recall', () => {
  let air: FlightDynamics

  beforeEach(() => {
    air = onStation()
  })

  it('routes home from where the aircraft is, not from the next waypoint', () => {
    const legs = air.divertToBase(BASE)
    expect(legs[0].x).toBeCloseTo(ISR.x, 3)
    expect(legs[0].y).toBeCloseTo(ISR.y, 3)
    expect(legs[1].x).toBeCloseTo(BASE.x, 3)
    expect(legs[1].y).toBeCloseTo(BASE.y, 3)
    expect(air.diverted).toBe(true)
    expect(air.divertRangeKm).toBeCloseTo(Math.hypot(150, 122), 3)
  })

  it('starts descending on the command, not a sector later', () => {
    air.divertToBase(BASE)
    const span = air.divertRangeKm

    // Five kilometres into a 193 km transit the aircraft must already be
    // coming down. Under the old glidepath it held cruise until 44 km to run.
    const commanded = air.divertProfileFt(span - 5, 900)
    expect(commanded).toBeLessThan(CRUISE_FT)

    // And the descent has to be proportionate: a few hundred feet in the first
    // five kilometres, not a dive.
    expect(CRUISE_FT - commanded).toBeGreaterThan(100)
    expect(CRUISE_FT - commanded).toBeLessThan(900)
  })

  it('is at circuit height overhead the field', () => {
    air.divertToBase(BASE)
    expect(air.divertProfileFt(0, 900)).toBeCloseTo(900, 0)
  })

  it('never commands a climb, even while the range is still growing', () => {
    air.divertToBase(BASE)
    const span = air.divertRangeKm
    // The turn onto the new heading can open the range briefly.
    expect(air.divertProfileFt(span + 12, 900)).toBeLessThanOrEqual(CRUISE_FT)
  })

  it('a recall given overhead the field asks for circuit height, not a climb', () => {
    const low = new FlightDynamics()
    low.setRoute(ROUTE)
    low.groundHold = false
    low.state.position.set(BASE.x, 0, BASE.y)
    low.state.altitudeFt = 400
    low.divertToBase(BASE)
    // Circuit height is above it, so the command holds where it is.
    expect(low.divertProfileFt(0, 900)).toBeLessThanOrEqual(400)
  })

  it('flies the whole transit down to circuit height', () => {
    air.divertToBase(BASE)

    /* Integrated the way the stage integrates it: small fixed steps, with the
       commanded altitude re-read from the profile each step. */
    const dt = 0.05
    for (let i = 0; i < 200_000; i += 1) {
      const range = air.distanceTo(BASE.x, BASE.y)
      if (range < 2.2) break
      const leg = air.activeLeg
      air.step(dt, air.divertProfileFt(range, leg?.altitudeFt ?? 900), leg?.speedKt ?? 96)
    }

    expect(air.distanceTo(BASE.x, BASE.y)).toBeLessThan(2.5)
    // Overhead the field at circuit height - low enough for the stage's own
    // arrival test, which will not close the sortie above 1,500 ft.
    expect(air.state.altitudeFt).toBeLessThan(1500)
    expect(air.state.altitudeFt).toBeGreaterThan(400)
  })

  it('descends monotonically all the way home', () => {
    air.divertToBase(BASE)
    const dt = 0.05
    let previous = air.state.altitudeFt
    for (let i = 0; i < 200_000; i += 1) {
      const range = air.distanceTo(BASE.x, BASE.y)
      if (range < 2.2) break
      const leg = air.activeLeg
      air.step(dt, air.divertProfileFt(range, leg?.altitudeFt ?? 900), leg?.speedKt ?? 96)
      // A metre of tolerance for the integrator, but no climb.
      expect(air.state.altitudeFt).toBeLessThanOrEqual(previous + 3)
      previous = air.state.altitudeFt
    }
  })

  it('putting the aircraft back on the plan clears the diversion', () => {
    air.divertToBase(BASE)
    air.restorePlan()
    expect(air.diverted).toBe(false)
    expect(air.divertCeilingFt).toBe(0)
    expect(air.divertRangeKm).toBe(0)
  })
})
