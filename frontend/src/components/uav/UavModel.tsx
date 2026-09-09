/**
 * The airframe.
 *
 * A fictional MALE-class UAV in the configuration the problem statement
 * describes: high-aspect-ratio wing for endurance, pusher propeller at the
 * rear so the nose stays clear for sensors, SATCOM radome above the forward
 * fuselage, EO/IR turret below it. It resembles no real platform and is not
 * presented as one.
 *
 * Everything is procedural - no external model file to download, no texture
 * fetch, nothing that could fail at runtime.
 */

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export interface UavVisualState {
  /** Propeller RPM, drives blade rotation and blur. */
  rpm: number
  /** Bank angle in radians, applied to the airframe. */
  bank: number
  /** Pitch angle in radians. */
  pitch: number
  /** 0 on the ground, 1 airborne - retracts the gear. */
  airborne: number
  /** Highlight the engine bay when the twin flags an anomaly. */
  alert: number
  /**
   * Hold the propeller.
   *
   * Set by the console when the simulation is held; left false by the intro
   * and the showcase, where the aircraft is a subject being inspected rather
   * than a simulation being run.
   */
  frozen?: boolean
  /** 0-1. Dissolves the airframe so the camera can travel through it into the
   *  propulsion bay during the intro. Defaults to fully opaque. */
  opacity?: number
}

function useMaterials() {
  return useMemo(() => {
    const skin = new THREE.MeshStandardMaterial({
      color: '#aab6c4',
      metalness: 0.42,
      roughness: 0.34,
      envMapIntensity: 1.25,
    })
    const skinDark = new THREE.MeshStandardMaterial({
      color: '#6c7784',
      metalness: 0.5,
      roughness: 0.3,
      envMapIntensity: 1.1,
    })
    const composite = new THREE.MeshStandardMaterial({
      color: '#5b6470',
      metalness: 0.24,
      roughness: 0.62,
      envMapIntensity: 0.8,
    })
    const glass = new THREE.MeshStandardMaterial({
      color: '#0d1620',
      metalness: 0.9,
      roughness: 0.14,
    })
    const engine = new THREE.MeshStandardMaterial({
      color: '#2b3038',
      metalness: 0.6,
      roughness: 0.42,
      emissive: new THREE.Color('#e13232'),
      emissiveIntensity: 0,
    })
    const prop = new THREE.MeshStandardMaterial({
      color: '#1a1f26',
      metalness: 0.3,
      roughness: 0.6,
    })
    const disc = new THREE.MeshBasicMaterial({
      color: '#c9d4e0',
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    /* One livery accent. An unpainted airframe on a white floor reads as
       untextured geometry; a single band gives the eye an edge to find. */
    const accent = new THREE.MeshStandardMaterial({
      color: '#0a6ed6',
      metalness: 0.4,
      roughness: 0.35,
      envMapIntensity: 1.0,
    })
    return { skin, skinDark, composite, glass, engine, prop, disc, accent }
  }, [])
}

/** Simple symmetric aerofoil section extruded along the span. */
function useWingGeometry(span: number, rootChord: number, tipChord: number, thickness: number) {
  return useMemo(() => {
    const shape = new THREE.Shape()
    const steps = 14
    // Upper surface, leading edge to trailing edge.
    for (let i = 0; i <= steps; i += 1) {
      const x = i / steps
      const t = thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4)
      if (i === 0) shape.moveTo(x, t)
      else shape.lineTo(x, t)
    }
    // Lower surface back to the leading edge.
    for (let i = steps; i >= 0; i -= 1) {
      const x = i / steps
      const t = thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4)
      shape.lineTo(x, -t)
    }

    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: span,
      bevelEnabled: false,
      steps: 1,
    })
    // Extrude runs along +Z; taper the outboard end toward the tip chord.
    const position = geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < position.count; i += 1) {
      const z = position.getZ(i)
      const u = z / span
      const taper = 1 - (1 - tipChord / rootChord) * u
      position.setX(i, position.getX(i) * rootChord * taper)
      position.setY(i, position.getY(i) * rootChord * taper)
      // Gentle dihedral.
      position.setY(i, position.getY(i) + u * span * 0.045)
    }
    position.needsUpdate = true
    geometry.computeVertexNormals()
    return geometry
  }, [span, rootChord, tipChord, thickness])
}

export function UavModel({
  state,
  scale = 1,
  showGear = true,
}: {
  state: React.MutableRefObject<UavVisualState>
  scale?: number
  showGear?: boolean
}) {
  const materials = useMaterials()
  const propRef = useRef<THREE.Group>(null)
  const discRef = useRef<THREE.Mesh>(null)
  const gearRef = useRef<THREE.Group>(null)
  const bodyRef = useRef<THREE.Group>(null)
  const beaconRef = useRef<THREE.Mesh>(null)
  const lastAlpha = useRef(1)

  const wing = useWingGeometry(4.6, 1.05, 0.52, 0.13)
  const tail = useWingGeometry(1.5, 0.62, 0.36, 0.11)

  useFrame((_, delta) => {
    const s = state.current
    if (propRef.current && !s.frozen) {
      // Visual rate, not the real 2,500 rpm - that would strobe at 60 fps.
      propRef.current.rotation.z += delta * (s.rpm / 2700) * 34
    }
    if (discRef.current) {
      const mat = discRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = 0.03 + 0.1 * Math.min(1, s.rpm / 2400)
    }
    const ease = (rate: number) => 1 - Math.exp(-rate * Math.min(0.25, delta))
    if (gearRef.current) {
      const target = 1 - Math.min(1, Math.max(0, s.airborne))
      gearRef.current.scale.y += (target - gearRef.current.scale.y) * ease(2.4)
      gearRef.current.visible = gearRef.current.scale.y > 0.03
    }
    if (bodyRef.current) {
      bodyRef.current.rotation.z += (-s.bank - bodyRef.current.rotation.z) * ease(3.4)
      bodyRef.current.rotation.x += (s.pitch - bodyRef.current.rotation.x) * ease(3.0)
    }
    // The dissolve. Every surface shares one alpha so the airframe thins out
    // evenly rather than coming apart panel by panel.
    const alpha = s.opacity === undefined ? 1 : Math.max(0, Math.min(1, s.opacity))
    if (alpha !== lastAlpha.current) {
      lastAlpha.current = alpha
      for (const material of Object.values(materials)) {
        const m = material as THREE.Material & { opacity: number }
        m.transparent = alpha < 0.999 || material === materials.disc
        m.opacity = material === materials.disc ? m.opacity : alpha
        m.depthWrite = alpha > 0.5 && material !== materials.disc
      }
      if (bodyRef.current) bodyRef.current.visible = alpha > 0.004
    }

    materials.engine.emissiveIntensity = s.alert * (0.55 + 0.45 * Math.sin(performance.now() / 260))
    if (beaconRef.current) {
      const material = beaconRef.current.material as THREE.MeshStandardMaterial
      material.emissiveIntensity = 0.4 + 2.6 * (0.5 + 0.5 * Math.sin(performance.now() / 420))
    }
  })

  return (
    <group scale={scale}>
      <group ref={bodyRef}>
        {/* ---- fuselage ------------------------------------------------- */}
        <mesh material={materials.skin} castShadow rotation={[Math.PI / 2, 0, 0]}>
          <capsuleGeometry args={[0.2, 1.5, 6, 18]} />
        </mesh>

        {/* Nose radome: the bulged forward section characteristic of the class */}
        <mesh material={materials.skin} position={[0, 0.05, 1.02]} castShadow>
          <sphereGeometry args={[0.235, 20, 16]} />
        </mesh>
        <mesh material={materials.skin} position={[0, 0.02, 0.72]} castShadow>
          <sphereGeometry args={[0.25, 20, 16]} />
        </mesh>

        {/* Tail cone tapering into the engine bay */}
        <mesh material={materials.skinDark} position={[0, 0, -1.05]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.11, 0.19, 0.55, 16]} />
        </mesh>

        {/* Livery band aft of the radome */}
        <mesh material={materials.accent} position={[0, 0.02, 0.6]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.253, 0.253, 0.055, 20]} />
        </mesh>

        {/* SATCOM dome */}
        <mesh material={materials.skin} position={[0, 0.21, 0.45]} castShadow>
          <sphereGeometry args={[0.16, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        </mesh>

        {/* EO/IR turret */}
        <mesh material={materials.skinDark} position={[0, -0.22, 0.78]} castShadow>
          <sphereGeometry args={[0.13, 18, 14]} />
        </mesh>
        <mesh material={materials.glass} position={[0, -0.26, 0.85]}>
          <sphereGeometry args={[0.075, 14, 12]} />
        </mesh>

        {/* ---- wing ----------------------------------------------------- */}
        <group position={[0, 0.08, 0.05]}>
          <mesh
            geometry={wing}
            material={materials.skin}
            rotation={[0, -Math.PI / 2, 0]}
            position={[0, 0, 0]}
            castShadow
          />
          <mesh
            geometry={wing}
            material={materials.skin}
            rotation={[0, Math.PI / 2, 0]}
            position={[0, 0, 0]}
            castShadow
          />
          {/* Wing fuel tank fairings */}
          <mesh material={materials.composite} position={[1.5, 0.02, 0.1]} rotation={[Math.PI / 2, 0, 0]}>
            <capsuleGeometry args={[0.055, 0.34, 4, 10]} />
          </mesh>
          <mesh material={materials.composite} position={[-1.5, 0.02, 0.1]} rotation={[Math.PI / 2, 0, 0]}>
            <capsuleGeometry args={[0.055, 0.34, 4, 10]} />
          </mesh>
          {/* Wingtip caps, which is also where the nav lights sit */}
          <mesh material={materials.accent} position={[2.24, 0.13, 0.05]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.048, 0.048, 0.1, 10]} />
          </mesh>
          <mesh material={materials.accent} position={[-2.24, 0.13, 0.05]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.048, 0.048, 0.1, 10]} />
          </mesh>

          {/* Navigation lights */}
          <mesh position={[2.28, 0.14, 0.05]}>
            <sphereGeometry args={[0.035, 8, 8]} />
            <meshStandardMaterial color="#12b981" emissive="#12b981" emissiveIntensity={2.4} />
          </mesh>
          <mesh position={[-2.28, 0.14, 0.05]}>
            <sphereGeometry args={[0.035, 8, 8]} />
            <meshStandardMaterial color="#e13232" emissive="#e13232" emissiveIntensity={2.4} />
          </mesh>
        </group>

        {/* ---- tail boom and V-tail -------------------------------------- */}
        <mesh material={materials.skinDark} position={[0, 0, -0.95]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.055, 0.075, 1.5, 12]} />
        </mesh>

        <group position={[0, 0.02, -1.62]}>
          <mesh
            geometry={tail}
            material={materials.skin}
            rotation={[Math.PI * 0.22, -Math.PI / 2, 0]}
            castShadow
          />
          <mesh
            geometry={tail}
            material={materials.skin}
            rotation={[-Math.PI * 0.22, Math.PI / 2, 0]}
            castShadow
          />
        </group>

        {/* ---- engine bay and pusher propeller --------------------------- */}
        <mesh material={materials.engine} position={[0, 0, -0.66]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.185, 0.185, 0.42, 16]} />
        </mesh>
        {/* Cooling intakes: an air-cooled engine's CHT depends on this path */}
        <mesh material={materials.glass} position={[0.16, -0.06, -0.6]}>
          <boxGeometry args={[0.05, 0.09, 0.2]} />
        </mesh>
        <mesh material={materials.glass} position={[-0.16, -0.06, -0.6]}>
          <boxGeometry args={[0.05, 0.09, 0.2]} />
        </mesh>

        <group ref={propRef} position={[0, 0, -1.36]}>
          <mesh material={materials.prop}>
            <sphereGeometry args={[0.06, 10, 8]} />
          </mesh>
          {[0, 1, 2].map((i) => (
            <mesh
              key={i}
              material={materials.prop}
              rotation={[0, 0, (i * Math.PI * 2) / 3]}
              position={[
                Math.cos((i * Math.PI * 2) / 3) * 0.3,
                Math.sin((i * Math.PI * 2) / 3) * 0.3,
                0,
              ]}
            >
              <boxGeometry args={[0.55, 0.075, 0.014]} />
            </mesh>
          ))}
        </group>

        <mesh ref={discRef} material={materials.disc} position={[0, 0, -1.37]}>
          <circleGeometry args={[0.62, 28]} />
        </mesh>

        {/* Anti-collision beacon. An emissive marker rather than a real light:
            a point light this close to the airframe washes the whole aircraft
            red at corner scale, and costs a shadow-less draw for nothing. */}
        <mesh ref={beaconRef} position={[0, 0.28, -0.1]}>
          <sphereGeometry args={[0.045, 8, 8]} />
          <meshStandardMaterial color="#e13232" emissive="#e13232" emissiveIntensity={2.2} />
        </mesh>

        {/* ---- landing gear --------------------------------------------- */}
        {showGear && (
          <group ref={gearRef} position={[0, -0.2, 0]}>
            {[
              [0, -0.16, 0.72] as const,
              [0.42, -0.2, -0.18] as const,
              [-0.42, -0.2, -0.18] as const,
            ].map(([x, y, z], i) => (
              <group key={i} position={[x, y, z]}>
                <mesh material={materials.skinDark}>
                  <cylinderGeometry args={[0.018, 0.018, 0.3, 8]} />
                </mesh>
                <mesh material={materials.prop} position={[0, -0.16, 0]} rotation={[0, 0, Math.PI / 2]}>
                  <torusGeometry args={[0.055, 0.024, 8, 14]} />
                </mesh>
              </group>
            ))}
          </group>
        )}
      </group>
    </group>
  )
}
