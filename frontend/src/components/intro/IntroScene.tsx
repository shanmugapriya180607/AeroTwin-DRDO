/**
 * The first-entry film.
 *
 * One continuous world: the same sector terrain, sky and cloud decks the
 * mission stage flies over, the same procedural airframe, and the same engine
 * assembly the Digital Twin page drives. The camera never cuts - it cranes
 * over the range, finds the aircraft, closes on it, watches it acquire a
 * digital counterpart, then travels into the propulsion bay and stays there
 * while the residual, the anomaly and the advisory are drawn on the machine
 * itself.
 *
 * The whole sequence is driven by one clock ref. Nothing here re-renders React
 * per frame.
 */

import { useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { Airbase, CloudDeck, SectorFloor, SkyDome, SUN_DIR, SUN_POS, Terrain } from '../uav/Environment'
import { UavModel, type UavVisualState } from '../uav/UavModel'
import { EngineModel, emptyEngineState, type EngineVisualState } from '../engine3d/EngineModel'
import { performanceTier } from '../../services/capability'
import { ACT, SENSORS, smoothstep, pulse } from './introTimeline'

export interface IntroClock {
  t: number
  act: number
  progress: number
  /** Seconds since the current act began. */
  local: number
}

/**
 * How far through the closing act we are, in wall-clock rather than fractional
 * terms.
 *
 * The final act runs until the operator enters, so its nominal duration is an
 * hour and `progress` sits at zero for the whole of it. Anything that has to
 * animate on the way out - the aircraft returning, the studio opening back up
 * to the range, the assembly shrinking away - has to read the seconds instead.
 */
const outro = (c: IntroClock, seconds = 7) => Math.min(1, Math.max(0, c.local / seconds))

/* Downrange of the airbase with the ridge line behind, so the aircraft has
   something to be scaled against and the engine has a horizon behind it. */
const STAGE = new THREE.Vector3(150, 24, 95)

/** How far downrange the aircraft starts. Big enough that it is a speck. */
const APPROACH_SPAN = 205

const DIGITAL = '#0aa7c2'
const RESIDUAL = '#7739e0'
const FAULT = '#e13232'

/* -------------------------------------------------------------- flight --- */

/**
 * Where the aircraft is, as one monotonic approach parameter.
 *
 * u = 0 is the far downrange contact, u = 1 is the inspection station, and
 * u > 1 is the departure on the closing act. Deriving position from the act
 * rather than from raw seconds is what lets a chapter jump land the aircraft
 * in the right place instantly.
 */
function approachU(act: number, p: number, outroP = 0): number {
  if (act <= ACT.HORIZON) return 0.02 + p * 0.05
  if (act === ACT.CONTACT) return 0.07 + p * 0.40
  if (act === ACT.AIRFRAME) return 0.47 + p * 0.28
  if (act === ACT.SCAN) return 0.75 + p * 0.17
  if (act === ACT.SYNC) return 0.92 + p * 0.08
  if (act < ACT.BRAND) return 1
  // The departure is bounded: on the closing frame the aircraft has to stay in
  // the sector and in the shot, not disappear over the ridge.
  return 1 + outroP * 0.32
}

function aircraftAt(target: THREE.Vector3, c: IntroClock) {
  const { act, progress: p, t } = c
  const u = approachU(act, p, outro(c, 26))
  return target.set(
    STAGE.x + (u - 1) * APPROACH_SPAN,
    STAGE.y + Math.sin(t * 0.34) * 0.3 + (1 - Math.min(1, u)) * 5.5,
    STAGE.z + (1 - Math.min(1, u)) * 22,
  )
}

/* ----------------------------------------------------------------- sun --- */

/** The sun disc and its glare. One additive billboard, no post stack. */
function Sun() {
  const texture = useMemo(() => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,253,246,0.98)')
    g.addColorStop(0.1, 'rgba(255,246,224,0.72)')
    g.addColorStop(0.34, 'rgba(255,232,196,0.18)')
    g.addColorStop(1, 'rgba(255,226,190,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    return new THREE.CanvasTexture(canvas)
  }, [])

  return (
    <sprite position={SUN_POS} scale={[210, 210, 1]}>
      <spriteMaterial
        map={texture}
        transparent
        opacity={0.9}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </sprite>
  )
}

/* --------------------------------------------------- airframe wireframe -- */

/**
 * The digital counterpart of the airframe: the same planform drawn as edges.
 *
 * Built once into a single buffer so the twin costs one draw call however
 * close the camera gets to it.
 */
function useAirframeEdges() {
  return useMemo(() => {
    const parts: THREE.BufferGeometry[] = []
    const push = (
      geo: THREE.BufferGeometry,
      pos: [number, number, number],
      rot: [number, number, number] = [0, 0, 0],
    ) => {
      const edges = new THREE.EdgesGeometry(geo, 20)
      edges.applyMatrix4(
        new THREE.Matrix4()
          .makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]))
          .setPosition(pos[0], pos[1], pos[2]),
      )
      parts.push(edges)
      geo.dispose()
    }

    // fuselage, nose, tail cone, boom
    push(new THREE.CylinderGeometry(0.2, 0.2, 1.5, 12), [0, 0, 0], [Math.PI / 2, 0, 0])
    push(new THREE.SphereGeometry(0.24, 12, 8), [0, 0.04, 0.86])
    push(new THREE.CylinderGeometry(0.11, 0.19, 0.55, 10), [0, 0, -1.05], [Math.PI / 2, 0, 0])
    push(new THREE.CylinderGeometry(0.055, 0.075, 1.5, 8), [0, 0, -0.95], [Math.PI / 2, 0, 0])
    // wing: a thin slab, which reads as planform once drawn as edges
    push(new THREE.BoxGeometry(4.6, 0.07, 0.9), [0, 0.1, 0.05])
    // v-tail
    push(new THREE.BoxGeometry(1.5, 0.06, 0.5), [0.6, 0.28, -1.62], [0, 0, 0.62])
    push(new THREE.BoxGeometry(1.5, 0.06, 0.5), [-0.6, 0.28, -1.62], [0, 0, -0.62])
    // engine bay and propeller disc
    push(new THREE.CylinderGeometry(0.185, 0.185, 0.42, 12), [0, 0, -0.66], [Math.PI / 2, 0, 0])
    push(new THREE.CircleGeometry(0.62, 18), [0, 0, -1.37])

    const positions: number[] = []
    for (const geo of parts) {
      const attr = geo.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < attr.count; i += 1) {
        positions.push(attr.getX(i), attr.getY(i), attr.getZ(i))
      }
      geo.dispose()
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return geometry
  }, [])
}

/**
 * The digitalisation itself: a point cloud that condenses onto the airframe,
 * then the wireframe that resolves out of it.
 *
 * This is deliberately an acquisition, not a glitch. Points start scattered in
 * the volume the aircraft occupies and snap to their sampled surface position
 * as the scan plane passes over them, nose to tail.
 */
function DigitalAirframe({
  clock,
  edges,
}: {
  clock: React.MutableRefObject<IntroClock>
  edges: THREE.BufferGeometry
}) {
  const COUNT = 1600

  const { cloudGeometry, cloudMaterial, home, scatter, lineMaterial } = useMemo(() => {
    const source = edges.attributes.position as THREE.BufferAttribute
    const home = new Float32Array(COUNT * 3)
    const scatter = new Float32Array(COUNT * 3)
    const positions = new Float32Array(COUNT * 3)

    for (let i = 0; i < COUNT; i += 1) {
      // Sample along a random edge segment, so the cloud lies on the structure
      // rather than in a box around it.
      const seg = Math.floor(Math.random() * (source.count / 2)) * 2
      const a = Math.min(seg, source.count - 2)
      const f = Math.random()
      home[i * 3] = THREE.MathUtils.lerp(source.getX(a), source.getX(a + 1), f)
      home[i * 3 + 1] = THREE.MathUtils.lerp(source.getY(a), source.getY(a + 1), f)
      home[i * 3 + 2] = THREE.MathUtils.lerp(source.getZ(a), source.getZ(a + 1), f)
      scatter[i * 3] = home[i * 3] + (Math.random() - 0.5) * 3.4
      scatter[i * 3 + 1] = home[i * 3 + 1] + (Math.random() - 0.5) * 1.6
      scatter[i * 3 + 2] = home[i * 3 + 2] + (Math.random() - 0.5) * 3.0
      positions[i * 3] = scatter[i * 3]
      positions[i * 3 + 1] = scatter[i * 3 + 1]
      positions[i * 3 + 2] = scatter[i * 3 + 2]
    }

    const cloudGeometry = new THREE.BufferGeometry()
    cloudGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const cloudMaterial = new THREE.PointsMaterial({
      color: DIGITAL, size: 0.028, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true,
    })
    const lineMaterial = new THREE.LineBasicMaterial({
      color: DIGITAL, transparent: true, opacity: 0, depthWrite: false,
    })
    return { cloudGeometry, cloudMaterial, home, scatter, lineMaterial }
  }, [edges])

  const scanRef = useRef<THREE.Mesh>(null)
  const scanEdgeRef = useRef<THREE.LineSegments>(null)
  const scanEdgeMaterial = useMemo(
    () => new THREE.LineBasicMaterial({ color: '#0aa7c2', transparent: true, opacity: 0, depthWrite: false }),
    [],
  )
  const scanMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: '#5fd8f2', transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthWrite: false,
    }),
    [],
  )

  useFrame(() => {
    const c = clock.current
    const scanning = c.act === ACT.SCAN
    // The acquisition runs across SCAN and holds through SYNC; on the way into
    // the engine the airframe twin hands over to the engine's own model.
    const form = scanning
      ? smoothstep(0.06, 0.62, c.progress)
      : c.act > ACT.SCAN && c.act <= ACT.SYNC
        ? 1
        : c.act === ACT.ENGINE
          ? 1 - smoothstep(0, 0.35, c.progress)
          : c.act >= ACT.BRAND
            ? (1 - smoothstep(0.15, 0.5, outro(c, 5))) * 0.5
            : 0

    // Points lead, edges follow: the cloud condenses first, the structure
    // resolves out of it, then the cloud thins to a residue.
    cloudMaterial.opacity += (form * (1 - form * 0.55) * 1.6 - cloudMaterial.opacity) * 0.08
    lineMaterial.opacity += (Math.pow(form, 1.8) * 0.95 - lineMaterial.opacity) * 0.07

    if (cloudMaterial.opacity > 0.008) {
      const attribute = cloudGeometry.attributes.position as THREE.BufferAttribute
      const array = attribute.array as Float32Array
      // The scan plane runs nose to tail; a point snaps home once passed.
      const plane = scanning ? -1.9 + c.progress * 5.1 : 9
      for (let i = 0; i < COUNT; i += 1) {
        const z = home[i * 3 + 2]
        const k = Math.max(0, Math.min(1, (plane - z) * 1.4)) * form
        const e = k * k * (3 - 2 * k)
        array[i * 3] = THREE.MathUtils.lerp(scatter[i * 3], home[i * 3], e)
        array[i * 3 + 1] = THREE.MathUtils.lerp(scatter[i * 3 + 1], home[i * 3 + 1], e)
        array[i * 3 + 2] = THREE.MathUtils.lerp(scatter[i * 3 + 2], home[i * 3 + 2], e)
      }
      attribute.needsUpdate = true
    }

    // The scan plane itself, visible only while it is travelling.
    const sweep = scanning ? pulse(c.progress, 0.02, 0.1, 0.62, 0.78) : 0
    scanMaterial.opacity += (sweep * 0.2 - scanMaterial.opacity) * 0.12
    scanEdgeMaterial.opacity += (sweep * 0.95 - scanEdgeMaterial.opacity) * 0.12
    const plate = -1.9 + c.progress * 5.1
    if (scanRef.current) {
      scanRef.current.position.z = plate
      scanRef.current.visible = scanMaterial.opacity > 0.01
    }
    if (scanEdgeRef.current) {
      scanEdgeRef.current.position.z = plate
      scanEdgeRef.current.visible = scanEdgeMaterial.opacity > 0.01
    }
  })

  return (
    <group>
      <points geometry={cloudGeometry} material={cloudMaterial} frustumCulled={false} />
      <lineSegments geometry={edges} material={lineMaterial} frustumCulled={false} />
      <mesh ref={scanRef} material={scanMaterial}>
        <planeGeometry args={[5.4, 1.5]} />
      </mesh>
      <lineSegments ref={scanEdgeRef} material={scanEdgeMaterial}>
        <edgesGeometry args={[new THREE.PlaneGeometry(5.4, 1.5)]} />
      </lineSegments>
    </group>
  )
}

/* --------------------------------------------------------- sensor nodes -- */

/** Where the aircraft is instrumented. Emissive markers, not point lights. */
const NODES: Array<[number, number, number]> = [
  [0, -0.2, 0.8], [0.9, 0.13, 0.06], [-0.9, 0.13, 0.06],
  [0, 0.12, -0.66], [0.2, -0.04, -0.6], [-0.2, -0.04, -0.6], [0, 0.1, -1.6],
]

function SensorNodes({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: '#26c6f0', transparent: true, opacity: 0, depthWrite: false,
    }),
    [],
  )
  const ref = useRef<THREE.Group>(null)

  useFrame((state) => {
    const c = clock.current
    const on =
      c.act === ACT.AIRFRAME ? smoothstep(0.55, 0.9, c.progress)
        : c.act === ACT.SCAN ? 1
          : c.act === ACT.SYNC ? 1 - smoothstep(0.5, 1, c.progress)
            : 0
    const blink = 0.6 + 0.4 * Math.sin(state.clock.elapsedTime * 3.4)
    material.opacity += (on * blink - material.opacity) * 0.12
    if (ref.current) ref.current.visible = material.opacity > 0.02
  })

  return (
    <group ref={ref}>
      {NODES.map((p, i) => (
        <mesh key={i} position={p} material={material}>
          <sphereGeometry args={[0.035, 8, 6]} />
        </mesh>
      ))}
    </group>
  )
}

/* ---------------------------------------------------------- data stream -- */

/**
 * Frames leaving the machine for the model, and the estimator's correction
 * returning. Both directions are drawn because both directions exist.
 */
function DataStream({
  from,
  to,
  colour,
  reverse = false,
  count = 130,
  active,
}: {
  from: THREE.Vector3
  to: THREE.Vector3
  colour: string
  reverse?: boolean
  count?: number
  active: React.MutableRefObject<number>
}) {
  const { geometry, material, curve, seeds } = useMemo(() => {
    const mid = from.clone().lerp(to, 0.5)
    mid.y += reverse ? -0.8 : 0.9
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone())
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    for (let i = 0; i < count; i += 1) seeds[i] = Math.random()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color: colour, size: 0.05, transparent: true, opacity: 0, depthWrite: false,
      sizeAttenuation: true,
    })
    return { geometry, material, curve, seeds }
  }, [from, to, colour, reverse, count])

  const point = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, delta) => {
    material.opacity += (active.current * 0.95 - material.opacity) * 0.06
    if (material.opacity < 0.012) return
    const attribute = geometry.attributes.position as THREE.BufferAttribute
    const step = Math.min(0.06, delta) * 0.36
    for (let i = 0; i < seeds.length; i += 1) {
      let p = seeds[i] + step * (0.6 + (i % 5) / 6)
      if (p > 1) p -= 1
      seeds[i] = p
      curve.getPoint(reverse ? 1 - p : p, point)
      attribute.setXYZ(
        i,
        point.x,
        point.y + Math.sin(p * 12 + i) * 0.02,
        point.z + Math.cos(p * 9 + i) * 0.03,
      )
    }
    attribute.needsUpdate = true
  })

  return <points geometry={geometry} material={material} frustumCulled={false} />
}

/* --------------------------------------------------------- the airframe -- */

function IntroAircraft({
  clock,
  engineAnchor,
}: {
  clock: React.MutableRefObject<IntroClock>
  engineAnchor: THREE.Vector3
}) {
  const group = useRef<THREE.Group>(null)
  const physical = useRef<THREE.Group>(null)
  const digital = useRef<THREE.Group>(null)
  const position = useMemo(() => new THREE.Vector3(), [])
  const visual = useRef<UavVisualState>({
    rpm: 2450, bank: 0, pitch: 0.02, airborne: 1, alert: 0, opacity: 1,
  })
  const edges = useAirframeEdges()
  const streamActive = useRef(0)

  // The group is yawed a quarter turn so the nose points along the track,
  // which maps local +Z onto world +X. The split therefore has to be built on
  // local Z, or the two halves separate toward and away from the camera
  // instead of left and right.
  const streamFrom = useMemo(() => new THREE.Vector3(0, 0.1, -2.9), [])
  const streamTo = useMemo(() => new THREE.Vector3(0, 0.1, 2.9), [])

  useFrame(() => {
    const c = clock.current
    if (!group.current) return
    aircraftAt(position, c)
    group.current.position.copy(position)
    group.current.rotation.y = Math.PI / 2

    // The engine assembly is anchored where the propulsion bay actually is,
    // so the dive into it is a real move rather than a cut to another scene.
    engineAnchor.copy(position)

    // Flight: a lazy S through the approach, wings level once on station.
    const banking = c.act === ACT.CONTACT || c.act === ACT.AIRFRAME
    visual.current.bank = banking ? Math.sin(c.t * 0.46) * 0.14 : 0
    visual.current.pitch = c.act >= ACT.BRAND ? 0.05 : 0.02
    visual.current.rpm = c.act >= ACT.ENGINE && c.act < ACT.BRAND ? 2380 : 2450

    // The dissolve into the propulsion bay, and the return on the closing act.
    const dissolve =
      c.act === ACT.ENGINE ? 1 - smoothstep(0.28, 0.62, c.progress)
        : c.act > ACT.ENGINE && c.act < ACT.BRAND ? 0
          : c.act >= ACT.BRAND ? smoothstep(0.05, 0.4, outro(c, 4))
            : 1
    visual.current.opacity = dissolve
    visual.current.alert = c.act === ACT.ANOMALY ? smoothstep(0.4, 0.9, c.progress) : 0

    // Physical and digital separate for the comparison, and rejoin after it.
    const split =
      c.act === ACT.SYNC ? smoothstep(0.04, 0.42, c.progress)
        : c.act === ACT.ENGINE ? 1 - smoothstep(0, 0.3, c.progress)
          : 0
    streamActive.current = split
    if (physical.current) physical.current.position.z = -2.9 * split
    if (digital.current) digital.current.position.z = 2.9 * split
  })

  return (
    <group ref={group}>
      <group ref={physical}>
        <group scale={0.34}>
          <SensorNodes clock={clock} />
        </group>
        <UavModel state={visual} scale={0.34} showGear={false} />
      </group>

      <group ref={digital} scale={0.34}>
        <DigitalAirframe clock={clock} edges={edges} />
      </group>

      <DataStream from={streamFrom} to={streamTo} colour={DIGITAL} count={120} active={streamActive} />
      <DataStream from={streamFrom} to={streamTo} colour={RESIDUAL} count={60} reverse active={streamActive} />
    </group>
  )
}

/* ------------------------------------------------------- the holo engine -- */

/** The digital half of the engine: the same assembly drawn as edges. */
function HoloEngine({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const group = useRef<THREE.Group>(null)

  const { geometry, material } = useMemo(() => {
    const merged: THREE.BufferGeometry[] = []
    const push = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rz = 0) => {
      const edges = new THREE.EdgesGeometry(geo, 24)
      edges.applyMatrix4(new THREE.Matrix4().makeRotationZ(rz).setPosition(x, y, z))
      merged.push(edges)
      geo.dispose()
    }

    push(new THREE.BoxGeometry(0.56, 0.46, 1.62), 0, 0, 0)
    push(new THREE.BoxGeometry(0.44, 0.4, 0.3), 0, -0.04, -0.95)
    push(new THREE.CylinderGeometry(0.2, 0.26, 0.32, 14), 0, 0, 0.94, 0)
    for (const slot of [
      { side: 1, z: 0.62 }, { side: -1, z: 0.62 },
      { side: 1, z: -0.62 }, { side: -1, z: -0.62 },
    ]) {
      push(new THREE.CylinderGeometry(0.19, 0.2, 0.56, 14), slot.side * 0.58, 0, slot.z, Math.PI / 2)
      push(new THREE.CylinderGeometry(0.225, 0.245, 0.19, 14), slot.side * 0.9, 0, slot.z, Math.PI / 2)
      push(new THREE.CylinderGeometry(0.265, 0.265, 0.016, 14), slot.side * 0.45, 0, slot.z, Math.PI / 2)
      push(new THREE.CylinderGeometry(0.265, 0.265, 0.016, 14), slot.side * 0.7, 0, slot.z, Math.PI / 2)
    }

    const positions: number[] = []
    for (const geo of merged) {
      const attr = geo.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < attr.count; i += 1) {
        positions.push(attr.getX(i), attr.getY(i), attr.getZ(i))
      }
      geo.dispose()
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    const material = new THREE.LineBasicMaterial({
      color: DIGITAL, transparent: true, opacity: 0, depthWrite: false,
    })
    return { geometry, material }
  }, [])

  useFrame(() => {
    const c = clock.current
    const on = c.act >= ACT.RESIDUAL && c.act < ACT.BRAND
      ? (c.act === ACT.RESIDUAL ? smoothstep(0.05, 0.34, c.progress) : 1)
      : 0
    material.opacity += (on * 0.95 - material.opacity) * 0.06
    if (group.current) {
      group.current.visible = material.opacity > 0.01
      group.current.rotation.y += 0.0009
    }
  })

  return (
    <group ref={group}>
      <lineSegments geometry={geometry} material={material} />
    </group>
  )
}

/* ------------------------------------------------------- residual marker -- */

/** The quantity the whole product is built on, drawn where it is measured. */
function ResidualMarker({
  clock,
  origin,
}: {
  clock: React.MutableRefObject<IntroClock>
  origin: THREE.Vector3
}) {
  const barRef = useRef<THREE.Mesh>(null)
  const ringRef = useRef<THREE.Mesh>(null)
  const barMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: RESIDUAL, transparent: true, opacity: 0, depthWrite: false }),
    [],
  )
  const ringMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: FAULT, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }),
    [],
  )

  useFrame((state) => {
    const c = clock.current
    const grow =
      c.act === ACT.RESIDUAL ? smoothstep(0.45, 0.95, c.progress) * 0.28
        : c.act === ACT.ANOMALY ? 0.28 + smoothstep(0.1, 0.85, c.progress) * 0.72
          : c.act > ACT.ANOMALY && c.act < ACT.BRAND ? 1
            : 0

    barMaterial.opacity += ((grow > 0.01 ? 0.92 : 0) - barMaterial.opacity) * 0.07
    const flagged = c.act >= ACT.ANOMALY && c.act < ACT.BRAND ? 1 : 0
    ringMaterial.opacity +=
      (flagged * (0.45 + 0.3 * Math.sin(state.clock.elapsedTime * 4)) - ringMaterial.opacity) * 0.1

    if (barRef.current) {
      barRef.current.scale.y = 0.05 + grow * 1.5
      barRef.current.position.y = origin.y + 0.34 + (0.05 + grow * 1.5) * 0.22
    }
    if (ringRef.current) ringRef.current.scale.setScalar(1 + 0.07 * Math.sin(state.clock.elapsedTime * 4))
  })

  return (
    <group>
      <mesh ref={barRef} material={barMaterial} position={[origin.x, origin.y + 0.4, origin.z]}>
        <boxGeometry args={[0.05, 0.44, 0.05]} />
      </mesh>
      <mesh
        ref={ringRef}
        material={ringMaterial}
        position={[origin.x, origin.y, origin.z]}
        rotation={[0, 0, Math.PI / 2]}
      >
        <ringGeometry args={[0.3, 0.36, 28]} />
      </mesh>
    </group>
  )
}

/* ---------------------------------------------------------- the verdict -- */

/**
 * What the classifier is doing, drawn rather than asserted.
 *
 * An arc that fills to the score, a band of evidence samples feeding it from
 * the machine, and a second arc that runs ahead of the first once the score
 * has settled - detection, then prediction. No brain icon, no neural mesh:
 * the only thing on screen is the quantity being computed.
 */
function Verdict({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const SCORE = 0.87
  const SAMPLES = 90

  const arcRef = useRef<THREE.Mesh>(null)
  const leadRef = useRef<THREE.Mesh>(null)
  const group = useRef<THREE.Group>(null)

  const arcMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: RESIDUAL, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }),
    [],
  )
  const trackMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: '#c9d6e6', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }),
    [],
  )
  const leadMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: '#0aa7c2', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }),
    [],
  )

  /* The evidence: samples drifting up out of the assembly into the arc. */
  const { geometry, material, seeds } = useMemo(() => {
    const positions = new Float32Array(SAMPLES * 3)
    const seeds = new Float32Array(SAMPLES * 2)
    for (let i = 0; i < SAMPLES; i += 1) {
      seeds[i * 2] = Math.random()
      seeds[i * 2 + 1] = (Math.random() - 0.5) * 1.9
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color: RESIDUAL, size: 0.038, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true,
    })
    return { geometry, material, seeds }
  }, [])

  useFrame((state, delta) => {
    const c = clock.current
    const on =
      c.act === ACT.AI ? smoothstep(0.04, 0.26, c.progress)
        : c.act === ACT.ADVISORY ? 1 - smoothstep(0.35, 0.75, c.progress)
          : 0

    arcMaterial.opacity += (on * 0.95 - arcMaterial.opacity) * 0.09
    trackMaterial.opacity += (on * 0.7 - trackMaterial.opacity) * 0.09
    material.opacity += (on * 0.9 - material.opacity) * 0.09

    // Detection fills first; prediction only runs once the score has settled.
    const fill = c.act === ACT.AI ? smoothstep(0.14, 0.62, c.progress) * SCORE : SCORE
    const predict = c.act === ACT.AI ? smoothstep(0.66, 0.95, c.progress)
      : c.act === ACT.ADVISORY ? 1 : 0
    leadMaterial.opacity += (on * predict * 0.9 - leadMaterial.opacity) * 0.09

    if (group.current) group.current.visible = arcMaterial.opacity > 0.02
    if (arcRef.current) {
      arcRef.current.geometry.dispose()
      arcRef.current.geometry = new THREE.RingGeometry(0.52, 0.6, 48, 1, Math.PI * 0.75, Math.PI * 1.5 * fill)
    }
    if (leadRef.current) {
      leadRef.current.geometry.dispose()
      leadRef.current.geometry = new THREE.RingGeometry(
        0.63, 0.68, 48, 1,
        Math.PI * 0.75 + Math.PI * 1.5 * SCORE,
        Math.PI * 0.34 * predict,
      )
    }

    if (material.opacity > 0.02) {
      const attribute = geometry.attributes.position as THREE.BufferAttribute
      const step = Math.min(0.06, delta) * 0.5
      for (let i = 0; i < SAMPLES; i += 1) {
        let u = seeds[i * 2] + step * (0.6 + (i % 5) / 7)
        if (u > 1) u -= 1
        seeds[i * 2] = u
        // Up out of the cylinder bank, converging on the arc's centre.
        const spread = (1 - u) * seeds[i * 2 + 1]
        attribute.setXYZ(i, spread, -0.5 + u * 1.9, Math.cos(u * 5 + i) * 0.1 * (1 - u))
      }
      attribute.needsUpdate = true
    }
    void state
  })

  return (
    <group ref={group} position={[0, 1.95, 0]}>
      <mesh material={trackMaterial}>
        <ringGeometry args={[0.52, 0.6, 48, 1, Math.PI * 0.75, Math.PI * 1.5]} />
      </mesh>
      <mesh ref={arcRef} material={arcMaterial}>
        <ringGeometry args={[0.52, 0.6, 48, 1, Math.PI * 0.75, Math.PI * 1.3]} />
      </mesh>
      <mesh ref={leadRef} material={leadMaterial}>
        <ringGeometry args={[0.63, 0.68, 48, 1, 0, 0.1]} />
      </mesh>
      <points geometry={geometry} material={material} frustumCulled={false} />
    </group>
  )
}

/* -------------------------------------------------------------- labels --- */

/**
 * The only words inside the 3D frame: the sensor channels as they come up, the
 * flagged cylinder, and the classifier's read-out. Each is a DOM node so it
 * stays crisp at any distance, and each is driven from the clock rather than
 * from React state.
 */
/**
 * Labels drawn on the physical half: the sensor channels as they come up, and
 * the cylinder the twin ends up flagging. Both ride with the assembly when it
 * separates, because both are properties of the metal.
 */
function EngineLabels({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const sensorRefs = useRef<Array<HTMLDivElement | null>>([])
  const flagRef = useRef<HTMLDivElement>(null)

  useFrame(() => {
    const c = clock.current
    for (let i = 0; i < SENSORS.length; i += 1) {
      const el = sensorRefs.current[i]
      if (!el) continue
      const on =
        c.act === ACT.SENSE ? smoothstep(0.08 + i * 0.16, 0.24 + i * 0.16, c.progress)
          : c.act === ACT.RESIDUAL ? 1 - smoothstep(0.16, 0.46, c.progress)
            : 0
      el.style.opacity = String(on)
      el.style.transform = `translateY(${(1 - on) * 8}px)`
    }
    if (flagRef.current) {
      const on = c.act === ACT.ANOMALY ? smoothstep(0.42, 0.7, c.progress)
        : c.act > ACT.ANOMALY && c.act < ACT.BRAND ? 1 : 0
      flagRef.current.style.opacity = String(on)
    }
  })

  const spots: Array<[number, number, number]> = [
    [1.15, 0.42, 0.62], [-1.15, -0.34, 0.62], [0, 0.5, 1.15], [-1.15, 0.42, -0.62],
  ]

  return (
    <>
      {SENSORS.map((key, i) => (
        <Html key={key} position={spots[i]} center distanceFactor={5.4} zIndexRange={[8, 0]}>
          <div
            className="scene-tag"
            ref={(el) => { sensorRefs.current[i] = el }}
            style={{ opacity: 0 }}
          >
            {key}
          </div>
        </Html>
      ))}

      <Html position={[1.3, 0.36, -0.62]} center distanceFactor={4.4} zIndexRange={[9, 0]}>
        <div className="scene-tag scene-tag--fault" ref={flagRef} style={{ opacity: 0 }}>
          CYL 3
        </div>
      </Html>
    </>
  )
}

/**
 * The three quantities the product is built on, named under the two halves
 * they belong to, plus the classifier's read-out. These sit on the assembly
 * rather than on either half, because the residual belongs to neither.
 */
function PairLabels({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const refs = useRef<Array<HTMLDivElement | null>>([])
  const aiRef = useRef<HTMLDivElement>(null)

  useFrame(() => {
    const c = clock.current
    for (let i = 0; i < 3; i += 1) {
      const el = refs.current[i]
      if (!el) continue
      const on =
        c.act === ACT.RESIDUAL ? smoothstep(0.36 + i * 0.1, 0.52 + i * 0.1, c.progress)
          : c.act > ACT.RESIDUAL && c.act < ACT.BRAND ? 1 : 0
      el.style.opacity = String(on)
    }
    if (aiRef.current) {
      const on = c.act === ACT.AI ? smoothstep(0.12, 0.35, c.progress)
        : c.act === ACT.ADVISORY ? 1 - smoothstep(0.4, 0.8, c.progress) : 0
      aiRef.current.style.opacity = String(on)
    }
  })

  const pair: Array<{ key: string; at: [number, number, number]; cls: string }> = [
    { key: 'ACTUAL', at: [-1.7, -0.95, 0], cls: 'scene-tag--plain' },
    { key: 'EXPECTED', at: [1.7, -0.95, 0], cls: 'scene-tag--twin' },
    { key: 'RESIDUAL', at: [-0.82, 1.42, -0.62], cls: 'scene-tag--residual' },
  ]

  return (
    <>
      {pair.map((item, i) => (
        <Html key={item.key} position={item.at} center distanceFactor={6.6} zIndexRange={[8, 0]}>
          <div
            className={`scene-tag ${item.cls}`}
            ref={(el) => { refs.current[i] = el }}
            style={{ opacity: 0 }}
          >
            {item.key}
          </div>
        </Html>
      ))}

      <Html position={[0, 2.86, 0]} center distanceFactor={5.6} zIndexRange={[9, 0]}>
        <div className="scene-tag scene-tag--ai" ref={aiRef} style={{ opacity: 0 }}>
          ANOMALY 87%
        </div>
      </Html>
    </>
  )
}

/* ------------------------------------------------------- the assembly ---- */

function EngineAssembly({
  clock,
  anchor,
}: {
  clock: React.MutableRefObject<IntroClock>
  anchor: THREE.Vector3
}) {
  const root = useRef<THREE.Group>(null)
  const physical = useRef<THREE.Group>(null)
  const holo = useRef<THREE.Group>(null)
  const state = useRef<EngineVisualState>(emptyEngineState())
  const streamActive = useRef(0)

  const streamFrom = useMemo(() => new THREE.Vector3(-1.05, 0.1, 0), [])
  const streamTo = useMemo(() => new THREE.Vector3(1.05, 0.1, 0), [])
  // Cylinder 3: right bank, aft. The cylinder the demo story degrades.
  const cyl3 = useMemo(() => new THREE.Vector3(0.9, 0.1, -0.62), [])

  useFrame(() => {
    const c = clock.current
    const s = state.current
    if (!root.current) return

    root.current.position.copy(anchor)

    // The assembly grows out of the propulsion bay as the airframe dissolves,
    // and shrinks back into it on the closing act.
    const reveal =
      c.act < ACT.ENGINE ? 0
        : c.act === ACT.ENGINE ? smoothstep(0.26, 0.66, c.progress)
          : c.act < ACT.BRAND ? 1
            : 1 - smoothstep(0, 0.3, outro(c, 3))
    s.reveal = reveal
    root.current.visible = reveal > 0.01
    root.current.scale.setScalar(0.12 + reveal * 0.88)

    s.rpm = 2380
    s.power = 0.74

    // The four views, walked through in order during MODES, then the
    // diagnostic pair for the rest of the sequence.
    if (c.act === ACT.MODES) {
      s.mode = c.progress < 0.26 ? 'PHYSICAL'
        : c.progress < 0.54 ? 'THERMAL'
          : c.progress < 0.8 ? 'AIRFLOW' : 'TWIN'
    } else if (c.act >= ACT.RESIDUAL && c.act < ACT.BRAND) {
      s.mode = c.act >= ACT.ANOMALY ? 'DIAGNOSTIC' : 'TWIN'
    } else {
      s.mode = 'PHYSICAL'
    }

    s.anomalyIndex = c.act >= ACT.ANOMALY && c.act < ACT.BRAND
      ? (c.act === ACT.ANOMALY && c.progress < 0.35 ? 0 : 3)
      : 0

    // The story the residual tells: cylinder 3 pulls away from its physics
    // expectation while every absolute reading is still inside limits.
    const drift =
      c.act === ACT.RESIDUAL ? smoothstep(0.5, 1, c.progress) * 0.2
        : c.act === ACT.ANOMALY ? 0.2 + smoothstep(0.05, 0.8, c.progress) * 0.8
          : c.act > ACT.ANOMALY && c.act < ACT.BRAND ? 1 : 0
    for (let i = 0; i < 4; i += 1) {
      const cyl = s.cylinders[i]
      cyl.chtExpected = 198
      cyl.cht = i === 2 ? 198 + 17.2 * drift : 196 + i * 1.6
      cyl.residual = i === 2 ? 17.2 * drift : (i - 1.5) * 0.7
      cyl.egt = i === 2 ? 690 + 44 * drift : 688 + i * 4
      cyl.status = i === 2 && drift > 0.45 ? 'WARNING' : 'NORMAL'
    }

    // Physical and digital separate for the comparison and stay apart.
    const split = c.act >= ACT.RESIDUAL && c.act < ACT.BRAND
      ? (c.act === ACT.RESIDUAL ? smoothstep(0, 0.34, c.progress) : 1)
      : 0
    streamActive.current = split
    if (physical.current) {
      physical.current.position.x = -1.7 * split
      physical.current.rotation.y = 0.55 * split
    }
    if (holo.current) {
      holo.current.position.x = 1.7 * split
      holo.current.rotation.y = 0.55 * split
    }
  })

  return (
    <group ref={root}>
      <group ref={physical}>
        <EngineModel state={state} scale={1} />
        <ResidualMarker clock={clock} origin={cyl3} />
        <EngineLabels clock={clock} />
      </group>
      <PairLabels clock={clock} />
      <Verdict clock={clock} />
      <group ref={holo}>
        <HoloEngine clock={clock} />
      </group>

      <DataStream from={streamFrom} to={streamTo} colour={DIGITAL} count={140} active={streamActive} />
      <DataStream from={streamFrom} to={streamTo} colour={RESIDUAL} count={70} reverse active={streamActive} />

      {/* Fill for the assembly, local so it cannot wash the sector. */}
      <pointLight position={[-2.2, 1.8, 2.4]} intensity={11} distance={10} decay={2} color="#ffffff" />
      <pointLight position={[2.4, -0.4, -1.6]} intensity={5} distance={8} decay={2} color="#bfe3ff" />
    </group>
  )
}

/* -------------------------------------------------------- the atmosphere -- */

/**
 * Outside becomes inside.
 *
 * Once the camera has travelled through the skin, the sector has no business
 * being behind the engine: a piston assembly floating over a hillside reads as
 * a compositing error, not as an inspection. So the fog closes to a few metres
 * and everything - haze, clear colour, sky dome - lifts to the same white the
 * console is built on. The move out on the closing act reverses it.
 *
 * This is also the one place the film crosses from the physical world into the
 * digital one, and the change of ground is what says so.
 */
function Atmosphere({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const { scene, gl } = useThree()
  const sky = useMemo(() => new THREE.Color('#d3e2f2'), [])
  const studio = useMemo(() => new THREE.Color('#f4f9ff'), [])
  const blend = useMemo(() => new THREE.Color(), [])
  const dome = useRef<THREE.ShaderMaterial | null>(null)
  const sector = useRef<THREE.Group | null>(null)

  useFrame(() => {
    const c = clock.current
    const inside =
      c.act === ACT.ENGINE ? smoothstep(0.3, 0.74, c.progress)
        : c.act > ACT.ENGINE && c.act < ACT.BRAND ? 1
          : c.act >= ACT.BRAND ? 1 - smoothstep(0.05, 0.45, outro(c, 4))
            : 0

    const fog = scene.fog as THREE.Fog | null
    if (fog) {
      fog.near = THREE.MathUtils.lerp(150, 7, inside)
      fog.far = THREE.MathUtils.lerp(720, 42, inside)
      blend.copy(sky).lerp(studio, inside)
      fog.color.copy(blend)
    } else {
      blend.copy(sky).lerp(studio, inside)
    }

    if (scene.background instanceof THREE.Color) scene.background.copy(blend)
    gl.setClearColor(blend)

    if (!dome.current) {
      const mesh = scene.getObjectByName('sky-dome') as THREE.Mesh | undefined
      if (mesh) dome.current = mesh.material as THREE.ShaderMaterial
    }
    if (dome.current) dome.current.uniforms.uFade.value = inside

    // Once the frame has gone white the sector is contributing nothing but a
    // ghost of the hillside behind the assembly. Dropping it there is free and
    // invisible, and it is what makes the inspection read as a studio.
    if (!sector.current) sector.current = scene.getObjectByName('sector') as THREE.Group | null
    if (sector.current) sector.current.visible = inside < 0.97
  })

  return null
}

/* ------------------------------------------------------------- camera ---- */

function IntroCamera({
  clock,
  anchor,
}: {
  clock: React.MutableRefObject<IntroClock>
  anchor: THREE.Vector3
}) {
  const desired = useMemo(() => new THREE.Vector3(), [])
  const lookAt = useMemo(() => new THREE.Vector3(), [])
  const smoothed = useMemo(() => new THREE.Vector3(STAGE.x - 116, STAGE.y + 30, STAGE.z + 98), [])
  const smoothedLook = useMemo(() => new THREE.Vector3().copy(STAGE), [])
  const aircraft = useMemo(() => new THREE.Vector3(), [])

  useFrame((state, delta) => {
    const c = clock.current
    const dt = Math.min(0.1, delta)
    const camera = state.camera as THREE.PerspectiveCamera
    aircraftAt(aircraft, c)
    const p = c.progress
    const ease = p * p * (3 - 2 * p)

    let fov = 38
    let rate = 1.5

    switch (c.act) {
      case ACT.HORIZON: {
        // The range. A slow crane down and across the basin, looking along the
        // ridge line so the ground has relief and depth before anything
        // technical is in the frame. The aircraft is a speck out to the left.
        desired.set(
          STAGE.x - 116 + p * 30,
          STAGE.y + 30 - p * 13,
          STAGE.z + 98 - p * 24,
        )
        lookAt.set(STAGE.x + 66, STAGE.y - 12, STAGE.z - 26)
        fov = 48 - p * 5
        rate = 0.6
        break
      }
      case ACT.CONTACT: {
        // Contact. The camera finds the aircraft downrange and closes on it on
        // a long lens - the compression is what sells the distance.
        desired.set(
          aircraft.x - 52 + ease * 22,
          aircraft.y + 11 - ease * 7.5,
          aircraft.z + 56 - ease * 28,
        )
        lookAt.copy(aircraft)
        fov = 44 - ease * 14
        rate = 0.9
        break
      }
      case ACT.AIRFRAME: {
        // Hero: behind, through the side, out to a front three-quarter.
        // Behind, through the side, out to a front three-quarter - and ending
        // just below the aircraft, so it is read against sky rather than
        // against the ground it is flying over.
        const angle = Math.PI * (1.16 - 0.7 * ease)
        const radius = 22 - 17.2 * ease
        desired.set(
          aircraft.x + Math.cos(angle) * radius,
          aircraft.y + 4.4 - 5.6 * ease,
          aircraft.z + Math.sin(angle) * radius,
        )
        lookAt.set(aircraft.x, aircraft.y + 0.15, aircraft.z)
        fov = 34 - ease * 2
        rate = 1.35
        break
      }
      case ACT.SCAN: {
        // The acquisition. A slow orbit round to the +Z side, closing in.
        const angle = Math.PI * (0.46 + 0.06 * ease)
        const radius = 6.4 - 1.3 * ease
        desired.set(
          aircraft.x + Math.cos(angle) * radius,
          aircraft.y - 0.9 + 0.5 * ease,
          aircraft.z + Math.sin(angle) * radius,
        )
        lookAt.set(aircraft.x, aircraft.y + 0.1, aircraft.z)
        fov = 33
        rate = 1.9
        break
      }
      case ACT.SYNC: {
        // Square on, so world +X reads as screen right and the two halves sit
        // where their labels say they do.
        desired.set(aircraft.x - 0.1, aircraft.y - 1.4 + p * 0.5, aircraft.z + 10.8 + p * 1.1)
        lookAt.set(aircraft.x, aircraft.y + 0.35, aircraft.z)
        fov = 40
        rate = 1.1
        break
      }
      case ACT.ENGINE: {
        // Into the propulsion bay. The camera keeps moving through the point
        // where the skin dissolves, which is what makes it read as travel
        // rather than as a cut.
        const angle = Math.PI * (0.5 - 0.24 * ease)
        const radius = 12.5 - 8.2 * ease
        desired.set(
          anchor.x + Math.cos(angle) * radius,
          anchor.y + 1.5 - 0.85 * ease,
          anchor.z + Math.sin(angle) * radius,
        )
        lookAt.set(anchor.x, anchor.y - 0.05, anchor.z)
        fov = 38 - ease * 6
        rate = 1.05
        break
      }
      case ACT.MODES: {
        // A slow pass around the running assembly, forward of the crankcase so
        // the cylinders and the crank train are never hidden behind it.
        const angle = Math.PI * (0.26 + 0.42 * p)
        const radius = 5.0 - 0.7 * p
        desired.set(
          anchor.x + Math.cos(angle) * radius,
          anchor.y + 1.5 - 0.7 * p,
          anchor.z + Math.sin(angle) * radius,
        )
        lookAt.set(anchor.x, anchor.y - 0.1, anchor.z)
        fov = 34
        rate = 1.4
        break
      }
      case ACT.SENSE: {
        // Close and slightly under: the sensor tags sit above the heads.
        const angle = Math.PI * (0.68 + 0.14 * p)
        desired.set(
          anchor.x + Math.cos(angle) * 4.1,
          anchor.y + 0.6 + 0.4 * p,
          anchor.z + Math.sin(angle) * 4.1,
        )
        lookAt.set(anchor.x, anchor.y + 0.15, anchor.z)
        fov = 36
        rate = 1.2
        break
      }
      case ACT.RESIDUAL: {
        // Both halves in frame, square on, streams running between them.
        desired.set(anchor.x - 0.15, anchor.y + 0.95 + p * 0.25, anchor.z + 7.8 + p * 0.7)
        lookAt.set(anchor.x, anchor.y + 0.12, anchor.z)
        fov = 36
        rate = 1.15
        break
      }
      case ACT.ANOMALY: {
        // Round to the aft-right quarter, where cylinder 3 is, and hold.
        const angle = Math.PI * (0.5 + 0.16 * ease)
        const radius = 9.4 - 3.0 * ease
        desired.set(
          anchor.x + Math.cos(angle) * radius,
          anchor.y + 1.3 - 0.35 * ease,
          anchor.z + Math.sin(angle) * radius,
        )
        lookAt.set(anchor.x - 0.9 * ease, anchor.y + 0.2, anchor.z - 0.3 * ease)
        fov = 36
        rate = 1.0
        break
      }
      case ACT.AI: {
        // Pull out and up: the assembly drops into the lower half of the frame
        // and leaves the top for the probability read-out.
        desired.set(anchor.x - 0.35, anchor.y + 2.0 + p * 0.4, anchor.z + 8.8 + p * 1.2)
        lookAt.set(anchor.x, anchor.y + 0.6, anchor.z)
        fov = 39
        rate = 1.0
        break
      }
      case ACT.ADVISORY: {
        desired.set(anchor.x - 0.15, anchor.y + 1.35, anchor.z + 7.6)
        lookAt.set(anchor.x, anchor.y + 0.3, anchor.z)
        fov = 37
        rate = 0.9
        break
      }
      default: {
        // The way out: back to the range, the aircraft departing across it,
        // and the camera easing into a slow standing arc while the operator
        // decides to enter.
        const back = smoothstep(0, 1, outro(c, 9))
        const arc = Math.sin(c.t * 0.06) * 0.3
        desired.set(
          aircraft.x - 16 - back * 9 + Math.cos(arc) * 3.5,
          aircraft.y + 2.6 + back * 3,
          aircraft.z + 19 + back * 11 + Math.sin(arc) * 3.5,
        )
        // The aircraft rides high and a little right of the wordmark, which
        // owns the middle of the closing frame.
        lookAt.set(aircraft.x + 1.5, aircraft.y - 6.4, aircraft.z)
        fov = 40
        rate = 0.55
      }
    }

    const k = 1 - Math.exp(-rate * dt)
    smoothed.lerp(desired, k)
    smoothedLook.lerp(lookAt, 1 - Math.exp(-(rate + 0.9) * dt))
    camera.position.copy(smoothed)

    // A breath of handheld motion, plus one bump where the camera passes
    // through the skin, so the move into the engine has weight.
    const time = state.clock.elapsedTime
    const bump = c.act === ACT.ENGINE ? Math.max(0, 0.2 - Math.abs(p - 0.44) * 2.4) : 0
    camera.position.x += Math.sin(time * 0.7) * 0.05 + Math.sin(time * 23) * bump
    camera.position.y += Math.cos(time * 0.53) * 0.04 + Math.cos(time * 19) * bump * 0.7

    camera.lookAt(smoothedLook)
    camera.fov += (fov - camera.fov) * k
    camera.updateProjectionMatrix()
  })

  return null
}

/* -------------------------------------------------------------- scene ---- */

export function IntroScene({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const tier = useMemo(performanceTier, [])
  const clouds = tier === 'LOW' ? 18 : tier === 'MID' ? 34 : 52
  // The propulsion bay in world space, written by the aircraft each frame and
  // read by the engine assembly and the camera. One vector, no allocation.
  const anchor = useMemo(() => STAGE.clone(), [])

  return (
    <>
      <SkyDome />
      {/* Aerial perspective. Held well back: the point of the opening act is
          that the ground has relief, and a close fog plane flattens it. */}
      <fog attach="fog" args={['#d3e2f2', 150, 720]} />
      <Sun />

      {/* One sun lights the terrain, the aircraft and the engine alike. */}
      <hemisphereLight args={['#bfd8f2', '#8d9a7c', 0.72]} />
      <directionalLight position={SUN_POS} intensity={2.05} color="#fff2dc" />
      <directionalLight position={[-220, 110, -170]} intensity={0.42} color="#9dc0e9" />
      <ambientLight intensity={0.22} />

      <group name="sector">
        <Terrain />
        <SectorFloor />
        <Airbase />

        {/* Three decks, so the aircraft has cloud below it, beside it and
            above it. Sized in world units - altitude is exaggerated 4x here,
            and a deck sized for the sector grid comes back as a smear. */}
        <CloudDeck
          count={Math.round(clouds * 0.42)} altitudeFt={14400} spread={330} opacity={0.92}
          size={9} centre={[STAGE.x + 10, STAGE.z - 30]}
        />
        <CloudDeck
          count={Math.round(clouds * 0.8)} altitudeFt={26200} spread={300} opacity={0.6}
          size={17} centre={[STAGE.x - 50, STAGE.z - 34]}
        />
        <CloudDeck
          count={Math.round(clouds * 0.5)} altitudeFt={57000} spread={420} opacity={0.22}
          size={64} centre={[STAGE.x - 20, STAGE.z]}
        />
      </group>

      <IntroAircraft clock={clock} engineAnchor={anchor} />
      <EngineAssembly clock={clock} anchor={anchor} />
      <IntroCamera clock={clock} anchor={anchor} />
      <Atmosphere clock={clock} />
    </>
  )
}

export { STAGE as INTRO_ANCHOR, SUN_DIR }
