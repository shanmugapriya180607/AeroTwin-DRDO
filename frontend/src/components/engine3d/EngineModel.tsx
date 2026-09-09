/**
 * The propulsion unit, in three dimensions.
 *
 * A four-cylinder horizontally opposed air-cooled piston engine - the class
 * the corpus was recorded on and the class the twin models. It is a
 * communicating visualisation, not a CAD model: the geometry is simplified,
 * but everything that moves is driven by the same numbers the analytics run
 * on, so a hot cylinder here is the cylinder the residual engine flagged.
 *
 * Everything is procedural. No model file, no texture fetch, nothing that can
 * fail at runtime.
 */

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { simClock } from '../../simulation'

export type EngineViewMode = 'PHYSICAL' | 'THERMAL' | 'AIRFLOW' | 'DIAGNOSTIC' | 'TWIN'

export interface EngineCylinderState {
  /** Measured cylinder head temperature, degrees C. */
  cht: number
  /** What the physics model expected for the same inputs. */
  chtExpected: number
  /** Measured exhaust gas temperature, degrees C. */
  egt: number
  /** actual - expected, the diagnostic quantity. */
  residual: number
  /** NORMAL | CAUTION | WARNING | CRITICAL */
  status: string
}

export interface EngineVisualState {
  rpm: number
  /** Fraction of rated power, 0-1. Drives combustion brightness. */
  power: number
  cylinders: EngineCylinderState[]
  /** 1-based index of the cylinder the twin has flagged, or 0. */
  anomalyIndex: number
  mode: EngineViewMode
  /** 0-1, fades the assembly in during the intro. */
  reveal: number
  /**
   * Accumulated crank angle in radians.
   *
   * Integrated once per frame from RPM by the root, and only while the
   * simulation clock is running. The assembly used to read the renderer's
   * wall clock, which meant the pistons kept turning through a paused
   * simulation - an engine animating against frozen telemetry.
   */
  crank: number
}

export const NEUTRAL_CYLINDER: EngineCylinderState = {
  cht: 182, chtExpected: 182, egt: 690, residual: 0, status: 'NORMAL',
}

export function emptyEngineState(): EngineVisualState {
  return {
    rpm: 2400,
    power: 0.72,
    cylinders: [0, 1, 2, 3].map(() => ({ ...NEUTRAL_CYLINDER })),
    anomalyIndex: 0,
    mode: 'PHYSICAL',
    reveal: 1,
    crank: 0,
  }
}

/* Cylinder layout. Odd numbers to the right of the crankcase, even to the
   left, one and two forward - the arrangement the cylinder numbering in the
   data dictionary refers to. Crank axis is +Z, propeller forward. */
const LAYOUT = [
  { index: 1, side: 1, z: 0.62, phase: 0 },
  { index: 2, side: -1, z: 0.62, phase: Math.PI },
  { index: 3, side: 1, z: -0.62, phase: Math.PI },
  { index: 4, side: -1, z: -0.62, phase: 0 },
]

const COOL = new THREE.Color('#5a7f96')
const WARM = new THREE.Color('#c8923c')
const HOT = new THREE.Color('#e0523f')

/** Map a cylinder head temperature onto the thermal ramp. */
function thermalColour(target: THREE.Color, cht: number) {
  const t = Math.max(0, Math.min(1, (cht - 140) / 110))
  if (t < 0.55) target.copy(COOL).lerp(WARM, t / 0.55)
  else target.copy(WARM).lerp(HOT, (t - 0.55) / 0.45)
  return target
}

/* ---------------------------------------------------------- materials --- */

function useEngineMaterials() {
  return useMemo(() => {
    /* envMapIntensity is held well below 1 on purpose. In the showcase these
       sit inside a white studio env map, and a high-metalness surface with a
       full-strength white environment reflects the room back at you - the
       assembly goes to a flat pale silhouette and the machining disappears.
       On the console there is no env map, so the value costs nothing there. */
    const env = 0.5
    const shared = {
      case: new THREE.MeshStandardMaterial({ color: '#96a1ae', metalness: 0.62, roughness: 0.38, envMapIntensity: env }),
      barrel: new THREE.MeshStandardMaterial({ color: '#4e5866', metalness: 0.48, roughness: 0.52, envMapIntensity: env }),
      fin: new THREE.MeshStandardMaterial({ color: '#7b8794', metalness: 0.54, roughness: 0.42, envMapIntensity: env }),
      head: new THREE.MeshStandardMaterial({ color: '#9faab7', metalness: 0.58, roughness: 0.38, envMapIntensity: env }),
      steel: new THREE.MeshStandardMaterial({ color: '#b9c3ce', metalness: 0.86, roughness: 0.22, envMapIntensity: env }),
      piston: new THREE.MeshStandardMaterial({ color: '#d3dae2', metalness: 0.82, roughness: 0.26, envMapIntensity: env }),
      ring: new THREE.MeshStandardMaterial({ color: '#6d7684', metalness: 0.86, roughness: 0.3, envMapIntensity: env }),
      rod: new THREE.MeshStandardMaterial({ color: '#aab4c0', metalness: 0.86, roughness: 0.24, envMapIntensity: env }),
      intake: new THREE.MeshStandardMaterial({ color: '#5d7186', metalness: 0.48, roughness: 0.46, envMapIntensity: env }),
      exhaust: new THREE.MeshStandardMaterial({ color: '#7d6155', metalness: 0.52, roughness: 0.48, envMapIntensity: env }),
      plug: new THREE.MeshStandardMaterial({ color: '#c6ced8', metalness: 0.82, roughness: 0.3, envMapIntensity: env }),
    }
    // Per-cylinder clones, so one hot cylinder can be tinted on its own.
    const perCylinder = LAYOUT.map(() => ({
      barrel: shared.barrel.clone(),
      fin: shared.fin.clone(),
      head: shared.head.clone(),
      combust: new THREE.MeshBasicMaterial({
        color: '#ffb057', transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      ghost: new THREE.MeshBasicMaterial({
        color: '#0aa7c2', transparent: true, opacity: 0, wireframe: true, depthWrite: false,
      }),
    }))
    return { shared, perCylinder }
  }, [])
}

type SharedMaterials = ReturnType<typeof useEngineMaterials>['shared']
type CylinderMaterials = ReturnType<typeof useEngineMaterials>['perCylinder'][number]

/* ------------------------------------------------------------ cylinder --- */

const BORE = 0.19
const STROKE = 0.26
const BARREL_LEN = 0.56

function Cylinder({
  slot,
  materials,
  shared,
  state,
}: {
  slot: (typeof LAYOUT)[number]
  materials: CylinderMaterials
  shared: SharedMaterials
  state: React.MutableRefObject<EngineVisualState>
}) {
  const pistonRef = useRef<THREE.Group>(null)
  const rodRef = useRef<THREE.Mesh>(null)
  const combustRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)
  const colour = useMemo(() => new THREE.Color(), [])
  const ghostColour = useMemo(() => new THREE.Color(), [])
  const fault = useMemo(() => new THREE.Color('#e13232'), [])

  const dir = slot.side
  const centre = 0.3 + BARREL_LEN * 0.5
  const fins = useMemo(() => [0, 1, 2, 3, 4, 5, 6], [])

  useFrame((clock) => {
    const s = state.current
    const cyl = s.cylinders[slot.index - 1] ?? NEUTRAL_CYLINDER
    const t = clock.clock.elapsedTime
    // The integrated crank angle, not the wall clock: the assembly turns
    // because the simulation is turning it.
    const crank = s.crank + slot.phase

    // The piston reciprocates along the cylinder axis, the rod follows it.
    const travel = (Math.cos(crank) * 0.5 + 0.5) * STROKE
    if (pistonRef.current) pistonRef.current.position.x = dir * (0.36 + travel)
    if (rodRef.current) {
      rodRef.current.position.x = dir * (0.14 + travel * 0.5)
      rodRef.current.rotation.z = Math.PI / 2 + dir * Math.sin(crank) * 0.16
    }

    const anomalous = s.anomalyIndex === slot.index
    const diag = s.mode === 'DIAGNOSTIC'
    const thermal = s.mode === 'THERMAL'
    const twin = s.mode === 'TWIN'

    // Combustion flash near the top of the stroke, brightness from power. In
    // the diagnostic view a flagged cylinder burns visibly hotter, which is
    // the point being made.
    if (combustRef.current) {
      const stroke = Math.max(0, Math.cos(crank))
      const heat = anomalous && (diag || thermal) ? 1.5 : 1
      materials.combust.opacity = Math.pow(stroke, 7) * (0.26 + 0.5 * s.power) * heat * s.reveal
      combustRef.current.scale.setScalar(0.9 + stroke * 0.3)
    }

    // Head and fin colour: steel in the physical view, the thermal ramp in
    // the thermal view, the fault colour where the twin has flagged one.
    if (thermal) {
      thermalColour(colour, cyl.cht)
      materials.head.color.lerp(colour, 0.12)
      materials.fin.color.lerp(colour, 0.09)
      materials.head.emissive.lerp(colour, 0.12)
      materials.head.emissiveIntensity = 0.4
    } else if (diag) {
      colour.set(anomalous ? '#e13232' : '#8b96a3')
      materials.head.color.lerp(colour, 0.12)
      materials.fin.color.lerp(colour, 0.09)
      materials.head.emissive.lerp(colour, 0.12)
      materials.head.emissiveIntensity = anomalous ? 0.45 + 0.35 * Math.sin(t * 4.4) : 0.04
    } else {
      colour.set('#9faab7')
      materials.head.color.lerp(colour, 0.12)
      colour.set('#7b8794')
      materials.fin.color.lerp(colour, 0.09)
      materials.head.emissiveIntensity *= 0.9
    }

    // The twin overlay: a wireframe shell at the state physics expected,
    // around the solid barrel that is what the sensors actually report. It
    // reddens with the residual, not with the absolute temperature.
    materials.ghost.opacity += ((twin ? 0.55 : 0) - materials.ghost.opacity) * 0.08
    if (twin) {
      const divergence = Math.min(1, Math.abs(cyl.residual) / 18)
      ghostColour.set('#0aa7c2').lerp(fault, divergence)
      materials.ghost.color.lerp(ghostColour, 0.1)
    }

    // A flagged cylinder breathes in the diagnostic view, so the eye finds it
    // before anyone reads a label.
    if (groupRef.current) {
      const pulse = anomalous && diag ? 1 + 0.02 * Math.sin(t * 4.4) : 1
      groupRef.current.scale.setScalar(pulse)
    }
  })

  return (
    <group ref={groupRef}>
      {/* barrel */}
      <mesh
        material={materials.barrel}
        position={[dir * centre, 0, slot.z]}
        rotation={[0, 0, Math.PI / 2]}
        castShadow
      >
        <cylinderGeometry args={[BORE, BORE + 0.01, BARREL_LEN, 22]} />
      </mesh>

      {/* cooling fins - the path an air-cooled engine's CHT depends on */}
      {fins.map((i) => (
        <mesh
          key={i}
          material={materials.fin}
          position={[dir * (0.34 + i * 0.072), 0, slot.z]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[BORE + 0.075, BORE + 0.075, 0.016, 22]} />
        </mesh>
      ))}

      {/* head, rocker cover, plug boss */}
      <mesh material={materials.head} position={[dir * 0.9, 0, slot.z]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[BORE + 0.035, BORE + 0.055, 0.19, 22]} />
      </mesh>
      <mesh material={materials.head} position={[dir * 1.0, 0.11, slot.z]} castShadow>
        <boxGeometry args={[0.16, 0.1, 0.2]} />
      </mesh>
      <mesh material={shared.plug} position={[dir * 1.0, -0.12, slot.z]} rotation={[0, 0, 0]}>
        <cylinderGeometry args={[0.026, 0.026, 0.1, 8]} />
      </mesh>

      {/* combustion chamber flash */}
      <mesh ref={combustRef} material={materials.combust} position={[dir * 0.82, 0, slot.z]}>
        <sphereGeometry args={[BORE * 0.86, 14, 12]} />
      </mesh>

      {/* piston and connecting rod, visible through the cutaway */}
      <group ref={pistonRef} position={[dir * 0.44, 0, slot.z]}>
        <mesh material={shared.piston} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[BORE - 0.014, BORE - 0.014, 0.13, 20]} />
        </mesh>
        {[-0.03, 0.0, 0.03].map((o) => (
          <mesh key={o} material={shared.ring} position={[o, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <torusGeometry args={[BORE - 0.014, 0.006, 6, 20]} />
          </mesh>
        ))}
      </group>

      <mesh
        ref={rodRef}
        material={shared.rod}
        position={[dir * 0.22, 0, slot.z]}
        rotation={[0, 0, Math.PI / 2]}
        castShadow
      >
        <boxGeometry args={[0.05, 0.34, 0.05]} />
      </mesh>

      {/* the expected-state shell */}
      <mesh material={materials.ghost} position={[dir * centre, 0, slot.z]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[BORE + 0.1, BORE + 0.1, BARREL_LEN + 0.26, 14, 1, true]} />
      </mesh>

      {/* intake runner above, exhaust stack below */}
      <mesh material={shared.intake} position={[dir * 0.74, 0.2, slot.z]} rotation={[0, 0, dir * 0.5]}>
        <cylinderGeometry args={[0.042, 0.042, 0.42, 10]} />
      </mesh>
      <mesh material={shared.exhaust} position={[dir * 0.78, -0.24, slot.z]} rotation={[0, 0, dir * -0.42]}>
        <cylinderGeometry args={[0.048, 0.048, 0.46, 10]} />
      </mesh>
    </group>
  )
}

/* --------------------------------------------------------- crank train --- */

function CrankTrain({
  shared,
  state,
}: {
  shared: SharedMaterials
  state: React.MutableRefObject<EngineVisualState>
}) {
  const ref = useRef<THREE.Group>(null)
  useFrame(() => {
    if (ref.current) {
      ref.current.rotation.z = state.current.crank
    }
  })

  return (
    <group ref={ref}>
      <mesh material={shared.steel} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.06, 1.9, 14]} />
      </mesh>
      {LAYOUT.map((slot) => (
        <mesh
          key={slot.index}
          material={shared.steel}
          position={[0, slot.phase === 0 ? 0.09 : -0.09, slot.z]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <cylinderGeometry args={[0.045, 0.045, 0.16, 10]} />
        </mesh>
      ))}
      {[0.3, -0.3].map((z) => (
        <mesh key={z} material={shared.steel} position={[0, -0.08, z]}>
          <boxGeometry args={[0.26, 0.2, 0.06]} />
        </mesh>
      ))}
    </group>
  )
}

/* ------------------------------------------------------------- airflow --- */

/** Cooling air over the fins: the mechanism whose effectiveness the state
 *  estimator is tracking. Drawn only in the airflow view. */
function CoolingAirflow({ state }: { state: React.MutableRefObject<EngineVisualState> }) {
  const COUNT = 420

  const { geometry, material, seeds } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3)
    const seeds = new Float32Array(COUNT * 3)
    for (let i = 0; i < COUNT; i += 1) {
      seeds[i * 3] = Math.random()                      // progress along the flow
      seeds[i * 3 + 1] = (Math.random() - 0.5) * 0.9    // spanwise spread
      seeds[i * 3 + 2] = (Math.random() - 0.5) * 2.1    // fore/aft spread
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: '#1c9fdd', size: 0.034, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true,
    })
    return { geometry: geo, material: mat, seeds }
  }, [])

  useFrame((_, delta) => {
    const s = state.current
    const visible = s.mode === 'AIRFLOW'
    material.opacity += ((visible ? 0.72 : 0) - material.opacity) * 0.08
    if (material.opacity < 0.012) return

    const attribute = geometry.attributes.position as THREE.BufferAttribute
    // Cooling airflow is a simulated quantity, not decoration: it stops when
    // the simulation stops, along with everything else it is derived from.
    const speed = simClock.running ? 0.5 + 0.5 * s.power : 0
    for (let i = 0; i < COUNT; i += 1) {
      let p = seeds[i * 3] + Math.min(0.08, delta) * speed * (0.6 + (i % 7) / 12)
      if (p > 1) p -= 1
      seeds[i * 3] = p
      // Air enters over the top of the cowl, splits across the fins and exits
      // low and aft, which is why the rear cylinders run hotter.
      const y = 0.78 - p * 1.6
      const x = seeds[i * 3 + 1] * (0.9 + p * 1.6)
      const z = seeds[i * 3 + 2] - p * 0.4
      attribute.setXYZ(i, x, y, z)
    }
    attribute.needsUpdate = true
  })

  return <points geometry={geometry} material={material} frustumCulled={false} />
}

/* -------------------------------------------------------------- engine --- */

export function EngineModel({
  state,
  scale = 1,
}: {
  state: React.MutableRefObject<EngineVisualState>
  scale?: number
}) {
  const materials = useEngineMaterials()
  const root = useRef<THREE.Group>(null)

  useFrame((_, delta) => {
    const s = state.current
    if (!root.current) return

    // The mechanical clock for the whole assembly. Geared well down from the
    // real 2,400 rpm - at true speed it strobes at 60 fps and communicates
    // nothing - and held whenever the simulation is held, so the pistons and
    // the telemetry can never disagree about whether the engine is running.
    if (simClock.running) {
      s.crank += Math.min(0.1, delta) * (s.rpm / 2400) * 5.2
    }

    // Running vibration, amplitude from engine speed. Deliberately small:
    // this is an engine on its mounts, not a shaking prop. It stops with the
    // engine.
    const t = performance.now() / 1000
    const amp = simClock.running ? 0.0022 * (s.rpm / 2400) : 0
    root.current.position.y = Math.sin(t * 31) * amp
    root.current.position.x = Math.cos(t * 27) * amp * 0.6
    const reveal = Math.max(0, Math.min(1, s.reveal))
    const target = scale * (0.86 + 0.14 * reveal)
    root.current.scale.setScalar(
      root.current.scale.x + (target - root.current.scale.x) * Math.min(1, delta * 4),
    )
  })

  return (
    <group ref={root} scale={scale}>
      {/* crankcase */}
      <mesh material={materials.shared.case} castShadow receiveShadow>
        <boxGeometry args={[0.56, 0.46, 1.62]} />
      </mesh>
      <mesh material={materials.shared.case} position={[0, 0, 0.94]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.2, 0.26, 0.32, 18]} />
      </mesh>
      {/* propeller flange */}
      <mesh material={materials.shared.steel} position={[0, 0, 1.16]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.17, 0.17, 0.05, 18]} />
      </mesh>
      {/* accessory case aft */}
      <mesh material={materials.shared.case} position={[0, -0.04, -0.95]} castShadow>
        <boxGeometry args={[0.44, 0.4, 0.3]} />
      </mesh>
      {/* sump */}
      <mesh material={materials.shared.barrel} position={[0, -0.3, 0.05]} castShadow>
        <boxGeometry args={[0.42, 0.18, 1.0]} />
      </mesh>

      <CrankTrain shared={materials.shared} state={state} />

      {LAYOUT.map((slot, i) => (
        <Cylinder
          key={slot.index}
          slot={slot}
          materials={materials.perCylinder[i]}
          shared={materials.shared}
          state={state}
        />
      ))}

      <CoolingAirflow state={state} />
    </group>
  )
}

export { LAYOUT as ENGINE_LAYOUT }
