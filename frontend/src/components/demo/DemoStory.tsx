/**
 * The narrated demonstration.
 *
 * Ninety seconds that walk the whole chain: link, telemetry, twin sync, a
 * healthy engine, the first deviation, the residual growing, cylinder 3
 * separating from its physics expectation, the estimator, the detector, the
 * explanation, the advisory.
 *
 * It runs full screen, over the aircraft. The same never-unmounted 3D stage
 * that sits in the corner of the console expands to fill the viewport, the
 * camera moves with the narration, and the engine assembly rises into frame
 * once the engine becomes the subject - so the story is told against the
 * machine it is about rather than beside it.
 *
 * The narration is scripted; every number it shows is read live out of the
 * store at that moment, so the story cannot say something the system is not
 * actually reporting. It drives the backend's scripted sortie where the
 * backend is reachable, and narrates the local demo feed where it is not -
 * labelled either way.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Pause, Play, SkipForward, X } from 'lucide-react'
import { useTwin } from '../../store/useTwin'
import { simulation, useSimRunning } from '../../simulation'
import { EngineStage } from '../engine3d/EngineStage'
import type { EngineViewMode } from '../engine3d/EngineModel'
import { Wordmark } from '../brand/Wordmark'
import { fmt, signed } from '../ui/Primitives'

const EASE = [0.22, 1, 0.36, 1] as const

interface Beat {
  /** Which pipeline stage is lit while this beat runs. */
  stage: string
  title: string
  detail: string
  seconds: number
  route?: string
  /** Camera framing on the aircraft while this beat runs. */
  camera?: string
  /** Engine view, or null to keep the assembly out of frame. */
  engine?: EngineViewMode | null
  /** Live evidence, read from the store when the beat is drawn. */
  read?: (s: ReturnType<typeof useTwin.getState>) => string | null
}

const BEATS: Beat[] = [
  {
    stage: 'LINK', title: 'UAV DETECTED',
    detail: 'AERO-01 on the sector datalink.',
    seconds: 5, route: '/dashboard', camera: 'CINEMATIC',
    read: (s) => (s.telemetry?.datalink?.connected === false ? 'LINK LOST' : 'LINK NOMINAL'),
  },
  {
    stage: 'OBSERVE', title: 'TELEMETRY CONNECTED',
    detail: 'Sixteen channels at 1 Hz. Two are simulated and tagged.',
    seconds: 6, camera: 'SIDE',
    read: (s) => {
      const p = s.telemetry?.provenance
      if (!p) return null
      const measured = p.real ? `${p.real} REAL` : `${p.demo ?? 0} DEMO`
      return `${measured} · ${p.simulated} SIMULATED`
    },
  },
  {
    stage: 'MODEL', title: 'DIGITAL TWIN SYNCHRONISED',
    detail: 'The physics model runs on the same inputs as the engine.',
    seconds: 7, route: '/twin', camera: 'CINEMATIC',
    read: (s) => {
      const sync = s.telemetry?.engine?.sync_pct
      return sync ? `TWIN SYNC ${sync.toFixed(1)}%` : null
    },
  },
  {
    stage: 'COMPARE', title: 'ENGINE NOMINAL',
    detail: 'All four cylinders sit on their physics expectation.',
    seconds: 7, camera: 'CINEMATIC', engine: 'PHYSICAL',
    read: (s) => {
      const h = s.telemetry?.engine?.health_index
      return h ? `HEALTH ${h.toFixed(1)}` : null
    },
  },
  {
    stage: 'COMPARE', title: 'DEVIATION BEGINS',
    detail: 'One cylinder starts running above what physics predicts.',
    seconds: 8, camera: 'SIDE', engine: 'THERMAL',
    read: (s) => {
      const a = s.residuals?.asymmetry?.cht
      return a !== undefined ? `CHT SPREAD ${a.toFixed(1)} °C` : null
    },
  },
  {
    stage: 'DETECT', title: 'RESIDUAL RISING',
    detail: 'Every absolute reading is still inside limits. The difference is not.',
    seconds: 8, camera: 'CINEMATIC', engine: 'TWIN',
    read: (s) => {
      const cyl = s.telemetry?.engine?.cylinders ?? []
      const worst = cyl.slice().sort((a, b) => Math.abs(b.cht_residual) - Math.abs(a.cht_residual))[0]
      return worst ? `CYL ${worst.index} RESIDUAL ${signed(worst.cht_residual, 1)} °C` : null
    },
  },
  {
    stage: 'DETECT', title: 'PERSISTENCE CONFIRMED',
    detail: 'The deviation holds across regimes, so it is not a transient.',
    seconds: 7, route: '/anomalies', camera: 'SIDE', engine: 'DIAGNOSTIC',
    read: (s) => {
      const a = s.alerts?.anomalies?.find((x) => !x.abstained)
      return a ? `${a.regime_count} REGIMES · ${a.samples.toLocaleString()} SAMPLES` : null
    },
  },
  {
    stage: 'ESTIMATE', title: 'STATE ESTIMATOR DIVERGES',
    detail: 'The per-cylinder trim needed to fit the data has moved.',
    seconds: 7, camera: 'CINEMATIC', engine: 'DIAGNOSTIC',
    read: (s) => {
      const cyl = s.telemetry?.engine?.cylinders ?? []
      const worst = cyl.slice()
        .sort((a, b) => Math.abs(b.trim_divergence_pct) - Math.abs(a.trim_divergence_pct))[0]
      return worst ? `TRIM ${signed(worst.trim_divergence_pct, 2)} %` : null
    },
  },
  {
    stage: 'PREDICT', title: 'ANALYTICS ACTIVE',
    detail: 'Baseline and learned model score the same features.',
    seconds: 8, camera: 'CINEMATIC', engine: 'DIAGNOSTIC',
    read: (s) => {
      const a = s.alerts?.anomalies?.find((x) => !x.abstained)
      if (!a) return null
      const learned = (a.learned as { verdict?: string })?.verdict
      return `SCORE ${fmt(a.score, 2)}${learned ? ` · FOREST ${learned}` : ''}`
    },
  },
  {
    stage: 'PREDICT', title: 'LIKELY MECHANISM',
    detail: 'Named as a hypothesis with its evidence, never as confirmed.',
    seconds: 8, camera: 'SIDE', engine: 'DIAGNOSTIC',
    read: (s) => {
      const a = s.alerts?.anomalies?.find((x) => !x.abstained)
      return a?.mechanism_label
        ? `${a.mechanism_qualifier} · ${a.mechanism_label}`
        : 'INSUFFICIENT EVIDENCE'
    },
  },
  {
    stage: 'ACT', title: 'MAINTENANCE ADVISORY',
    detail: 'A ranked action with the full evidence trail behind it.',
    seconds: 8, route: '/maintenance', camera: 'SIDE', engine: 'DIAGNOSTIC',
    read: (s) => {
      const adv = s.alerts?.advisories?.[0]
      return adv ? `${adv.priority_label} · ${adv.despatch_impact}` : 'NO ADVISORY RAISED'
    },
  },
  {
    stage: 'ACT', title: 'CAUGHT BEFORE THE LIMIT',
    detail: 'Detected on drift, not on a red line. The sortie completes.',
    seconds: 6, route: '/dashboard', camera: 'CINEMATIC',
    read: (s) => {
      const h = s.telemetry?.engine?.health_index
      return h ? `HEALTH ${h.toFixed(1)} · ${s.telemetry?.engine?.status ?? ''}` : null
    },
  },
]

const TOTAL = BEATS.reduce((sum, b) => sum + b.seconds, 0)

/** The pipeline, as the eight words the beats light up. */
const STAGES = ['LINK', 'OBSERVE', 'MODEL', 'COMPARE', 'DETECT', 'ESTIMATE', 'PREDICT', 'ACT']

export function DemoStory() {
  const navigate = useNavigate()
  const storyStep = useTwin((s) => s.storyStep)
  const setStoryStep = useTwin((s) => s.setStoryStep)
  const setCameraMode = useTwin((s) => s.setCameraMode)
  const exitMission = useTwin((s) => s.exitMission)
  const mode = useTwin((s) => s.mode)

  /* The narration holds whenever the simulation does. The story is a reading
     of the run, so it cannot be allowed to narrate past a paused clock. */
  const simRunning = useSimRunning()
  const pauseSim = useTwin((s) => s.pauseSim)
  const resumeSim = useTwin((s) => s.resumeSim)
  const [paused, setPaused] = useState(false)
  const [beatElapsed, setBeatElapsed] = useState(0)
  const [evidence, setEvidence] = useState<string | null>(null)
  const timer = useRef(0)

  const running = storyStep >= 0
  const beat = running ? BEATS[Math.min(storyStep, BEATS.length - 1)] : null

  /* One control, both clocks: pausing the narration pauses the simulation it
     is narrating, so the evidence on screen stays the evidence being read. */
  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p) void resumeSim()
      else pauseSim()
      return !p
    })
  }, [pauseSim, resumeSim])

  const stop = useCallback(() => {
    setStoryStep(-1)
    setBeatElapsed(0)
    timer.current = 0
    // Bring the aircraft back to the corner and hand the console back.
    exitMission()
  }, [setStoryStep, exitMission])

  const advance = useCallback(() => {
    const next = storyStep + 1
    timer.current = 0
    setBeatElapsed(0)
    if (next >= BEATS.length) {
      stop()
      return
    }
    setStoryStep(next)
  }, [storyStep, setStoryStep, stop])

  /* The beat clock. Evidence is sampled four times a second rather than every
     frame - it is a readout, not an animation. */
  useEffect(() => {
    if (!running || paused || !simRunning) return
    const id = window.setInterval(() => {
      timer.current += 0.25
      setBeatElapsed(timer.current)
      const current = BEATS[storyStep]
      if (current?.read) setEvidence(current.read(useTwin.getState()))
      if (current && timer.current >= current.seconds) advance()
    }, 250)
    return () => window.clearInterval(id)
  }, [running, paused, simRunning, storyStep, advance])

  /* The camera moves with the narration, and the console behind the theatre
     follows too - so closing the story lands the operator on the screen the
     last beat was about. */
  useEffect(() => {
    if (!running) return
    const current = BEATS[storyStep]
    if (current?.camera) setCameraMode(current.camera)
    if (current?.route) navigate(current.route)
    setEvidence(current?.read ? current.read(useTwin.getState()) : null)
  }, [running, storyStep, navigate, setCameraMode])

  useEffect(() => {
    if (!running) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop()
      if (e.key === ' ') {
        e.preventDefault()
        togglePause()
      }
      if (e.key === 'ArrowRight') advance()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, stop, advance, togglePause])

  if (!running || !beat) return null

  const done = BEATS.slice(0, storyStep).reduce((sum, b) => sum + b.seconds, 0)
  const overall = Math.min(1, (done + beatElapsed) / TOTAL)
  const activeStage = STAGES.indexOf(beat.stage)

  return (
    <AnimatePresence>
      <motion.div
        className="theatre"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.6, ease: EASE }}
        aria-live="polite"
      >
        {/* The aircraft fills the screen behind this layer - the shared 3D
            stage, already in its fullscreen framing. Only the chrome is here. */}
        <div className="theatre__bar theatre__bar--top" />
        <div className="theatre__bar theatre__bar--bottom" />

        <header className="theatre__top">
          <Wordmark size={14} />
          <span className="theatre__spacer" />
          <span className="theatre__src">
            {mode === 'DEMO' ? 'LOCAL DEMO FEED' : 'BACKEND SCRIPTED SORTIE'}
          </span>
          <button className="theatre__close" onClick={stop} title="End the demonstration (Esc)">
            <X size={14} strokeWidth={2} />
          </button>
        </header>

        {/* ---- the engine, once it is the subject ------------------------- */}
        <AnimatePresence>
          {beat.engine && (
            <motion.div
              className="theatre__engine"
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ duration: 0.55, ease: EASE }}
            >
              <div className="theatre__engine-head">
                <span>AERO-01</span>
                <span className="theatre__engine-mode">{beat.engine}</span>
              </div>
              <EngineStage height={230} view={beat.engine} chrome={false} compact />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ---- the narration --------------------------------------------- */}
        <div className="theatre__copy">
          <div className="theatre__stage-tag">{beat.stage}</div>
          <AnimatePresence mode="wait">
            <motion.div
              key={beat.title}
              initial={{ opacity: 0, y: 16, filter: 'blur(5px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
              transition={{ duration: 0.3, ease: EASE }}
            >
              <h2 className="theatre__title">{beat.title}</h2>
              <p className="theatre__detail">{beat.detail}</p>
            </motion.div>
          </AnimatePresence>

          <div className="theatre__evidence">
            <span className="theatre__evidence-k">LIVE</span>
            <motion.span
              key={beat.title}
              className="theatre__evidence-v"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: EASE }}
            >
              {evidence ?? '—'}
            </motion.span>
          </div>
        </div>

        {/* ---- pipeline, controls, progress ------------------------------ */}
        <div className="theatre__foot">
          <nav className="theatre__pipeline" aria-label="Pipeline">
            {STAGES.map((name, i) => (
              <span
                key={name}
                className={`theatre__step ${i === activeStage ? 'is-active' : ''} ${
                  i < activeStage ? 'is-done' : ''
                }`}
              >
                {name}
              </span>
            ))}
          </nav>

          <span className="theatre__spacer" />

          <div className="theatre__controls">
            <button
              className="theatre__btn"
              onClick={togglePause}
              title={paused ? 'Resume (space)' : 'Pause (space)'}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}
            </button>
            <button className="theatre__btn" onClick={advance} title="Next beat (→)">
              <SkipForward size={13} />
            </button>
          </div>
        </div>

        <div className="theatre__rail">
          {BEATS.map((b, i) => (
            <span
              key={`${b.title}-${i}`}
              className={`theatre__tick ${i < storyStep ? 'is-done' : ''} ${
                i === storyStep ? 'is-active' : ''
              }`}
            />
          ))}
        </div>

        <div className="theatre__progress">
          <div className="theatre__progress-fill" style={{ width: `${overall * 100}%` }} />
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

/**
 * Starts the narration, the backend's scripted sortie behind it, and the
 * fullscreen framing it is told in.
 */
export async function launchStory() {
  const state = useTwin.getState()
  const status = simulation.getState().status

  // Only start something that is not already running.
  //
  // Restarting unconditionally rewinds the sortie to t=0, and the story then
  // opens on an aircraft that has just left the runway at 900 ft over grass,
  // narrating a developing fault that has not begun yet. The narration is a
  // reading of the run in progress; where one is in progress, it reads that.
  if (status === 'paused') {
    await state.resumeSim().catch(() => null)
  } else if (status !== 'running') {
    await state.startDemo().catch(() => null)
  }

  // The aircraft goes fullscreen first; the transition is part of the opening.
  useTwin.getState().enterMission()
  useTwin.getState().setStoryStep(0)
}

export { BEATS as STORY_BEATS }
