/**
 * Flight model for the 3D scene.
 *
 * The UAV does not orbit a pivot - it flies. A waypoint follower steers toward
 * the active leg, the bank angle comes out of the turn rate rather than being
 * animated for looks, and altitude and speed track the mission phase reported
 * by the twin. The result is that what the operator sees in 3D is the same
 * sortie the telemetry page is charting.
 *
 * World units: 1 unit = 1 km of sector grid. Altitude is exaggerated 4x,
 * because a MALE UAV at 15,000 ft over a 200 km sector is otherwise a dot on
 * a flat plane.
 */

import * as THREE from 'three'
import { ALT_EXAGGERATION, FT_TO_KM, terrainHeight } from './terrain'

export { ALT_EXAGGERATION, FT_TO_KM }

/** Minimum clearance held above the terrain, in world units (~90 m). */
const GROUND_CLEARANCE = 0.36

/** Vertical rate limits, ft/s of rendered time. */
const MAX_CLIMB_FPS = 900
const MAX_DESCENT_FPS = 1100

/*
 * Descent rate under a recall.
 *
 * The limits above are not flight-model figures; they exist so the aircraft
 * can catch up with a ground station running at twenty times real time, and at
 * 1100 ft/s a recall from the ISR orbit is over before the eye registers it.
 *
 * A diversion is the one case the console is flying on its own authority, so
 * it gets a rate an aeroplane would actually use: 1500 ft/min. Simulated time
 * is still scaled, so that is roughly half a minute of wall clock from cruise
 * to circuit height - long enough to watch, short enough to demonstrate.
 */
const DIVERT_DESCENT_FPS = 25

export interface RouteLeg {
  id: string
  x: number
  y: number
  altitudeFt: number
  speedKt: number
}

export interface FlightState {
  position: THREE.Vector3
  heading: number          // radians, 0 = +Z (north)
  bank: number             // radians
  pitch: number            // radians
  speedKt: number
  altitudeFt: number
  legIndex: number
  legLabel: string
  distanceToNextKm: number
  progress: number
}

const KT_TO_KM_S = 1.852 / 3600

export class FlightDynamics {
  state: FlightState
  /**
   * Stopped where it is.
   *
   * An abort is not a pause and not a reset: the aircraft holds its last
   * position and every number on the console keeps the value it had at the
   * moment the operator called it. So the integrator returns without touching
   * anything rather than being unmounted or wound back.
   */
  frozen = false
  /**
   * On the ground, or climbing out, but not yet flying the route.
   *
   * The launch needs an aircraft that gains height without going anywhere: one
   * that starts tracking to WP-01 the instant the engine catches has not taken
   * off, it has teleported. While this is set the integrator runs the vertical
   * axis only and leaves the ground position where it is.
   */
  groundHold = true
  /** True once the planned route has been replaced by a diversion, so a
   *  sector update cannot quietly put the aircraft back on the mission. */
  diverted = false
  /** The altitude the aircraft was at when it was recalled. The descent
   *  profile is capped by this so a recall can never command a climb. */
  divertCeilingFt = 0
  /** How far from the field the aircraft was when it was recalled. The descent
   *  is spread over this, so it begins on the command rather than waiting for
   *  a fixed glidepath to catch up with an aircraft a sector away. */
  divertRangeKm = 0
  private plan: RouteLeg[] = []
  private route: RouteLeg[] = []
  private target = 0
  private turnRate = 0
  private travelled = 0
  private totalLength = 1

  constructor() {
    this.state = {
      position: new THREE.Vector3(18, 0.02, 22),
      heading: Math.PI * 0.25,
      bank: 0,
      pitch: 0,
      speedKt: 0,
      altitudeFt: 0,
      legIndex: 0,
      legLabel: 'BASE ALPHA',
      distanceToNextKm: 0,
      progress: 0,
    }
  }

  setRoute(route: RouteLeg[]) {
    if (!route.length) return
    // The plan is remembered whatever happens next, so a diversion can be
    // undone without having to rebuild it from the sector.
    this.plan = route
    // A diversion outranks the plan. Without this a sector frame arriving
    // mid-return would put the aircraft back on the mission route it was
    // just recalled from.
    if (this.diverted) return
    this.route = route
    this.totalLength = route.reduce((sum, leg, i) => {
      if (i === 0) return 0
      const prev = route[i - 1]
      return sum + Math.hypot(leg.x - prev.x, leg.y - prev.y)
    }, 0) || 1
    if (this.target === 0) {
      const first = route[0]
      this.state.position.set(
        first.x,
        Math.max(
          terrainHeight(first.x, first.y) + GROUND_CLEARANCE,
          first.altitudeFt * FT_TO_KM * ALT_EXAGGERATION,
        ),
        first.y,
      )
      this.target = 1
    }
  }

  /** Snap toward an authoritative position from the backend, gently. */
  reconcile(x: number, y: number, altitudeFt: number, blend = 0.02) {
    const targetY = Math.max(
      terrainHeight(x, y) + GROUND_CLEARANCE,
      altitudeFt * FT_TO_KM * ALT_EXAGGERATION,
    )
    this.state.position.x += (x - this.state.position.x) * blend
    this.state.position.z += (y - this.state.position.z) * blend
    this.state.position.y += (targetY - this.state.position.y) * blend * 2
  }

  /**
   * Jump straight to a cruise state.
   *
   * The model does not integrate while the stage is parked behind the intro,
   * so on the way out the aircraft would otherwise be sitting on the runway
   * while the telemetry says ISR loiter at 14,000 ft. This puts it where the
   * mission says it is instead of flying a fifteen-second climb nobody asked
   * to watch.
   */
  warmStart(altitudeFt: number, speedKt: number) {
    const s = this.state
    if (altitudeFt <= s.altitudeFt) return
    s.altitudeFt = altitudeFt
    s.speedKt = Math.max(s.speedKt, speedKt)
    const ground = terrainHeight(s.position.x, s.position.z)
    s.position.y = Math.max(
      ground + GROUND_CLEARANCE,
      s.altitudeFt * FT_TO_KM * ALT_EXAGGERATION,
    )
  }

  step(dt: number, commandedAltFt: number, commandedSpeedKt: number) {
    if (this.frozen) return this.state
    if (!this.route.length) return this.state

    /* Climbing out. Height and speed build; the ground track does not move.
       The same integrator with the horizontal terms switched off, so the state
       the rest of the console reads stays continuous through the transition
       rather than being handed between two models. */
    if (this.groundHold) {
      const s0 = this.state
      const climb = (3200 / 60) * dt                 // 3200 ft/min, watchable
      s0.altitudeFt += Math.max(-climb, Math.min(climb, commandedAltFt - s0.altitudeFt))
      s0.speedKt += (commandedSpeedKt - s0.speedKt) * Math.min(1, dt * 0.5)
      const remaining = commandedAltFt - s0.altitudeFt
      s0.pitch = Math.max(0, Math.min(0.16, remaining * 0.00016))
      s0.bank = 0
      s0.position.y = Math.max(
        terrainHeight(s0.position.x, s0.position.z) + GROUND_CLEARANCE,
        s0.altitudeFt * FT_TO_KM * ALT_EXAGGERATION,
      )
      return s0
    }
    const s = this.state
    const leg = this.route[Math.min(this.target, this.route.length - 1)]

    // --- steering ------------------------------------------------------
    const dx = leg.x - s.position.x
    const dz = leg.y - s.position.z
    const distance = Math.hypot(dx, dz)
    s.distanceToNextKm = distance

    const desired = Math.atan2(dx, dz)
    let error = desired - s.heading
    while (error > Math.PI) error -= Math.PI * 2
    while (error < -Math.PI) error += Math.PI * 2

    // Proportional heading hold with a rate limit - a MALE UAV does not
    // snap onto a new heading, it rolls into a standard-rate turn.
    const maxRate = 0.16                              // rad/s
    const commandedRate = Math.max(-maxRate, Math.min(maxRate, error * 0.55))
    this.turnRate += (commandedRate - this.turnRate) * Math.min(1, dt * 1.6)
    s.heading += this.turnRate * dt

    // Bank follows the turn: tan(phi) = V * omega / g
    const speedMs = Math.max(1, s.speedKt * 0.5144)
    const bankTarget = Math.atan((speedMs * this.turnRate) / 9.81)
    s.bank += (Math.max(-0.62, Math.min(0.62, bankTarget)) - s.bank) * Math.min(1, dt * 2.2)

    // --- speed ---------------------------------------------------------
    const speedTarget = Math.max(0, commandedSpeedKt)
    s.speedKt += (speedTarget - s.speedKt) * Math.min(1, dt * 0.35)

    // --- altitude ------------------------------------------------------
    // The twin replays a sortie far faster than real time, so the rendered
    // aircraft has to climb faster than a real one or it sits at circuit
    // height while the telemetry says it is in the ISR orbit. The rate is
    // still limited, so the motion reads as a climb rather than a jump.
    const altTarget = Math.max(0, commandedAltFt)
    const altError = altTarget - s.altitudeFt
    const maxDown = this.diverted ? DIVERT_DESCENT_FPS : MAX_DESCENT_FPS
    const climbRate = Math.max(-maxDown, Math.min(MAX_CLIMB_FPS, altError * 0.65))
    /* Never past the target. The rate is an exponential approach, so with a
       large enough step it would sail through the commanded altitude and come
       back harder - clamping the increment to the error left makes that
       impossible whatever the timestep turns out to be. */
    const climbStep = climbRate * dt
    s.altitudeFt += Math.sign(altError) === Math.sign(climbStep)
      ? Math.sign(altError) * Math.min(Math.abs(climbStep), Math.abs(altError))
      : climbStep
    s.pitch += ((climbRate / 2600) - s.pitch) * Math.min(1, dt * 1.4)
    s.pitch = Math.max(-0.16, Math.min(0.2, s.pitch))

    // --- integrate -----------------------------------------------------
    const groundSpeedKmS = s.speedKt * KT_TO_KM_S
    const step = groundSpeedKmS * dt
    s.position.x += Math.sin(s.heading) * step
    s.position.z += Math.cos(s.heading) * step

    // Altitude is above the airbase datum, and the ground rises downrange, so
    // the rendered height is floored against the terrain beneath the aircraft.
    // Without this the UAV flies through the ridge on the climb-out leg.
    const ground = terrainHeight(s.position.x, s.position.z)
    s.position.y = Math.max(
      ground + GROUND_CLEARANCE,
      s.altitudeFt * FT_TO_KM * ALT_EXAGGERATION,
    )

    this.travelled += step
    s.progress = Math.min(1, this.travelled / this.totalLength)

    // --- waypoint capture ----------------------------------------------
    if (distance < Math.max(2.5, groundSpeedKmS * 12)) {
      this.target = (this.target + 1) % this.route.length
      s.legIndex = this.target
      s.legLabel = this.route[this.target].id
      if (this.target === 0) this.travelled = 0
    }

    return s
  }

  /**
   * Leave the mission and route home from wherever the aircraft is.
   *
   * The diversion starts at the current position rather than at the next
   * waypoint - that is the whole point of a recall. Two legs: where it is now,
   * and the field. The aircraft flies it with the same integrator as the
   * mission route, so it turns onto the new heading rather than snapping to it.
   */
  divertToBase(base: { x: number; y: number; altitudeFt?: number; speedKt?: number }): RouteLeg[] {
    const here = this.state
    const leg: RouteLeg[] = [
      {
        id: 'DIVERT',
        x: here.position.x,
        y: here.position.z,
        altitudeFt: here.altitudeFt,
        speedKt: Math.max(70, here.speedKt),
      },
      {
        id: 'BASE',
        x: base.x,
        y: base.y,
        // Circuit height at the field. The model's own rate limiter turns the
        // difference into a steady descent rather than a drop - a recall from
        // the ISR orbit is a long way down and has to read as a descent.
        altitudeFt: base.altitudeFt ?? 900,
        speedKt: base.speedKt ?? 96,
      },
    ]
    this.route = leg
    this.diverted = true
    this.divertCeilingFt = here.altitudeFt
    this.divertRangeKm = Math.hypot(base.x - here.position.x, base.y - here.position.z)
    this.target = 1
    this.travelled = 0
    this.totalLength = Math.hypot(base.x - here.position.x, base.y - here.position.z) || 1
    return leg
  }

  /** How far the aircraft still is from a point, in km. */
  distanceTo(x: number, y: number): number {
    return Math.hypot(x - this.state.position.x, y - this.state.position.z)
  }

  /**
   * The altitude a recalled aircraft should be flying, at this range.
   *
   * A fixed glidepath - three degrees, 318 ft per kilometre - is the right
   * shape for an approach and the wrong one for a recall. From the ISR orbit
   * the field is 190 km away, and a three-degree path from there starts at
   * sixty thousand feet: the profile sits far above the aircraft, the command
   * clamps to the altitude it was recalled at, and it holds cruise for three
   * quarters of the way home. The operator presses RETURN TO BASE, watches the
   * altimeter hold fourteen thousand, and reasonably concludes nothing
   * happened.
   *
   * So the height to lose is spread over the range there was to run at the
   * moment of the command. The descent begins on the command, and still
   * arrives at circuit height overhead the field whether the recall came from
   * the orbit or from the circuit.
   */
  divertProfileFt(rangeKm: number, circuitFt = 900): number {
    const ceiling = this.divertCeilingFt || this.state.altitudeFt
    const span = this.divertRangeKm
    // A recall given overhead has no span to spread a descent over.
    const remaining = span > 0.5 ? Math.max(0, Math.min(1, rangeKm / span)) : 0
    const profile = circuitFt + (ceiling - circuitFt) * remaining
    /* Never above where the aircraft already is. The range grows while it
       turns onto the new heading, and a recall that answers that with a climb
       is not a recall. */
    return Math.min(ceiling, this.state.altitudeFt, profile)
  }

  /** Put the aircraft back on the planned mission route. */
  restorePlan() {
    this.diverted = false
    this.divertCeilingFt = 0
    this.divertRangeKm = 0
    this.frozen = false
    if (this.plan.length) {
      this.route = this.plan
      this.target = 1
      this.travelled = 0
      this.totalLength = this.plan.reduce((sum, l, i) => (
        i === 0 ? 0 : sum + Math.hypot(l.x - this.plan[i - 1].x, l.y - this.plan[i - 1].y)
      ), 0) || 1
    }
  }

  get activeLeg() {
    return this.route[Math.min(this.target, this.route.length - 1)]
  }

  get routeLength() {
    return this.route.length
  }
}

/** Default sector route, used until the backend's sector plan arrives. */
export const FALLBACK_ROUTE: RouteLeg[] = [
  { id: 'BASE', x: 18, y: 22, altitudeFt: 900, speedKt: 72 },
  { id: 'WP-01', x: 48, y: 74, altitudeFt: 12800, speedKt: 92 },
  { id: 'WP-02', x: 104, y: 118, altitudeFt: 14400, speedKt: 104 },
  { id: 'ISR', x: 168, y: 144, altitudeFt: 15400, speedKt: 86 },
  { id: 'ISR-A', x: 182, y: 156, altitudeFt: 15400, speedKt: 86 },
  { id: 'ISR-B', x: 168, y: 162, altitudeFt: 15400, speedKt: 86 },
  { id: 'ISR-C', x: 154, y: 150, altitudeFt: 15400, speedKt: 86 },
  { id: 'WP-03', x: 112, y: 66, altitudeFt: 11000, speedKt: 108 },
  { id: 'RTB', x: 46, y: 34, altitudeFt: 3600, speedKt: 96 },
]

export function routeFromSector(waypoints: Array<{ id: string; x: number; y: number }>, orbit: Array<{ x: number; y: number }>): RouteLeg[] {
  if (!waypoints.length) return FALLBACK_ROUTE
  const altitudeFor = (id: string) => {
    if (id === 'BASE') return 900
    if (id === 'WP-01') return 12800
    if (id === 'WP-02') return 14400
    if (id.startsWith('ISR')) return 15400
    if (id === 'WP-03') return 11000
    return 3600
  }
  const speedFor = (id: string) => (id.startsWith('ISR') ? 86 : id === 'BASE' ? 74 : 100)

  const legs: RouteLeg[] = []
  for (const wp of waypoints) {
    if (wp.id === 'ISR') {
      // Fly the published orbit rather than cutting the corner.
      const sampled = orbit.filter((_, i) => i % 8 === 0)
      sampled.forEach((point, i) => {
        legs.push({ id: `ISR-${i}`, x: point.x, y: point.y, altitudeFt: 15400, speedKt: 86 })
      })
      continue
    }
    legs.push({
      id: wp.id,
      x: wp.x,
      y: wp.y,
      altitudeFt: altitudeFor(wp.id),
      speedKt: speedFor(wp.id),
    })
  }
  return legs.length ? legs : FALLBACK_ROUTE
}

/**
 * One flight model instance for the whole application.
 *
 * The 3D stage integrates it and the HUD reads it, so the numbers on the
 * overlay are the same numbers driving the aircraft rather than a second
 * animation that happens to look similar.
 */
export const flightDynamics = new FlightDynamics()
