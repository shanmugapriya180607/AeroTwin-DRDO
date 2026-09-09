/**
 * The sector environment.
 *
 * A fictional training area: terrain, a ridge line, an airbase with a runway,
 * layered cloud decks and distance haze. No real installation is depicted and
 * positions are sector-grid, never geographic.
 *
 * Performance rules that shaped this file: one terrain mesh built once, cloud
 * decks as instanced sprites rather than volumetrics, exactly one shadow-
 * casting light, and no per-frame allocation anywhere.
 */

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { ALT_EXAGGERATION, FT_TO_KM, SECTOR, TERRAIN_MAX, terrainHeight } from './terrain'

/** The one sun. Sky dome, key light and every stage read this, so the aircraft
 *  is never lit from a different place than the terrain under it. */
export const SUN_DIR = new THREE.Vector3(0.62, 0.44, 0.65).normalize()
export const SUN_POS: [number, number, number] = [320, 226, 336]

/* ------------------------------------------------------------- terrain -- */

export function Terrain() {
  const geometry = useMemo(() => {
    const segments = 250
    const geo = new THREE.PlaneGeometry(SECTOR.w * 3.2, SECTOR.h * 3.2, segments, segments)
    geo.rotateX(-Math.PI / 2)
    const position = geo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(position.count * 3)

    // A little more separation between the bands than a pure greyscale: the
    // basin reads as ground, the ridge as rock, the tops as exposed stone.
    const low = new THREE.Color('#6f8f52')     // basin scrub
    const mid = new THREE.Color('#93944f')     // dry grassland
    const high = new THREE.Color('#9d9078')    // exposed rock
    const snow = new THREE.Color('#f4f7fa')    // ridge tops
    const scratch = new THREE.Color()

    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i) + SECTOR.w * 0.5
      const z = position.getZ(i) + SECTOR.h * 0.5
      const h = terrainHeight(x, z)
      position.setY(i, h)

      // Height decides the band; a cheap hash breaks the band into patches so
      // the ground reads as vegetation and scree rather than as a gradient.
      const patch =
        Math.sin(x * 0.61 + z * 0.37) * 0.4 +
        Math.sin(x * 0.19 - z * 0.23) * 0.35 +
        Math.sin(x * 1.7 - z * 1.3) * 0.25
      const t = Math.max(0, Math.min(1, (h + 1.2) / (TERRAIN_MAX + 1.2) + patch * 0.055))
      if (t < 0.34) scratch.copy(low).lerp(mid, t / 0.34)
      else if (t < 0.72) scratch.copy(mid).lerp(high, (t - 0.34) / 0.38)
      else scratch.copy(high).lerp(snow, (t - 0.72) / 0.28)
      scratch.multiplyScalar(0.94 + patch * 0.06)

      colors[i * 3] = scratch.r
      colors[i * 3 + 1] = scratch.g
      colors[i * 3 + 2] = scratch.b
    }
    position.needsUpdate = true
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geo.computeVertexNormals()
    return geo
  }, [])

  return (
    <mesh geometry={geometry} position={[SECTOR.w * 0.5, 0, SECTOR.h * 0.5]} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.97} metalness={0} />
    </mesh>
  )
}

/* --------------------------------------------------------------- water -- */

/**
 * What lies beyond the mapped sector.
 *
 * Unlit on purpose: a metallic plane at a grazing angle reflects nothing and
 * comes back as a black band across the horizon, which is exactly the artefact
 * this used to produce. A flat haze colour reads as distance instead.
 */
export function SectorFloor() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[SECTOR.w * 0.5, -4.2, SECTOR.h * 0.5]}>
      <planeGeometry args={[SECTOR.w * 9, SECTOR.h * 9]} />
      <meshBasicMaterial color="#d3e2f2" fog />
    </mesh>
  )
}

/* ------------------------------------------------------------- airbase -- */

export function Airbase({ position = [18, 22] as [number, number] }) {
  const [x, z] = position
  const y = terrainHeight(x, z)

  return (
    <group position={[x, y + 0.02, z]}>
      {/* Runway, aligned with the departure leg */}
      <group rotation={[0, Math.PI * 0.28, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[1.5, 14]} />
          <meshStandardMaterial color="#161c24" roughness={0.92} />
        </mesh>
        {/* Centreline */}
        {Array.from({ length: 14 }, (_, i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, -6.5 + i]}>
            <planeGeometry args={[0.09, 0.45]} />
            <meshBasicMaterial color="#4a5765" />
          </mesh>
        ))}
        {/* Threshold lighting */}
        {[-7, 7].map((tz) => (
          <group key={tz}>
            {[-0.62, 0.62].map((tx) => (
              <mesh key={tx} position={[tx, 0.05, tz]}>
                <sphereGeometry args={[0.055, 6, 6]} />
                <meshStandardMaterial color="#0aa7c2" emissive="#0aa7c2" emissiveIntensity={2.6} />
              </mesh>
            ))}
          </group>
        ))}
      </group>

      {/* Apron and hangars */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[2.4, 0.01, 1.2]}>
        <planeGeometry args={[3.2, 2.6]} />
        <meshStandardMaterial color="#12181f" roughness={0.9} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} position={[1.6 + i * 0.95, 0.28, 1.9]} castShadow>
          <boxGeometry args={[0.8, 0.56, 1.1]} />
          <meshStandardMaterial color="#232c36" roughness={0.8} metalness={0.15} />
        </mesh>
      ))}

      {/* Control tower */}
      <group position={[3.4, 0, -0.6]}>
        <mesh position={[0, 0.55, 0]} castShadow>
          <cylinderGeometry args={[0.16, 0.22, 1.1, 10]} />
          <meshStandardMaterial color="#2a333d" roughness={0.75} />
        </mesh>
        <mesh position={[0, 1.2, 0]} castShadow>
          <cylinderGeometry args={[0.3, 0.26, 0.32, 10]} />
          <meshStandardMaterial color="#0d1620" metalness={0.85} roughness={0.15} />
        </mesh>
        <pointLight position={[0, 1.5, 0]} color="#0aa7c2" intensity={2.2} distance={9} />
      </group>
    </group>
  )
}

/* ---------------------------------------------------------- waypoints --- */

export function WaypointMarkers({
  waypoints,
  activeId,
}: {
  waypoints: Array<{ id: string; label: string; x: number; y: number; kind: string }>
  activeId?: string
}) {
  const ringRef = useRef<THREE.Group>(null)

  useFrame((clock) => {
    if (ringRef.current) {
      ringRef.current.children.forEach((child, i) => {
        child.rotation.y = clock.clock.elapsedTime * 0.4 + i
      })
    }
  })

  return (
    <group ref={ringRef}>
      {waypoints.map((wp) => {
        const y = terrainHeight(wp.x, wp.y)
        const isIsr = wp.kind === 'ISR'
        const isBase = wp.kind === 'BASE'
        const color = isIsr ? '#7739e0' : isBase ? '#12b981' : '#0aa7c2'
        const height = isIsr ? 18 : 12
        const active = activeId === wp.id
        return (
          <group key={wp.id} position={[wp.x, y, wp.y]}>
            {/* Vertical beam so the marker reads from cruise altitude */}
            <mesh position={[0, height / 2, 0]}>
              <cylinderGeometry args={[0.06, 0.06, height, 6, 1, true]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={active ? 0.34 : 0.15}
                side={THREE.DoubleSide}
                depthWrite={false}
              />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]}>
              <ringGeometry args={[isIsr ? 1.1 : 0.7, isIsr ? 1.5 : 0.95, 24]} />
              <meshBasicMaterial color={color} transparent opacity={active ? 0.9 : 0.45} side={THREE.DoubleSide} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/* ------------------------------------------------------------ ISR zone -- */

export function IsrZone({ x, y, radius }: { x: number; y: number; radius: number }) {
  const ref = useRef<THREE.Mesh>(null)
  useFrame((clock) => {
    if (ref.current) {
      const m = ref.current.material as THREE.MeshBasicMaterial
      m.opacity = 0.06 + 0.035 * Math.sin(clock.clock.elapsedTime * 1.1)
    }
  })
  const groundY = terrainHeight(x, y)
  return (
    <group position={[x, groundY + 0.08, y]}>
      <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[radius, 56]} />
        <meshBasicMaterial color="#7739e0" transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[radius - 0.35, radius, 64]} />
        <meshBasicMaterial color="#7739e0" transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/* -------------------------------------------------------- flight path --- */

export function FlightPath({
  points,
  altitudeFt = 14000,
}: {
  points: Array<{ x: number; y: number }>
  altitudeFt?: number
}) {
  const geometry = useMemo(() => {
    if (points.length < 2) return null
    const vectors = points.map(
      (p) => new THREE.Vector3(p.x, altitudeFt * FT_TO_KM * ALT_EXAGGERATION, p.y),
    )
    const curve = new THREE.CatmullRomCurve3(vectors, false, 'catmullrom', 0.15)
    return new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.max(64, points.length * 4)))
  }, [points, altitudeFt])

  if (!geometry) return null
  return (
    <primitive
      object={
        new THREE.Line(
          geometry,
          new THREE.LineDashedMaterial({
            color: '#0aa7c2',
            transparent: true,
            opacity: 0.4,
            dashSize: 1.6,
            gapSize: 1.1,
          }),
        )
      }
      onUpdate={(self: THREE.Line) => self.computeLineDistances()}
    />
  )
}

/** The vertical curtain between the planned track and the ground. */
export function TrackCurtain({ points, altitudeFt = 14000 }: { points: Array<{ x: number; y: number }>; altitudeFt?: number }) {
  const geometry = useMemo(() => {
    if (points.length < 2) return null
    const top = altitudeFt * FT_TO_KM * ALT_EXAGGERATION
    const vertices: number[] = []
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      const ay = terrainHeight(a.x, a.y)
      const by = terrainHeight(b.x, b.y)
      vertices.push(a.x, ay, a.y, b.x, by, b.y, a.x, top, a.y)
      vertices.push(b.x, by, b.y, b.x, top, b.y, a.x, top, a.y)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geo.computeVertexNormals()
    return geo
  }, [points, altitudeFt])

  if (!geometry) return null
  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial color="#0aa7c2" transparent opacity={0.045} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

/* -------------------------------------------------------------- clouds -- */

export function CloudDeck({
  count = 34,
  altitudeFt = 9000,
  spread = 180,
  opacity = 0.16,
  size = 22,
  centre,
}: {
  count?: number
  altitudeFt?: number
  spread?: number
  opacity?: number
  /** Mean sprite width in world units. Altitude is exaggerated 4x, so a deck
   *  sized for the sector grid reads as a smear rather than as cloud. */
  size?: number
  centre?: [number, number]
}) {
  const ref = useRef<THREE.InstancedMesh>(null)

  /* A cumulus, not a gaussian blob: a handful of overlapping puffs with a
     flatter, shaded base and a bright crown, which is what makes a billboard
     cloud read as cloud from inside the deck. */
  const texture = useMemo(() => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!

    const puff = (cx: number, cy: number, r: number, top: number, alpha: number) => {
      const g = ctx.createRadialGradient(cx, cy - r * 0.22, r * 0.06, cx, cy, r)
      g.addColorStop(0, `rgba(255,255,255,${alpha})`)
      g.addColorStop(0.42, `rgba(${top},${top + 2},255,${alpha * 0.62})`)
      g.addColorStop(0.74, `rgba(206,220,238,${alpha * 0.2})`)
      g.addColorStop(1, 'rgba(198,214,234,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fill()
    }

    // Crown first, then the shoulders, then the shaded base.
    puff(size * 0.5, size * 0.40, size * 0.24, 252, 0.95)
    puff(size * 0.36, size * 0.50, size * 0.20, 250, 0.85)
    puff(size * 0.64, size * 0.49, size * 0.21, 250, 0.86)
    puff(size * 0.26, size * 0.60, size * 0.15, 242, 0.7)
    puff(size * 0.74, size * 0.59, size * 0.16, 242, 0.7)
    puff(size * 0.5, size * 0.60, size * 0.25, 236, 0.72)
    puff(size * 0.44, size * 0.66, size * 0.17, 228, 0.55)
    puff(size * 0.58, size * 0.67, size * 0.16, 228, 0.55)

    const tex = new THREE.CanvasTexture(canvas)
    tex.needsUpdate = true
    return tex
  }, [])

  const transforms = useMemo(() => {
    const list: Array<{ p: THREE.Vector3; s: number; drift: number }> = []
    const cx = centre ? centre[0] : SECTOR.w * 0.5
    const cz = centre ? centre[1] : SECTOR.h * 0.5
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + Math.random()
      const radius = spread * (0.1 + Math.random() * Math.random() * 1.05)
      list.push({
        p: new THREE.Vector3(
          cx + Math.cos(angle) * radius,
          altitudeFt * FT_TO_KM * ALT_EXAGGERATION + (Math.random() - 0.5) * size * 0.5,
          cz + Math.sin(angle) * radius,
        ),
        s: size * (0.5 + Math.random() * 1.1),
        drift: 0.4 + Math.random() * 0.9,
      })
    }
    return list
  }, [count, altitudeFt, spread, size, centre])

  const dummy = useMemo(() => new THREE.Object3D(), [])

  useFrame((clock) => {
    const mesh = ref.current
    if (!mesh) return
    const t = clock.clock.elapsedTime
    for (let i = 0; i < transforms.length; i += 1) {
      const item = transforms[i]
      dummy.position.set(
        item.p.x + Math.sin(t * 0.02 * item.drift) * 3,
        item.p.y,
        item.p.z + t * 0.05 * item.drift,
      )
      dummy.scale.setScalar(item.s)
      dummy.quaternion.copy(clock.camera.quaternion)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </instancedMesh>
  )
}

/* --------------------------------------------------------------- sky ---- */

/**
 * Daylight sky.
 *
 * A physically-motivated gradient rather than a photograph: Rayleigh-ish blue
 * overhead falling to a pale, humid horizon, a warm glow around the sun, and a
 * ground bounce below the horizon line so the dome never reads as a hard edge
 * when the camera looks down from altitude.
 */
export function SkyDome({ sun = SUN_DIR }: { sun?: THREE.Vector3 } = {}) {
  const geometry = useMemo(() => new THREE.SphereGeometry(620, 32, 24), [])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          /* 0 = open sky, 1 = the white inspection studio the camera ends up
             inside once it has travelled into the propulsion bay. */
          uFade: { value: 0 },
          studio: { value: new THREE.Color('#f4f9ff') },
          zenith: { value: new THREE.Color('#3f83d6') },
          sky: { value: new THREE.Color('#8fbdec') },
          haze: { value: new THREE.Color('#dfeaf6') },
          ground: { value: new THREE.Color('#c3d0da') },
          sunColor: { value: new THREE.Color('#fff4de') },
          sunDir: { value: sun.clone().normalize() },
        },
        vertexShader: `
          varying vec3 vWorld;
          void main() {
            vWorld = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uFade;
          uniform vec3 studio;
          uniform vec3 zenith;
          uniform vec3 sky;
          uniform vec3 haze;
          uniform vec3 ground;
          uniform vec3 sunColor;
          uniform vec3 sunDir;
          varying vec3 vWorld;

          void main() {
            float h = vWorld.y;

            // Above the horizon: haze -> sky -> zenith.
            vec3 up = mix(haze, sky, smoothstep(0.0, 0.22, h));
            up = mix(up, zenith, smoothstep(0.18, 0.72, h));

            // Below it: the ground bounce, so a downward look is not a wall.
            vec3 color = mix(ground, up, smoothstep(-0.06, 0.02, h));

            // Sun glow, and a soft disc inside it.
            float mu = max(0.0, dot(normalize(vWorld), normalize(sunDir)));
            color += sunColor * pow(mu, 8.0) * 0.30;
            color += sunColor * pow(mu, 220.0) * 0.85;
            color += sunColor * pow(mu, 2.0) * 0.05;

            // Horizon brightening, strongest toward the sun azimuth.
            float band = exp(-pow(h * 16.0, 2.0));
            color = mix(color, haze, band * 0.42);
            color = mix(color, studio, uFade);

            gl_FragColor = vec4(color, 1.0);
          }
        `,
      }),
    [sun],
  )

  return (
    <mesh
      name="sky-dome"
      geometry={geometry}
      material={material}
      renderOrder={-1}
      frustumCulled={false}
    />
  )
}

/* ------------------------------------------------------------ lighting -- */

export function SectorLighting({ shadows = true }: { shadows?: boolean }) {
  return (
    <>
      <hemisphereLight args={['#bcd9f5', '#8b8f7e', 1.05]} />
      <directionalLight
        position={SUN_POS}
        intensity={2.35}
        color="#fff2dc"
        castShadow={shadows}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={1}
        shadow-camera-far={340}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
      />
      {/* Sky fill from the opposite quarter - what keeps shadowed surfaces
          blue rather than black under a hard sun. */}
      <directionalLight position={[-190, 90, -150]} intensity={0.5} color="#a9c9ee" />
      <ambientLight intensity={0.38} />
    </>
  )
}

export { terrainHeight, SECTOR }
