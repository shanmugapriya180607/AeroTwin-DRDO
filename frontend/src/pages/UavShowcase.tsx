/**
 * UAV showcase.
 *
 * The step between the film and the console: the aircraft as an object you can
 * pick up. Orbit it, select a component, and the camera flies there. Selecting
 * the engine keeps flying - into the bay, until the assembly is the subject and
 * the four engine views are available on it.
 *
 * Every number on this page is the live twin's, not a caption: the same store
 * the console reads, so the RPM here and the RPM on the dashboard cannot
 * disagree.
 */

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Canvas } from '@react-three/fiber'
import { AnimatePresence, motion } from 'framer-motion'
import * as THREE from 'three'
import { ArrowRight, RotateCcw, SkipForward } from 'lucide-react'
import { useTwin } from '../store/useTwin'
import { hasWebGL } from '../services/capability'
import { RenderBoundary } from '../components/ui/Boundary'
import { Wordmark } from '../components/brand/Wordmark'
import { ShowcaseScene, HOTSPOTS, type Hotspot } from '../components/uav/ShowcaseStage'
import type { EngineViewMode } from '../components/engine3d/EngineModel'
import type { CylinderHealth } from '../types'

const EASE = [0.22, 1, 0.36, 1] as const

const ENGINE_VIEWS: Array<{ id: EngineViewMode; label: string }> = [
  { id: 'PHYSICAL', label: 'PHYSICAL' },
  { id: 'THERMAL', label: 'THERMAL' },
  { id: 'AIRFLOW', label: 'AIRFLOW' },
  { id: 'TWIN', label: 'TWIN' },
]

const NO_CYLINDERS: CylinderHealth[] = []

/**
 * What each component is, in the fewest words that are still true.
 *
 * Nothing here is a specification. The console does not know this airframe's
 * dimensions, endurance or payload and must not appear to - so every line is
 * either a fact the twin actually models or a statement about what is
 * measured. The channel list is the real one: the same keys the telemetry
 * screen streams.
 */
const DETAIL: Record<Hotspot, { title: string; lines: string[] }> = {
  ENGINE: {
    title: 'Engine',
    lines: [
      'Four-cylinder, horizontally opposed, air cooled.',
      'The subject of the digital twin.',
      'Modelled per cylinder, not as one unit.',
    ],
  },
  PROPULSION: {
    title: 'Propulsion',
    lines: [
      'Propeller driven directly by the piston engine.',
      'Shaft speed is a monitored channel.',
    ],
  },
  SENSOR: {
    title: 'Sensors',
    lines: [
      'EGT x4 · CHT x4',
      'RPM · manifold pressure',
      'Oil pressure · oil temperature',
      'Fuel flow',
    ],
  },
  WING: {
    title: 'Flight system',
    lines: [
      'Altitude, airspeed and outside air temperature.',
      'The conditions the twin normalises against.',
    ],
  },
  FUEL: {
    title: 'Telemetry',
    lines: [
      'Live engine and flight-condition data.',
      'One frame a second, into the twin.',
    ],
  },
}

/**
 * The showcase without a GPU.
 *
 * The aircraft as a drawing rather than as a render - the same planform, the
 * same component callouts, on the same white ground. Every number on the page
 * is outside this box and keeps updating, so a machine with no WebGL still
 * gets the aircraft and the telemetry rather than an empty frame.
 */
function ShowcaseFallback() {
  return (
    <div className="showcase__nogl">
      <svg viewBox="0 0 420 260" className="showcase__nogl-art" aria-hidden>
        <g stroke="var(--accent)" fill="none" strokeWidth="1.1" strokeLinejoin="round">
          {/* wing */}
          <path d="M30 132 L170 122 L250 122 L390 132 L250 142 L170 142 Z" />
          {/* fuselage */}
          <path d="M186 96 q24 -14 48 0 l26 34 l-26 34 q-24 14 -48 0 l-26 -34 Z" />
          {/* boom and v-tail */}
          <path d="M210 164 L210 214 M210 214 L182 236 M210 214 L238 236" />
          {/* propeller disc */}
          <ellipse cx="210" cy="178" rx="30" ry="7" opacity="0.5" />
        </g>
        <g fill="var(--accent-2)">
          {[[210, 96], [140, 128], [280, 128], [210, 164], [210, 214]].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="3.4" />
          ))}
        </g>
      </svg>
      <span className="showcase__nogl-note">WEBGL UNAVAILABLE · SCHEMATIC VIEW</span>
    </div>
  )
}

export default function UavShowcase() {
  const navigate = useNavigate()
  const start = useTwin((s) => s.start)
  const telemetry = useTwin((s) => s.telemetry)
  const mission = useTwin((s) => s.mission)
  const alerts = useTwin((s) => s.alerts)
  const mode = useTwin((s) => s.mode)

  const [selected, setSelected] = useState<Hotspot | null>(null)
  const [hovered, setHovered] = useState<Hotspot | null>(null)
  const [engineView, setEngineView] = useState<EngineViewMode>('PHYSICAL')
  const [leaving, setLeaving] = useState(false)

  const webgl = useMemo(hasWebGL, [])

  useEffect(() => {
    start()
  }, [start])

  const cylinders = useTwin((s) => s.telemetry?.engine?.cylinders) ?? NO_CYLINDERS
  const rpm = telemetry?.tick?.channels?.rpm ?? mission?.rpm ?? 2326
  const power = telemetry?.tick?.power_fraction ?? 0.72
  const flagged = alerts?.anomalies?.find((a) => !a.abstained && a.cylinder) ?? null
  const anomalyIndex = flagged?.cylinder ?? 0
  const sync = telemetry?.engine?.sync_pct ?? 99.3

  const leaveTo = (to: string) => {
    setLeaving(true)
    window.setTimeout(() => navigate(to), 620)
  }
  const enterDashboard = () => leaveTo('/dashboard')

  const readouts: Array<[string, string, string?]> = [
    ['ALT', (mission?.altitude_ft ?? 14000).toLocaleString(), 'FT'],
    ['IAS', String(Math.round(mission?.ias_kt ?? 86)), 'KT'],
    ['RPM', Math.round(rpm).toLocaleString()],
    ['TWIN', sync.toFixed(1), '%'],
  ]

  return (
    <motion.div
      className="showcase"
      initial={{ opacity: 0 }}
      animate={{
        opacity: leaving ? 0 : 1,
        scale: leaving ? 1.04 : 1,
        filter: leaving ? 'blur(8px)' : 'blur(0px)',
      }}
      transition={{ duration: leaving ? 0.62 : 0.7, ease: EASE }}
    >
      {/* ---- the stage --------------------------------------------------- */}
      <div className="showcase__stage" id="uav-showcase-canvas">
        {webgl ? (
          <RenderBoundary
            label="uav showcase"
            fallback={<ShowcaseFallback />}
          >
            <Canvas
              dpr={[1, 1.75]}
              shadows
              gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
              camera={{ position: [4.4, 2.2, 5.6], fov: 32, near: 0.1, far: 90 }}
              onCreated={({ gl }) => {
                gl.toneMapping = THREE.ACESFilmicToneMapping
                gl.toneMappingExposure = 1.02
              }}
            >
              <Suspense fallback={null}>
                <ShowcaseScene
                  selected={selected}
                  hovered={hovered}
                  engineView={engineView}
                  cylinders={cylinders}
                  rpm={rpm}
                  power={power}
                  anomalyIndex={anomalyIndex}
                  onHover={setHovered}
                  onSelect={(id) => setSelected((prev) => (prev === id ? null : id))}
                />
              </Suspense>
            </Canvas>
          </RenderBoundary>
        ) : (
          <ShowcaseFallback />
        )}
      </div>

      {/* ---- chrome ------------------------------------------------------ */}
      <header className="showcase__top">
        <Wordmark size={15} />
        <span className="showcase__spacer" />
        <span className="showcase__ident">
          <b>UAV-01</b>
          <i />
          ISR LOITER
          <i />
          AERO-01
        </span>
        {mode === 'DEMO' && <span className="showcase__src">DEMO TELEMETRY</span>}
        {/* The last step of first entry still has a way out of it. */}
        <button className="showcase__skip" onClick={enterDashboard}>
          Skip <SkipForward size={13} strokeWidth={2} />
        </button>
      </header>

      {/* component rail */}
      <nav className="showcase__parts" aria-label="Components">
        {HOTSPOTS.map((spot) => (
          <button
            key={spot.id}
            className={`showcase__part ${selected === spot.id ? 'is-active' : ''}`}
            onClick={() => setSelected((prev) => (prev === spot.id ? null : spot.id))}
            onPointerEnter={() => setHovered(spot.id)}
            onPointerLeave={() => setHovered(null)}
          >
            {spot.id}
          </button>
        ))}
        <AnimatePresence>
          {selected && (
            <motion.button
              className="showcase__reset"
              onClick={() => setSelected(null)}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.3, ease: EASE }}
              title="Back to the whole aircraft"
            >
              <RotateCcw size={12} strokeWidth={2} />
            </motion.button>
          )}
        </AnimatePresence>
      </nav>

      {/* engine view modes, only while the engine is the subject */}
      <AnimatePresence>
        {selected === 'ENGINE' && (
          <motion.div
            className="showcase__modes"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 14 }}
            transition={{ duration: 0.42, ease: EASE }}
          >
            {ENGINE_VIEWS.map((view) => (
              <button
                key={view.id}
                className={`showcase__mode ${engineView === view.id ? 'is-active' : ''}`}
                onClick={() => setEngineView(view.id)}
              >
                {view.label}
              </button>
            ))}
            {engineView === 'TWIN' && (
              <span className="showcase__sync">SYNC {sync.toFixed(1)}%</span>
            )}
            {anomalyIndex > 0 && engineView === 'THERMAL' && (
              <span className="showcase__flag">CYL {anomalyIndex}</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* what the selected component is */}
      <AnimatePresence>
        {selected && (
          <motion.aside
            className="showcase__detail"
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <h2 className="showcase__detail-title">{DETAIL[selected].title}</h2>
            <ul className="showcase__detail-list">
              {DETAIL[selected].lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {selected === 'ENGINE' && anomalyIndex > 0 && (
              <span className="showcase__detail-flag">CYL {anomalyIndex} DEVIATING</span>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* live readout */}
      <div className="showcase__data">
        {readouts.map(([k, v, u]) => (
          <div key={k} className="showcase__stat">
            <span className="showcase__stat-k">{k}</span>
            <span className="showcase__stat-v">
              {v}
              {u && <small>{u}</small>}
            </span>
          </div>
        ))}
      </div>

      <button className="showcase__enter" onClick={enterDashboard}>
        CONTINUE TO AEROTWIN
        <ArrowRight size={15} strokeWidth={2} />
      </button>

      <div className="showcase__hint">
        {selected === 'ENGINE'
          ? 'FOUR CYLINDER · AIR COOLED'
          : selected
            ? HOTSPOTS.find((s) => s.id === selected)?.id
            : 'DRAG TO ORBIT · SCROLL TO ZOOM'}
      </div>
    </motion.div>
  )
}
