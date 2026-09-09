/**
 * The engine viewer, embedded in a page.
 *
 * The 3D assembly is bound to the live twin: crank speed comes from measured
 * RPM, the thermal ramp from measured CHT, the wireframe shell from what the
 * physics model expected, and the flagged cylinder from whatever the residual
 * engine actually ranked first. Switching views changes what is drawn, never
 * what is being said.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { Flame, Layers, Rotate3d, Thermometer, Wind } from 'lucide-react'
import { useTwin } from '../../store/useTwin'
import { useIsDark } from '../../store/useSettings'
import { RenderBoundary } from '../ui/Boundary'
import { hasWebGL } from '../../services/capability'
import { EngineModel, emptyEngineState, type EngineViewMode, type EngineVisualState } from './EngineModel'
import { fmt, signed } from '../ui/Primitives'
import type { CylinderHealth } from '../../types'

const MODES: Array<{ id: EngineViewMode; label: string; icon: typeof Layers; hint: string }> = [
  { id: 'PHYSICAL', label: 'PHYSICAL', icon: Layers, hint: 'The assembly as installed' },
  { id: 'THERMAL', label: 'THERMAL', icon: Thermometer, hint: 'Head colour from measured CHT' },
  { id: 'AIRFLOW', label: 'AIRFLOW', icon: Wind, hint: 'Cooling air over the fins' },
  { id: 'DIAGNOSTIC', label: 'DIAGNOSTIC', icon: Flame, hint: 'The cylinder the twin has flagged' },
  { id: 'TWIN', label: 'DIGITAL TWIN', icon: Rotate3d, hint: 'Expected shell against actual state' },
]

const NO_CYLINDERS: CylinderHealth[] = []

/** Pushes the store's numbers into the visual state ref every frame. */
function EngineBinding({
  state,
  cylinders,
  rpm,
  power,
  anomalyIndex,
  mode,
}: {
  state: React.MutableRefObject<EngineVisualState>
  cylinders: CylinderHealth[]
  rpm: number
  power: number
  anomalyIndex: number
  mode: EngineViewMode
}) {
  useFrame(() => {
    const s = state.current
    s.rpm = rpm
    s.power = power
    s.anomalyIndex = anomalyIndex
    s.mode = mode
    s.reveal = 1
    for (let i = 0; i < 4; i += 1) {
      const c = cylinders[i]
      const target = s.cylinders[i]
      if (!target) continue
      if (c) {
        target.cht = c.cht_observed
        target.chtExpected = c.cht_expected
        target.egt = c.egt_observed
        target.residual = c.cht_residual
        target.status = c.status
      }
    }
  })
  return null
}

/** A label pinned to the flagged cylinder in the two diagnostic views. */
function FlagTag({
  index,
  residual,
  visible,
}: {
  index: number
  residual: number
  visible: boolean
}) {
  if (!visible || !index) return null
  const side = index % 2 === 1 ? 1 : -1
  const z = index <= 2 ? 0.62 : -0.62
  return (
    <Html position={[side * 1.15, 0.34, z]} center distanceFactor={3.4} zIndexRange={[8, 0]}>
      <div className="engine3d__tag">
        <span className="engine3d__tag-k">CYL {index}</span>
        <span className="engine3d__tag-v">{signed(residual, 1)} °C</span>
      </div>
    </Html>
  )
}

function Rig({ spin }: { spin: boolean }) {
  const ref = useRef<THREE.Group>(null)
  useFrame((_, delta) => {
    if (spin && ref.current) ref.current.rotation.y += delta * 0.16
  })
  return <group ref={ref} />
}

export function EngineStage({
  height = 340,
  defaultMode = 'PHYSICAL',
  compact = false,
  view,
  chrome = true,
}: {
  height?: number
  defaultMode?: EngineViewMode
  compact?: boolean
  /** Controlled view. Supplied by the narrated demonstration, which drives the
   *  engine through the same four views the operator can pick by hand. */
  view?: EngineViewMode
  /** Mode buttons, read-out and hint. Off inside the story theatre, where the
   *  narration is doing the labelling. */
  chrome?: boolean
}) {
  const telemetry = useTwin((s) => s.telemetry)
  const alerts = useTwin((s) => s.alerts)
  const setCylinder = useTwin((s) => s.setCylinder)
  const dark = useIsDark()
  const [picked, setPicked] = useState<EngineViewMode>(defaultMode)
  const mode = view ?? picked
  const setMode = setPicked
  const [hovered, setHovered] = useState(false)
  const [webgl] = useState(hasWebGL)

  const cylinders = useTwin((s) => s.telemetry?.engine?.cylinders) ?? NO_CYLINDERS
  const rpm = telemetry?.tick?.channels?.rpm ?? 2400
  const power = telemetry?.tick?.power_fraction ?? 0.7
  const top = alerts?.anomalies?.find((a) => !a.abstained && a.cylinder) ?? null
  const anomalyIndex = top?.cylinder ?? 0

  const state = useRef<EngineVisualState>(emptyEngineState())

  /* The twin flags a cylinder; selecting it in the store keeps the charts on
     the page pointed at the same one. */
  useEffect(() => {
    if (anomalyIndex) setCylinder(anomalyIndex)
  }, [anomalyIndex, setCylinder])

  const worst = useMemo(
    () => cylinders.slice().sort((a, b) => Math.abs(b.cht_residual) - Math.abs(a.cht_residual))[0],
    [cylinders],
  )

  const readout = (
    <div className="engine3d__readout">
      <div className="engine3d__ident">
        <span className="engine3d__ident-k">{telemetry?.engine?.engine_id ?? 'AERO-01'}</span>
        <span className="engine3d__ident-v">PISTON PROPULSION · 4 CYL · AIR COOLED</span>
        <span className="engine3d__ident-link">
          <i className="dot dot--live" style={{ background: 'var(--accent)' }} />
          DIGITAL TWIN LINKED
        </span>
      </div>
      <div className="engine3d__metrics">
        <span><b>{Math.round(rpm).toLocaleString()}</b> RPM</span>
        <span><b>{fmt(power * 100, 0)}</b>% PWR</span>
        {worst && (
          <span className={Math.abs(worst.cht_residual) > 6 ? 'is-alert' : ''}>
            <b>{signed(worst.cht_residual, 1)}</b> °C CYL {worst.index}
          </span>
        )}
      </div>
    </div>
  )

  // No WebGL: a schematic rather than an empty box. Same information, no
  // renderer. Also used as the boundary fallback if a live context is lost.
  const schematic = (
      <div className="engine3d engine3d--flat" style={{ height }}>
        <div className="engine3d__flat">
          {[1, 2, 3, 4].map((i) => {
            const c = cylinders.find((x) => x.index === i)
            const heat = Math.max(0, Math.min(1, ((c?.cht_observed ?? 180) - 140) / 110))
            return (
              <div key={i} className={`engine3d__flat-cyl ${anomalyIndex === i ? 'is-flagged' : ''}`}>
                <span className="micro">CYL {i}</span>
                <div className="engine3d__flat-bar">
                  <div style={{ height: `${heat * 100}%` }} />
                </div>
                <span className="mono">{fmt(c?.cht_observed, 0)}°</span>
              </div>
            )
          })}
        </div>
        {readout}
        <div className="engine3d__nowebgl">WEBGL UNAVAILABLE · SCHEMATIC VIEW</div>
      </div>
  )

  if (!webgl) return schematic

  return (
    <RenderBoundary label="engine viewer" fallback={schematic}>
    <div
      className={`engine3d ${compact ? 'engine3d--compact' : ''}`}
      style={{ height }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Canvas
        dpr={[1, 1.6]}
        shadows={false}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        camera={{ position: [2.35, 1.35, 2.8], fov: 34, near: 0.1, far: 60 }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping
          gl.toneMappingExposure = 1.05
        }}
      >
        <Suspense fallback={null}>
          {/* A studio, lit for the theme it is standing in. The light rig is
              the same shape either way - key from above right, sky fill from
              the left, a bounce off the floor - but a white floor under a navy
              console blows out the readouts printed over it, so in the dark
              theme the ground goes dark and the bounce comes down with it. */}
          <hemisphereLight args={dark ? ['#25384f', '#0d1626', 1.15] : ['#e8f2fd', '#c8d4e2', 1.5]} />
          <directionalLight position={[3.4, 4.6, 2.6]} intensity={dark ? 1.75 : 2.1} color={dark ? '#dce8f8' : '#fff6e8'} />
          <directionalLight position={[-3.6, 1.8, -2.4]} intensity={0.85} color={dark ? '#5a86c4' : '#bcd6f5'} />
          <pointLight position={[0, -1.5, 0.6]} intensity={dark ? 1.3 : 2.2} distance={5.5} color={dark ? '#2b4a72' : '#dceaf8'} />

          <EngineModel state={state} scale={1.12} />
          <EngineBinding
            state={state}
            cylinders={cylinders}
            rpm={rpm}
            power={power}
            anomalyIndex={anomalyIndex}
            mode={mode}
          />
          <FlagTag
            index={anomalyIndex}
            residual={cylinders.find((c) => c.index === anomalyIndex)?.cht_residual ?? 0}
            visible={mode === 'DIAGNOSTIC' || mode === 'TWIN'}
          />
          <Rig spin={!hovered} />

          {/* A ground plane so the assembly is not floating. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.72, 0]}>
            <circleGeometry args={[3.4, 48]} />
            <meshBasicMaterial color={dark ? '#0f1a2c' : '#eef4fb'} transparent opacity={0.9} />
          </mesh>
          <gridHelper
            args={[7, 28, dark ? '#2b405e' : '#c3d6ea', dark ? '#1d2c44' : '#dfe9f4']}
            position={[0, -0.715, 0]}
          />

          <OrbitControls
            enablePan={false}
            enableDamping
            dampingFactor={0.08}
            minDistance={2.2}
            maxDistance={7}
            minPolarAngle={0.35}
            maxPolarAngle={Math.PI / 1.9}
            autoRotate={!hovered}
            autoRotateSpeed={0.55}
          />
        </Suspense>
      </Canvas>

      {chrome && <div className="engine3d__modes">
        {MODES.map((m) => {
          const Icon = m.icon
          return (
            <button
              key={m.id}
              className={`engine3d__mode ${mode === m.id ? 'is-active' : ''}`}
              onClick={() => setMode(m.id)}
              title={m.hint}
            >
              <Icon size={12} strokeWidth={1.8} />
              {m.label}
            </button>
          )
        })}
      </div>}

      {chrome && readout}

      {chrome && <div className="engine3d__hint">DRAG TO ORBIT · SCROLL TO ZOOM</div>}
    </div>
    </RenderBoundary>
  )
}
