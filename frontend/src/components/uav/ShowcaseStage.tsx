/**
 * The UAV showcase stage.
 *
 * A bright studio rather than a sector: the aircraft as a physical object on a
 * white floor, lit by one key and a sky fill, with a soft contact shadow under
 * it so it has weight. The operator can orbit it freely; selecting a component
 * flies the camera to it, and selecting the engine keeps flying - past the
 * propeller, into the bay, until the airframe has dissolved and the assembly is
 * the subject. The camera never cuts.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, Html } from '@react-three/drei'
import * as THREE from 'three'
import { UavModel, type UavVisualState } from './UavModel'
import { EngineModel, emptyEngineState, type EngineViewMode, type EngineVisualState } from '../engine3d/EngineModel'
import type { CylinderHealth } from '../../types'

export type Hotspot = 'ENGINE' | 'PROPULSION' | 'WING' | 'SENSOR' | 'FUEL'

/** Where each component is on the airframe, and where the camera looks at it
 *  from. Positions are in model space at scale 1; the group is scaled once. */
export const HOTSPOTS: Array<{
  id: Hotspot
  at: [number, number, number]
  camera: [number, number, number]
  /** Screen-space offset for the label, so neighbouring tags do not stack. */
  nudge: [number, number]
}> = [
  { id: 'ENGINE',     at: [0, 0.02, -0.66],  camera: [3.7, 0.9, -4.1],  nudge: [26, -34] },
  { id: 'PROPULSION', at: [0, 0, -1.37],     camera: [3.6, 1.2, -5.4],  nudge: [-30, 30] },
  { id: 'WING',       at: [2.6, 0.22, 0.06], camera: [7.0, 3.4, 5.8],   nudge: [30, 26] },
  { id: 'SENSOR',     at: [0, -0.24, 0.8],   camera: [3.8, 0.3, 5.4],   nudge: [-34, 26] },
  { id: 'FUEL',       at: [-1.5, 0.1, 0.1],  camera: [-5.6, 2.4, 5.6],  nudge: [-30, -30] },
]

/* The wing extrudes a full span each side, so the airframe is a little over
   nine units across. The parking distance has to be set against that, not
   against the fuselage. */
const HOME: [number, number, number] = [7.6, 3.7, 9.7]

/* --------------------------------------------------------------- floor --- */

/** The technical floor: a faint engineering grid fading out with distance. */
function StudioFloor() {
  const material = useMemo(() => {
    const size = 512
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = 'rgba(20, 68, 130, 0.13)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 8; i += 1) {
      const v = (i / 8) * size
      ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, size); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(size, v); ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(20, 68, 130, 0.26)'
    ctx.lineWidth = 2
    ctx.strokeRect(0, 0, size, size)
    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(7, 7)
    texture.anisotropy = 4

    /* An alpha ramp, so the floor dissolves into the page instead of ending
       in a hard grey disc the eye reads as a wall. */
    const fadeCanvas = document.createElement('canvas')
    fadeCanvas.width = fadeCanvas.height = 256
    const fctx = fadeCanvas.getContext('2d')!
    const grad = fctx.createRadialGradient(128, 128, 10, 128, 128, 128)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.42, '#e0e0e0')
    grad.addColorStop(0.72, '#5a5a5a')
    grad.addColorStop(1, '#000000')
    fctx.fillStyle = grad
    fctx.fillRect(0, 0, 256, 256)
    const alpha = new THREE.CanvasTexture(fadeCanvas)

    return new THREE.MeshStandardMaterial({
      map: texture,
      alphaMap: alpha,
      transparent: true,
      roughness: 0.5,
      metalness: 0.05,
      color: '#ffffff',
      emissive: new THREE.Color('#eef4fb'),
      emissiveIntensity: 0.42,
    })
  }, [])

  return (
    <group position={[0, -1.05, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={material} receiveShadow>
        <circleGeometry args={[34, 72]} />
      </mesh>
      {/* The station rings the aircraft sits on. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
        <ringGeometry args={[6.6, 6.68, 128]} />
        <meshBasicMaterial color="#0a6ed6" transparent opacity={0.3} side={THREE.DoubleSide} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
        <ringGeometry args={[11.4, 11.44, 128]} />
        <meshBasicMaterial color="#0a6ed6" transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/* ------------------------------------------------------------ hotspots --- */

function Hotspots({
  selected,
  hovered,
  onHover,
  onSelect,
}: {
  selected: Hotspot | null
  hovered: Hotspot | null
  onHover: (id: Hotspot | null) => void
  onSelect: (id: Hotspot) => void
}) {
  if (selected === 'ENGINE') return null

  return (
    <group>
      {HOTSPOTS.map((spot) => {
        const active = selected === spot.id || hovered === spot.id
        return (
          <group key={spot.id} position={spot.at}>
            <mesh
              onPointerOver={(e) => { e.stopPropagation(); onHover(spot.id) }}
              onPointerOut={() => onHover(null)}
              onClick={(e) => { e.stopPropagation(); onSelect(spot.id) }}
            >
              <sphereGeometry args={[0.16, 12, 10]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            <mesh>
              <sphereGeometry args={[0.036, 12, 10]} />
              <meshBasicMaterial color={active ? '#0a6ed6' : '#0aa7c2'} />
            </mesh>
            <Html center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
              <button
                className={`hotspot ${active ? 'is-active' : ''} ${selected && !active ? 'is-muted' : ''}`}
                style={{
                  transform: `translate(${spot.nudge[0]}px, ${spot.nudge[1]}px)`,
                  pointerEvents: 'auto',
                }}
                onPointerOver={() => onHover(spot.id)}
                onPointerOut={() => onHover(null)}
                onClick={() => onSelect(spot.id)}
              >
                {spot.id}
              </button>
            </Html>
          </group>
        )
      })}
    </group>
  )
}

/* -------------------------------------------------------------- camera --- */

/**
 * Camera choreography.
 *
 * Orbit is free until a component is selected; then the rig takes over and
 * eases to that component's station. Handing control back is the same move in
 * reverse, so the operator is never teleported.
 */
function ShowcaseCamera({
  target,
  autoOrbit,
  engineMode,
}: {
  target: React.MutableRefObject<{
    position: THREE.Vector3
    lookAt: THREE.Vector3
    fov: number
    free: boolean
  }>
  autoOrbit: React.MutableRefObject<boolean>
  engineMode: React.MutableRefObject<number>
}) {
  const { camera } = useThree()
  const orbit = useRef({ theta: 0.86, phi: 1.12, radius: 13 })
  const smoothLook = useMemo(() => new THREE.Vector3(0, 0, 0), [])

  /* Free orbit, driven by the pointer on the canvas. */
  useEffect(() => {
    const el = document.getElementById('uav-showcase-canvas')
    if (!el) return
    let dragging = false
    let lastX = 0
    let lastY = 0

    const down = (e: PointerEvent) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      autoOrbit.current = false
    }
    const move = (e: PointerEvent) => {
      if (!dragging || !target.current.free) return
      orbit.current.theta -= (e.clientX - lastX) * 0.006
      orbit.current.phi = Math.max(
        0.32,
        Math.min(1.52, orbit.current.phi - (e.clientY - lastY) * 0.004),
      )
      lastX = e.clientX
      lastY = e.clientY
    }
    const up = () => { dragging = false }
    const wheel = (e: WheelEvent) => {
      if (!target.current.free) return
      e.preventDefault()
      orbit.current.radius = Math.max(6, Math.min(30, orbit.current.radius + e.deltaY * 0.012))
      autoOrbit.current = false
    }

    el.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [target, autoOrbit])

  const desired = useMemo(() => new THREE.Vector3(...HOME), [])

  useFrame((_, delta) => {
    const dt = Math.min(0.08, delta)
    const t = target.current

    if (t.free) {
      if (autoOrbit.current) orbit.current.theta += dt * 0.11
      const { theta, phi, radius } = orbit.current
      desired.set(
        Math.sin(theta) * Math.sin(phi) * radius,
        Math.cos(phi) * radius,
        Math.cos(theta) * Math.sin(phi) * radius,
      )
      smoothLook.lerp(new THREE.Vector3(0, 0, 0), 1 - Math.exp(-3 * dt))
    } else {
      desired.copy(t.position)
      smoothLook.lerp(t.lookAt, 1 - Math.exp(-2.6 * dt))
      // While the engine is the subject, keep a slow standing arc so the
      // assembly is read from more than one angle without any input.
      if (engineMode.current > 0.7) {
        const a = performance.now() / 1000 * 0.14
        desired.x += Math.sin(a) * 0.55
        desired.z += Math.cos(a) * 0.55
      }
    }

    camera.position.lerp(desired, 1 - Math.exp(-2.2 * dt))
    camera.lookAt(smoothLook)
    const cam = camera as THREE.PerspectiveCamera
    cam.fov += (t.fov - cam.fov) * (1 - Math.exp(-2.4 * dt))
    cam.updateProjectionMatrix()
  })

  return null
}

/* --------------------------------------------------------------- stage --- */

export function ShowcaseScene({
  selected,
  hovered,
  engineView,
  cylinders,
  rpm,
  power,
  anomalyIndex,
  onHover,
  onSelect,
}: {
  selected: Hotspot | null
  hovered: Hotspot | null
  engineView: EngineViewMode
  cylinders: CylinderHealth[]
  rpm: number
  power: number
  anomalyIndex: number
  onHover: (id: Hotspot | null) => void
  onSelect: (id: Hotspot) => void
}) {
  const uavState = useRef<UavVisualState>({
    rpm: 2400, bank: 0, pitch: 0, airborne: 0, alert: 0, opacity: 1,
  })
  const engineState = useRef<EngineVisualState>(emptyEngineState())
  const engineRoot = useRef<THREE.Group>(null)
  const engineFade = useRef(0)
  const autoOrbit = useRef(true)

  const target = useRef({
    position: new THREE.Vector3(...HOME),
    lookAt: new THREE.Vector3(0, 0, 0),
    fov: 32,
    free: true,
  })

  /* Selection drives the camera station and, for the engine, the dissolve. */
  useEffect(() => {
    const t = target.current
    if (!selected) {
      t.free = true
      t.fov = 32
      autoOrbit.current = true
      return
    }
    const spot = HOTSPOTS.find((s) => s.id === selected)!
    t.free = false
    t.position.set(spot.camera[0], spot.camera[1], spot.camera[2])
    t.lookAt.set(spot.at[0], spot.at[1], spot.at[2])
    t.fov = selected === 'ENGINE' ? 36 : 30
  }, [selected])

  useFrame((state, delta) => {
    const dt = Math.min(0.08, delta)

    // The airframe dissolves only for ENGINE - every other station inspects
    // the aircraft as installed.
    const wantEngine = selected === 'ENGINE' ? 1 : 0
    engineFade.current += (wantEngine - engineFade.current) * (1 - Math.exp(-1.9 * dt))
    const f = engineFade.current

    uavState.current.opacity = 1 - f
    uavState.current.rpm = rpm
    uavState.current.alert = anomalyIndex ? 0.8 : 0

    const s = engineState.current
    s.rpm = rpm
    s.power = power
    s.anomalyIndex = anomalyIndex
    s.mode = engineView
    s.reveal = f
    for (let i = 0; i < 4; i += 1) {
      const c = cylinders[i]
      const cyl = s.cylinders[i]
      if (c && cyl) {
        cyl.cht = c.cht_observed
        cyl.chtExpected = c.cht_expected
        cyl.egt = c.egt_observed
        cyl.residual = c.cht_residual
        cyl.status = c.status
      }
    }

    if (engineRoot.current) {
      engineRoot.current.visible = f > 0.02
      // The assembly grows out of the bay it lives in, at the bay's scale.
      engineRoot.current.scale.setScalar(0.18 + f * 0.92)
      engineRoot.current.position.set(0, 0.02 * (1 - f), -0.66 * (1 - f) - 0.05 * f)
    }
    void state
  })

  return (
    <>
      {/* A bright studio: one key, a sky fill, a cool bounce off the floor. */}
      <hemisphereLight args={['#eaf3fe', '#c9d7e6', 1.55]} />
      <directionalLight
        position={[9, 11, 7]}
        intensity={2.9}
        color="#fff7ea"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={48}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
      />
      <directionalLight position={[-10, 5, -8]} intensity={0.6} color="#a9c7e8" />
      <directionalLight position={[0, -5, 7]} intensity={0.4} color="#ffffff" />

      {/* A procedural softbox rig rendered to an env map. Nothing is fetched:
          the reflections are a white room with two bright panels in it, which
          is what makes machined alloy read as alloy rather than as flat grey. */}
      <Environment resolution={128} frames={1}>
        <mesh scale={80}>
          <sphereGeometry args={[1, 24, 16]} />
          <meshBasicMaterial color="#b9cbdd" side={THREE.BackSide} />
        </mesh>
        <mesh position={[0, 40, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[46, 46, 1]}>
          <planeGeometry />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        <mesh position={[34, 12, 20]} rotation={[0, -Math.PI / 3, 0]} scale={[26, 30, 1]}>
          <planeGeometry />
          <meshBasicMaterial color="#f2f6fa" />
        </mesh>
        <mesh position={[-30, 6, -22]} rotation={[0, Math.PI / 2.6, 0]} scale={[22, 22, 1]}>
          <planeGeometry />
          <meshBasicMaterial color="#9fbcd8" />
        </mesh>
        <mesh position={[0, -32, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[60, 60, 1]}>
          <planeGeometry />
          <meshBasicMaterial color="#e6eef7" />
        </mesh>
      </Environment>

      <StudioFloor />
      <ContactShadows
        position={[0, -1.04, 0]}
        opacity={0.55}
        scale={22}
        blur={2.1}
        far={6}
        resolution={512}
        color="#274766"
      />

      <group>
        <UavModel state={uavState} scale={1} showGear />
        <Hotspots selected={selected} hovered={hovered} onHover={onHover} onSelect={onSelect} />
        <group ref={engineRoot}>
          <EngineModel state={engineState} scale={1} />
        </group>
      </group>

      <ShowcaseCamera target={target} autoOrbit={autoOrbit} engineMode={engineFade} />
    </>
  )
}
