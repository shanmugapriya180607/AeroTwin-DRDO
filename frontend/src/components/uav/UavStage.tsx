/**
 * The persistent 3D stage.
 *
 * One WebGL canvas exists for the whole application and it never unmounts.
 * That single decision is what makes the signature interaction possible: when
 * the operator clicks the corner UAV, the container animates from the card's
 * rectangle to the full viewport while the aircraft keeps flying and the
 * camera keeps tracking it. Nothing is torn down, nothing reloads, so the UAV
 * genuinely appears to fly out of the corner and through the interface.
 *
 * Camera work is done in a rig that lerps toward a mode-dependent offset in
 * the aircraft's own frame, so a mode change is a move rather than a cut.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { simClock } from '../../simulation'
import { useTwin } from '../../store/useTwin'
import { RenderBoundary } from '../ui/Boundary'
import { StageFallback } from './StageFallback'
import { hasWebGL } from '../../services/capability'
import {
  Airbase, CloudDeck, FlightPath, IsrZone, SectorFloor, SectorLighting, SkyDome,
  Terrain, TrackCurtain, WaypointMarkers,
} from './Environment'
import { terrainHeight } from './terrain'
import { FALLBACK_ROUTE, FlightDynamics, flightDynamics, routeFromSector } from './flight'
import { launchSequencer } from '../../mission/launch'
import { UavModel, type UavVisualState } from './UavModel'

/* -------------------------------------------------------- camera rig ----- */

type Mode = 'FOLLOW' | 'CINEMATIC' | 'SIDE' | 'GROUND CONTROL' | 'INSPECTION'

/** Offsets in the aircraft's local frame: [right, up, back]. */
/** Kept between the camera and the ground, in world units (~60 m). */
const GROUND_MARGIN = 0.24

const CAMERA_OFFSETS: Record<Mode, { offset: THREE.Vector3; look: THREE.Vector3; fov: number }> = {
  FOLLOW: {
    offset: new THREE.Vector3(0, 0.75, -3.4),
    look: new THREE.Vector3(0, 0.1, 2.2),
    fov: 44,
  },
  /*
   * The two storytelling framings sit slightly *below* the aircraft and look
   * slightly up.
   *
   * From above, the background behind the airframe is ground, and an aircraft
   * against ground reads as taxiing however high the altimeter says it is -
   * which is what the narrated demonstration looked like at 12,000 ft. From
   * below, the background is sky and it reads as flying. The terrain clamp
   * further down keeps the camera out of the surface near the airbase, so the
   * low framing is safe at circuit height too.
   */
  CINEMATIC: {
    offset: new THREE.Vector3(2.1, -0.28, -4.6),
    look: new THREE.Vector3(0, 0.52, 1.8),
    fov: 36,
  },
  SIDE: {
    offset: new THREE.Vector3(4.4, -0.22, 0.4),
    look: new THREE.Vector3(0, 0.4, 0),
    fov: 32,
  },
  'GROUND CONTROL': {
    offset: new THREE.Vector3(0, 0, 0),
    look: new THREE.Vector3(0, 0, 0),
    fov: 26,
  },
  INSPECTION: {
    offset: new THREE.Vector3(1.15, 0.28, -1.15),
    look: new THREE.Vector3(0, -0.02, 0.15),
    fov: 40,
  },
}

/* The corner frame is 340x224. A chase camera framed for a full screen puts
   the aircraft two pixels wide there, so the corner view sits much closer and
   slightly above, which also keeps the terrain in frame for scale. */
const CORNER_VIEW = {
  offset: new THREE.Vector3(0.95, 0.42, -2.5),
  look: new THREE.Vector3(0, 0.02, 1.2),
  fov: 36,
}

/* Docked in the Command Center hero the frame is far larger, so the aircraft
   is framed three-quarter and further out, with the sector under it. */
const HERO_VIEW = {
  offset: new THREE.Vector3(2.35, 0.95, -4.1),
  look: new THREE.Vector3(0, 0.05, 1.2),
  fov: 30,
}

interface RigProps {
  dynamics: FlightDynamics
  mode: Mode
  fullscreen: boolean
  transitionRef: React.MutableRefObject<number>
  /** The framing the camera returns to when it is not fullscreen. */
  base: typeof CORNER_VIEW
}

/** Frame-rate-independent smoothing factor.
 *
 *  A plain `lerp(a, b, dt * k)` moves a fixed fraction per frame, so the
 *  camera converges four times slower at 15 fps than at 60 and trails the
 *  aircraft on a weaker machine. This is the exponential form, which settles
 *  in the same wall-clock time whatever the frame rate.
 */
function smoothing(rate: number, delta: number) {
  return 1 - Math.exp(-rate * delta)
}

function CameraRig({ dynamics, mode, fullscreen, transitionRef, base }: RigProps) {
  const { camera } = useThree()
  const target = useMemo(() => new THREE.Vector3(), [])
  const desired = useMemo(() => new THREE.Vector3(), [])
  const lookTarget = useMemo(() => new THREE.Vector3(), [])
  const smoothedLook = useMemo(() => new THREE.Vector3(18, 3, 26), [])
  const quat = useMemo(() => new THREE.Quaternion(), [])
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), [])
  const shake = useRef(0)

  useFrame((_, delta) => {
    // Not clamped: the camera has no integration to destabilise, and clamping
    // here is what makes it trail the aircraft on a slow renderer.
    const dt = Math.min(0.25, delta)
    const s = dynamics.state
    const perspective = camera as THREE.PerspectiveCamera

    // Blend between the corner framing and the selected fullscreen mode.
    const blend = transitionRef.current
    const active = CAMERA_OFFSETS[mode] ?? CAMERA_OFFSETS.FOLLOW

    const offsetX = THREE.MathUtils.lerp(base.offset.x, active.offset.x, blend)
    const offsetY = THREE.MathUtils.lerp(base.offset.y, active.offset.y, blend)
    const offsetZ = THREE.MathUtils.lerp(base.offset.z, active.offset.z, blend)
    const fov = THREE.MathUtils.lerp(base.fov, active.fov, blend)

    // A dive-and-pull during the handover: the camera rushes in toward the
    // aircraft at the midpoint, then falls back into the cinematic framing.
    const dive = Math.sin(Math.PI * Math.min(1, Math.max(0, blend))) * (fullscreen ? 1 : 1)
    const diveScale = 1 - 0.42 * dive
    shake.current = dive * 0.06

    if (mode === 'GROUND CONTROL' && blend > 0.5) {
      // Fixed camera at the airbase, tracking the aircraft downrange.
      desired.set(18, terrainHeight(18, 22) + 2.4, 22)
      lookTarget.copy(s.position)
      perspective.fov += (18 - perspective.fov) * smoothing(2.4, dt)
    } else {
      euler.set(0, s.heading, 0)
      quat.setFromEuler(euler)
      desired
        .set(offsetX * diveScale, offsetY * diveScale, offsetZ * diveScale)
        .applyQuaternion(quat)
        .add(s.position)

      lookTarget
        .set(active.look.x, active.look.y, THREE.MathUtils.lerp(base.look.z, active.look.z, blend))
        .applyQuaternion(quat)
        .add(s.position)

      perspective.fov += (fov - perspective.fov) * smoothing(2.6, dt)
    }

    // Critically-damped chase, faster while the transition is running so the
    // camera keeps up with the aircraft rather than trailing it.
    const responsiveness = 4.2 + 5.0 * dive
    target.lerp(desired, smoothing(responsiveness, dt))
    camera.position.copy(target)

    if (shake.current > 0.001) {
      const t = performance.now() / 1000
      camera.position.x += Math.sin(t * 21) * shake.current
      camera.position.y += Math.cos(t * 17) * shake.current * 0.7
    }

    /*
     * Never below the ground.
     *
     * The framings are offsets from the aircraft, and near the airbase the
     * aircraft is close to the surface - so a lateral offset puts the camera
     * inside the terrain, which is a single-sided mesh and renders as a black
     * mass filling the frame. Clamping here fixes every framing at once rather
     * than hand-tuning each one.
     */
    const floor = terrainHeight(camera.position.x, camera.position.z) + GROUND_MARGIN
    if (camera.position.y < floor) camera.position.y = floor

    smoothedLook.lerp(lookTarget, smoothing(5.0 + 4.0 * dive, dt))
    camera.lookAt(smoothedLook)

    // Roll the camera slightly with the aircraft in cinematic framing.
    if (mode === 'CINEMATIC' || blend < 0.5) {
      // Docked in the hero the frame is a wide letterbox, and a rolling
      // horizon in it reads as a tilted panel rather than as a banking
      // aircraft. Keep the roll for the fullscreen view, damp it here.
      const roll = base === HERO_VIEW ? 0.07 : 0.24
      camera.rotateZ(-s.bank * roll * (0.4 + 0.6 * blend))
    }

    perspective.updateProjectionMatrix()
  })

  return null
}

/**
 * Parks and restarts the render loop.
 *
 * The `frameloop` prop alone is not enough: setting it back to 'always' after
 * the intro leaves the loop stopped, and the stage sits on a stale first
 * frame showing the airbase from the camera's initial position. Driving it
 * through the store and invalidating restarts the clock properly.
 */
function FrameloopControl({ parked }: { parked: boolean }) {
  const setFrameloop = useThree((s) => s.setFrameloop)
  const invalidate = useThree((s) => s.invalidate)

  useEffect(() => {
    setFrameloop(parked ? 'never' : 'always')
    if (!parked) invalidate()
  }, [parked, setFrameloop, invalidate])

  return null
}

/* ------------------------------------------------------------ aircraft --- */

function AircraftKeyLight({ dynamics }: { dynamics: FlightDynamics }) {
  const ref = useRef<THREE.PointLight>(null)

  useFrame(() => {
    const s = dynamics.state
    if (ref.current) {
      ref.current.position.set(s.position.x + 0.9, s.position.y + 1.1, s.position.z - 0.6)
    }
  })

  // A LOCAL light with a hard falloff, not a directional one: the aircraft
  // needs to read against the terrain at corner scale, and a directional light
  // would wash the whole 200 km sector to achieve it.
  return <pointLight ref={ref} intensity={18} distance={7} decay={2} color="#dfeaf8" />
}

function Aircraft({
  dynamics,
  visual,
}: {
  dynamics: FlightDynamics
  visual: React.MutableRefObject<UavVisualState>
}) {
  const group = useRef<THREE.Group>(null)

  useFrame(() => {
    const s = dynamics.state
    if (!group.current) return
    group.current.position.copy(s.position)
    group.current.rotation.set(0, s.heading, 0)
  })

  return (
    <group ref={group}>
      <UavModel state={visual} scale={0.13} />
    </group>
  )
}

/** A thin condensation trail so the aircraft reads against the terrain. */
function Contrail({ dynamics }: { dynamics: FlightDynamics }) {
  const MAX = 90
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(MAX * 3), 3))
    geo.setDrawRange(0, 0)
    return geo
  }, [])
  const points = useRef<THREE.Vector3[]>([])
  const accumulator = useRef(0)

  useFrame((_, delta) => {
    // The track is a record of where the simulation has flown, so it stops
    // extending when the simulation stops.
    if (!simClock.running) return
    accumulator.current += delta
    if (accumulator.current < 0.09) return
    accumulator.current = 0
    points.current.push(dynamics.state.position.clone())
    if (points.current.length > MAX) points.current.shift()

    const attribute = geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < points.current.length; i += 1) {
      const p = points.current[i]
      attribute.setXYZ(i, p.x, p.y, p.z)
    }
    attribute.needsUpdate = true
    geometry.setDrawRange(0, points.current.length)
  })

  const line = useMemo(
    () =>
      new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: '#9fb8cc', transparent: true, opacity: 0.28 }),
      ),
    [geometry],
  )

  return <primitive object={line} />
}

/* --------------------------------------------------------------- scene --- */

function Scene({
  dynamics,
  visual,
  fullscreen,
  mode,
  transitionRef,
  base,
}: {
  dynamics: FlightDynamics
  visual: React.MutableRefObject<UavVisualState>
  fullscreen: boolean
  mode: Mode
  transitionRef: React.MutableRefObject<number>
  base: typeof CORNER_VIEW
}) {
  const sector = useTwin((s) => s.sector)
  const telemetry = useTwin((s) => s.telemetry)
  const mission = useTwin((s) => s.mission)
  const alerts = useTwin((s) => s.alerts)

  const route = useMemo(() => {
    if (!sector?.waypoints?.length) return FALLBACK_ROUTE
    return routeFromSector(sector.waypoints, sector.orbit ?? [])
  }, [sector])

  useEffect(() => {
    dynamics.setRoute(route)
  }, [route, dynamics])

  const commanded = useRef({ alt: 900, speed: 74 })
  const reconcileTimer = useRef(0)
  /** So "approaching base" is logged once per recall, not once per frame. */
  const approaching = useRef(false)
  /** Previous range to base, for spotting the turn at closest approach. */
  const lastRange = useRef(Infinity)

  useFrame((_, delta) => {
    // Clamped so a stalled tab cannot integrate a huge step, but generous
    // enough that a software renderer still tracks the commanded state.
    //
    // Held to zero whenever the simulation is held: the aircraft's position is
    // a simulated quantity like any other, and an aeroplane still flying its
    // route over frozen telemetry is the same lie as a turning propeller.
    if (!simClock.running) return

    /*
     * Integrated at the simulation's rate, and for the whole frame.
     *
     * Two faults here, and they hid each other. The model ran in real time
     * while the ground station advanced at 20x, so the aircraft crawled and
     * only appeared to keep up because the reconciler kept dragging it
     * forward in twenty-six kilometre corrections - movement that reads as a
     * marker stuttering between positions rather than an aeroplane flying.
     * And clamping the frame to 0.1 s discarded real time whenever the
     * renderer dropped below 10 fps, so on a software rasteriser it crawled
     * again on top of that.
     *
     * Scaling by the clock's own rate puts the model on the same time base as
     * the telemetry beside it. Sub-stepping keeps each step small enough to
     * stay stable while still integrating the time that actually passed; the
     * outer cap is what stops a backgrounded tab resuming in one huge jump.
     */
    /* The launch is paced by the wall clock, not the simulation's.
       Everything else is scaled so the aircraft keeps time with a ground
       station running at 20x - but a climb-out scaled the same way is over in
       under a second, and the phase the operator is meant to watch never
       appears. The sequence is cinematic, so it runs at the rate a person
       reads it at, identically at 1x and 200x. Pause still freezes it: this
       whole callback returns early when the clock is stopped. */
    const scale = flightDynamics.groundHold ? 1 : Math.max(0.05, simClock.speed || 1)
    const want = Math.min(0.5, delta) * scale
    /*
     * The sub-step is capped, not the step count.
     *
     * Dividing the frame by a fixed maximum number of steps let `dt` grow with
     * the simulation rate - 0.125 s at 20x on a slow frame, 6.25 s at 200x.
     * The altitude term is a discrete exponential approach, `error * 0.65 * dt`,
     * which only converges while dt stays under about 1.5 s; past that every
     * step overshoots by more than it corrects and the oscillation diverges.
     * That is what put thirty-seven thousand feet on the corner card against a
     * commanded fourteen.
     *
     * So the step size is fixed and the count is what varies. When the cap
     * binds, the model integrates less than the full frame and lags the ground
     * station slightly - which the reconciler already exists to absorb, and
     * which is far better than an unstable integrator.
     */
    const MAX_STEP = 0.05
    /* The count is generous because the step is what has to stay small, and a
       step is a dozen float operations - eighty of them per frame is nothing
       next to the render. Capping the count instead was throttling the model
       to about eight times real time however high the rate selector went, so
       60x and 200x closed on a waypoint at exactly the same speed as 20x. */
    const steps = Math.max(1, Math.min(80, Math.ceil(want / MAX_STEP)))
    const dt = Math.min(MAX_STEP, want / steps)
    const frame = dt * steps
    if (dt <= 0) return

    // Command altitude and speed from the twin's live telemetry, falling back
    // to the leg's planned figures when no frame has arrived yet.
    const leg = dynamics.activeLeg
    const liveAlt = mission?.altitude_ft ?? telemetry?.tick.inputs?.altitude_ft
    const liveIas = mission?.ias_kt ?? telemetry?.tick.inputs?.ias_kt
    /*
     * A recalled aircraft flies its own profile.
     *
     * Altitude and speed are normally slaved to the ground station, which is
     * the right default - the telemetry is the authority on what the engine is
     * doing. But the ground station is still flying its own sortie: it does
     * not know the aircraft has been recalled, so it keeps commanding the ISR
     * cruise altitude. Left slaved, a recall changed the ground track and
     * nothing else, and the console showed an aeroplane heading home at
     * fourteen thousand feet in an ISR loiter.
     *
     * While diverted the diversion leg owns both, so the aircraft descends
     * toward the field the way it is actually being flown.
     */
    if (dynamics.diverted) {
      /* The descent profile itself lives on the flight model, where it can be
         tested: a recall has to start coming down on the command rather than
         when a fixed glidepath catches up with an aircraft a sector away. */
      const wp = (mission?.mission?.position ? sector?.waypoints : null) as
        | Array<{ id: string; x: number; y: number }> | null | undefined
      const home = wp?.find((w) => w.id === 'BASE') ?? { x: 18, y: 22 }
      const rangeKm = dynamics.distanceTo(home.x, home.y)
      commanded.current.alt = dynamics.divertProfileFt(rangeKm, leg?.altitudeFt ?? 900)
      commanded.current.speed = leg?.speedKt ?? 96
    } else {
      commanded.current.alt = liveAlt && liveAlt > 50 ? liveAlt : leg?.altitudeFt ?? 900
      commanded.current.speed = liveIas && liveIas > 5 ? liveIas : leg?.speedKt ?? 80
    }

    /* While the launch owns the aircraft it commands the altitude: zero
       through the checks, the climb target once rolling. The route's own
       figures take back over the moment it is released. */
    const launchAlt = launchSequencer.commandedAltitudeFt()
    if (launchAlt !== null && dynamics.groundHold) {
      commanded.current.alt = launchAlt
      commanded.current.speed = launchAlt > 0 ? 78 : 0
    }

    let state = dynamics.state
    for (let i = 0; i < steps; i += 1) {
      state = dynamics.step(dt, commanded.current.alt, commanded.current.speed)
    }

    // Drift back toward the backend's authoritative sector position slowly, so
    // the 3D track and the tactical picture do not diverge over a long sortie.
    reconcileTimer.current += frame
    if (!dynamics.diverted && reconcileTimer.current > 1 && mission?.mission?.position) {
      reconcileTimer.current = 0
      const p = mission.mission.position
      const far = Math.hypot(p.x - state.position.x, p.y - state.position.z) > 26
      if (far) dynamics.reconcile(p.x, p.y, commanded.current.alt, 0.16)
    }

    /* Arrival.
       A recall ends when the aircraft is actually over the field, not when a
       timer says it should be - so it is tested against the flight model's own
       position, on the same frame that moved it. Read through getState so a
       check that runs every frame does not re-render the tree. */
    const twin = useTwin.getState()
    if (twin.missionPhase === 'RETURNING_TO_BASE') {
      const wps = (twin.sector?.waypoints ?? []) as Array<{ id: string; x: number; y: number }>
      const base = wps.find((w) => w.id === 'BASE') ?? { x: 18, y: 22 }
      const range = dynamics.distanceTo(base.x, base.y)
      if (range < 12 && !approaching.current) {
        approaching.current = true
        twin.logEvent('INFO', 'UAV approaching base')
      }
      /*
       * Arrival is closest approach, not a radius.
       *
       * Two faults with a radius test. It declared the sortie closed on
       * horizontal range alone, so the panel read "on the ground at base"
       * under a corner card showing six thousand feet - reaching the overhead
       * is not landing. And at 200x the aircraft covers about three kilometres
       * between frames, so it tunnelled straight through a 2.2 km gate and
       * flew out the far side still returning.
       *
       * Watching the range turn instead cannot be skipped at any speed: the
       * frame the aircraft starts receding is the frame it passed the field.
       * It still has to be low, and if it is not, nothing fires - the model
       * keeps steering at BASE, comes round again, and by then the descent
       * profile has brought it down.
       */
      const receding = range > lastRange.current + 0.01
      lastRange.current = range
      if ((range < 2.2 || (receding && range < 14)) && dynamics.state.altitudeFt <= 1500) {
        approaching.current = false
        // Down. The readings should say so rather than freezing mid-approach.
        dynamics.state.altitudeFt = 0
        dynamics.state.speedKt = 0
        dynamics.state.pitch = 0
        dynamics.frozen = true
        lastRange.current = Infinity
        useTwin.setState({ missionPhase: 'COMPLETED' })
        twin.logEvent('INFO', 'UAV reached base')
        twin.logEvent('INFO', 'Mission safely completed')
      }
    }

    visual.current.rpm = telemetry?.tick.channels?.rpm ?? mission?.rpm ?? 2200
    visual.current.frozen = !simClock.running
    visual.current.bank = state.bank
    visual.current.pitch = state.pitch
    visual.current.airborne = Math.min(1, Math.max(0, (state.altitudeFt - 200) / 800))
    const top = alerts?.anomalies?.[0]
    visual.current.alert = top && !top.abstained ? Math.min(1, top.score) : 0
  })

  const waypoints = sector?.waypoints ?? []
  const isr = waypoints.find((w) => w.kind === 'ISR')
  const detail = fullscreen || transitionRef.current > 0.02

  return (
    <>
      <SkyDome />
      {/* Aerial perspective: distance turns to haze, not to black. */}
      <fog attach="fog" args={['#cfe0f2', 90, 520]} />
      <SectorLighting shadows={fullscreen} />
      {/* Rim light that travels with the aircraft. Without it the airframe
          reads as a silhouette at corner scale, where it is only a few dozen
          pixels across. */}
      <AircraftKeyLight dynamics={dynamics} />
      <Terrain />
      <SectorFloor />
      <Airbase />

      {detail && (
        <>
          <WaypointMarkers waypoints={waypoints} activeId={dynamics.activeLeg?.id} />
          {isr && <IsrZone x={isr.x} y={isr.y} radius={sector?.orbit_radius_km ?? 18} />}
          {sector?.route && <FlightPath points={sector.route} />}
          {sector?.route && <TrackCurtain points={sector.route} />}
        </>
      )}

      <CloudDeck count={fullscreen ? 34 : 14} altitudeFt={9000} spread={190} opacity={0.5} />
      {fullscreen && <CloudDeck count={20} altitudeFt={18500} spread={240} opacity={0.3} />}

      <Aircraft dynamics={dynamics} visual={visual} />
      <Contrail dynamics={dynamics} />

      <CameraRig
        dynamics={dynamics}
        mode={mode}
        fullscreen={fullscreen}
        transitionRef={transitionRef}
        base={base}
      />
    </>
  )
}

/* --------------------------------------------------------------- stage --- */

/** Height of the fixed top bar, matched to --topbar. */
const TOPBAR_PX = 56

const easeInOutExpo = (t: number) =>
  t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2

export function UavStage({ cardRef }: { cardRef: React.RefObject<HTMLElement> }) {
  const flightMode = useTwin((s) => s.flightMode)
  const cameraMode = useTwin((s) => s.cameraMode) as Mode
  const enterMission = useTwin((s) => s.enterMission)
  const dock = useTwin((s) => s.dock)

  const stageRef = useRef<HTMLDivElement>(null)
  const transitionRef = useRef(0)
  const [ready, setReady] = useState(false)

  const dynamics = flightDynamics
  const visual = useRef<UavVisualState>({ rpm: 2200, bank: 0, pitch: 0, airborne: 0, alert: 0 })

  const fullscreen = flightMode === 'MISSION' || flightMode === 'TRANSITION_OUT'
  /* The startup card owns the screen for a second or two and runs no 3D of
     its own; parking here saves a render loop on the machine that needs it
     most. The film is a separate route, so this stage is not mounted at all
     while it plays. */
  const parked = false
  /* No renderer, no 3D. The console still has to work, so the stage falls
     back to a 2D attitude view driven by the same flight model. */
  const [webgl] = useState(hasWebGL)
  const baseView = dock === 'HERO' && !fullscreen ? HERO_VIEW : CORNER_VIEW

  /* Coming out of the intro the flight model has not been integrating, so it
     is still on the runway. Put it where the mission says it is. */
  const wasParked = useRef(parked)
  useEffect(() => {
    if (wasParked.current && !parked) {
      const state = useTwin.getState()
      const alt = state.mission?.altitude_ft ?? state.telemetry?.tick?.inputs?.altitude_ft ?? 0
      const ias = state.mission?.ias_kt ?? state.telemetry?.tick?.inputs?.ias_kt ?? 0
      if (alt > 1200) dynamics.warmStart(alt, ias || 90)
    }
    wasParked.current = parked
  }, [parked, dynamics])

  /* The container rect is driven imperatively rather than through React state
     so it updates every frame without re-rendering the WebGL tree. */
  useEffect(() => {
    let raf = 0
    let start = performance.now()
    const durationOut = 1500
    const durationIn = 1300

    const cornerRect = () => {
      const el = cardRef.current
      if (!el) return { left: window.innerWidth - 362, top: window.innerHeight - 246, width: 340, height: 224 }
      const r = el.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    }

    const fullRect = () => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight })

    const apply = (progress: number) => {
      const stage = stageRef.current
      if (!stage) return
      const a = cornerRect()
      const b = fullRect()
      const t = easeInOutExpo(progress)
      stage.style.left = `${a.left + (b.left - a.left) * t}px`
      stage.style.top = `${a.top + (b.top - a.top) * t}px`
      stage.style.width = `${a.width + (b.width - a.width) * t}px`
      stage.style.height = `${a.height + (b.height - a.height) * t}px`
      stage.style.borderRadius = `${8 * (1 - t)}px`
      stage.style.boxShadow = t > 0.02 ? 'none' : 'var(--shadow-3)'

      // Docked in the hero the frame scrolls with the page, and this canvas
      // is fixed. Clip it to what is actually inside the content area rather
      // than letting it slide over the top bar.
      const left = a.left + (b.left - a.left) * t
      const top = a.top + (b.top - a.top) * t
      const height = a.height + (b.height - a.height) * t
      const topCut = Math.max(0, TOPBAR_PX - top)
      const bottomCut = Math.max(0, top + height - window.innerHeight)
      stage.style.clipPath =
        topCut > 0.5 || bottomCut > 0.5 ? `inset(${topCut}px 0 ${bottomCut}px 0)` : 'none'
      void left
      transitionRef.current = t
    }

    const settled =
      flightMode === 'MISSION' ? 1 : flightMode === 'DASHBOARD' ? 0 : null

    if (settled !== null) {
      apply(settled)
      const onResize = () => apply(settled)
      window.addEventListener('resize', onResize)
      // Track layout changes (scrolling moves the corner card's rect).
      const tick = () => {
        apply(settled)
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
      return () => {
        window.removeEventListener('resize', onResize)
        cancelAnimationFrame(raf)
      }
    }

    const outward = flightMode === 'TRANSITION_OUT'
    const duration = outward ? durationOut : durationIn
    start = performance.now()

    const animate = () => {
      const elapsed = performance.now() - start
      const u = Math.min(1, elapsed / duration)
      apply(outward ? u : 1 - u)
      if (u < 1) raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(raf)
  }, [flightMode, cardRef])

  return (
    <div
      ref={stageRef}
      className={`uav-stage ${fullscreen ? 'uav-stage--full' : ''} ${flightMode === 'DASHBOARD' && !parked ? 'uav-stage--interactive' : ''} ${parked ? 'uav-stage--parked' : ''}`}
      style={{ left: 0, top: 0, width: 340, height: 224 }}
      onClick={flightMode === 'DASHBOARD' && !parked ? enterMission : undefined}
      aria-hidden
    >
      {webgl ? (
      <RenderBoundary label="3D stage" fallback={<StageFallback fullscreen={fullscreen} />}>
      <Canvas
        shadows
        dpr={[1, 1.75]}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          alpha: false,
        }}
        camera={{ position: [16, 5, 14], fov: 38, near: 0.15, far: 900 }}
        onCreated={({ gl, scene }) => {
          gl.setClearColor('#cfe0f2')
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 1.0
          scene.background = new THREE.Color('#cfe0f2')
          setReady(true)
        }}
        frameloop="always"
      >
        <FrameloopControl parked={parked} />
        <Suspense fallback={null}>
          <Scene
            dynamics={dynamics}
            visual={visual}
            fullscreen={fullscreen}
            mode={cameraMode}
            transitionRef={transitionRef}
            base={baseView}
          />
        </Suspense>
      </Canvas>
      </RenderBoundary>
      ) : (
        <StageFallback fullscreen={fullscreen} />
      )}
      {webgl && !ready && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: '#eef4fb',
            color: 'var(--ink-4)',
            fontSize: 11.5,
            letterSpacing: '0.2em',
          }}
        >
          INITIALISING RENDERER
        </div>
      )}
    </div>
  )
}

export { FlightDynamics }
export type { Mode as CameraModeName }
