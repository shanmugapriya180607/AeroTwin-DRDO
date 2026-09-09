/**
 * How AeroTwin works.
 *
 * The second step of first entry: the method, before any of the instruments.
 * A judge or an engineer who has never seen the product should be able to
 * leave this screen able to say what a residual is and why the console is
 * built around one - without having read a paragraph.
 *
 * So the picture carries the argument and the words only label it. Six stages,
 * each one line, walked through in order while the aircraft keeps flying and
 * telemetry keeps coming off it. The chain is the real one: the stage names
 * match the pipeline the Command Center draws from live frames.
 *
 * Nothing here is measured. It is a rendered explanation of the method, and
 * the footer says so - the same rule the opening film is held to.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, SkipForward } from 'lucide-react'
import { Wordmark } from '../components/brand/Wordmark'
import { useSettings } from '../store/useSettings'

const EASE = [0.22, 1, 0.36, 1] as const

interface Stage {
  n: string
  title: string
  line: string
  /** The word the console itself uses for this stage. */
  term: string
}

const STAGES: Stage[] = [
  { n: '01', title: 'Real telemetry', line: 'Engine and flight-condition data, one frame a second.', term: 'INGEST' },
  { n: '02', title: 'Digital twin', line: 'A physics model of this engine says what to expect.', term: 'EXPECTED' },
  { n: '03', title: 'Residual', line: 'Actual minus expected. The difference is the signal.', term: 'ACTUAL − EXPECTED' },
  { n: '04', title: 'Analytics', line: 'Abnormal patterns in the residual, not in the raw reading.', term: 'DETECT' },
  { n: '05', title: 'Diagnosis', line: 'Which cylinder, on what evidence, and how sure.', term: 'LOCALISE' },
  { n: '06', title: 'Advisory', line: 'What to inspect, with the evidence attached.', term: 'ADVISE' },
]

/** Seconds each stage holds before the next lights up. */
const DWELL = 2.1

export default function HowItWorks() {
  const navigate = useNavigate()
  const animation = useSettings((s) => s.animation)
  const systemReduced = useReducedMotion()
  const motionOn = animation && !systemReduced

  const [active, setActive] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const timer = useRef<number>()

  /* The walk-through advances on its own and stops at the end - it does not
     loop. A page that keeps restarting its own explanation is a page nobody
     can finish reading. */
  useEffect(() => {
    if (!motionOn) {
      setActive(STAGES.length - 1)
      return undefined
    }
    if (active >= STAGES.length - 1) return undefined
    timer.current = window.setTimeout(() => setActive((i) => i + 1), DWELL * 1000)
    return () => window.clearTimeout(timer.current)
  }, [active, motionOn])

  const go = (to: string) => {
    setLeaving(true)
    window.setTimeout(() => navigate(to), 520)
  }

  /* Esc skips, like the film. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') go('/dashboard')
      if (e.key === 'Enter') go('/uav')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const complete = active >= STAGES.length - 1

  return (
    <motion.div
      className="how"
      initial={{ opacity: 0 }}
      animate={{
        opacity: leaving ? 0 : 1,
        scale: leaving ? 1.03 : 1,
        filter: leaving ? 'blur(7px)' : 'blur(0px)',
      }}
      transition={{ duration: leaving ? 0.5 : 0.65, ease: EASE }}
    >
      <div className="how__sky" aria-hidden />

      <header className="how__top">
        <Wordmark size={15} />
        <span className="spacer" />
        <button className="how__skip" onClick={() => go('/dashboard')}>
          Skip <SkipForward size={13} strokeWidth={2} />
        </button>
      </header>

      <div className="how__inner">
        <div className="how__lede">
          <span className="how__eyebrow">How it works</span>
          <h1 className="how__title">
            Compare the engine<br />with <b>what physics expects</b>
          </h1>
          <p className="how__sub">
            AeroTwin does not watch for a temperature crossing a limit. It runs a physics model of
            this engine alongside the real one and watches the gap between them - which moves long
            before any single reading looks wrong.
          </p>
        </div>

        {/* ---- the aircraft, and what comes off it --------------------- */}
        <Aircraft motionOn={motionOn} />

        {/* ---- the chain ------------------------------------------------ */}
        <ol className="how__chain">
          {STAGES.map((stage, i) => {
            const state = i < active ? 'is-done' : i === active ? 'is-active' : ''
            return (
              <li key={stage.n} className={`how__stage ${state}`}>
                <button
                  className="how__stage-btn"
                  onClick={() => setActive(i)}
                  aria-current={i === active ? 'step' : undefined}
                >
                  <span className="how__n">{stage.n}</span>
                  <span className="how__stage-body">
                    <span className="how__stage-title">{stage.title}</span>
                    <span className="how__stage-line">{stage.line}</span>
                    <span className="how__term">{stage.term}</span>
                  </span>
                </button>
                {i < STAGES.length - 1 && <span className="how__link" aria-hidden />}
              </li>
            )
          })}
        </ol>
      </div>

      <footer className="how__foot">
        <span className="how__prov">Rendered explanation · not measured flight data</span>
        <span className="spacer" />
        <button className="how__secondary" onClick={() => go('/dashboard')}>
          Go straight to the console
        </button>
        <button className={`how__primary ${complete ? 'is-ready' : ''}`} onClick={() => go('/uav')}>
          See the aircraft
          <ArrowRight size={15} strokeWidth={2} />
        </button>
      </footer>
    </motion.div>
  )
}

/* ------------------------------------------------------------- aircraft -- */

/**
 * The aircraft and its downlink.
 *
 * Deliberately a drawing, not a third WebGL scene. The film and the showcase
 * each hold a renderer, browsers cap the number of live contexts, and this
 * page needs to survive being opened between the two of them on a laptop.
 */
function Aircraft({ motionOn }: { motionOn: boolean }) {
  const packets = useMemo(() => [0, 1, 2, 3, 4], [])

  return (
    <div className="how__scene" aria-hidden>
      <svg viewBox="0 0 520 190" className="how__art">
        {/* horizon */}
        <path className="how__horizon" d="M0 150 Q 130 138 260 146 T 520 140" />
        <path className="how__horizon how__horizon--far" d="M0 128 Q 160 118 300 124 T 520 118" />

        {/* the aircraft, held level while the ground drifts under it */}
        <motion.g
          className="how__uav"
          animate={motionOn ? { y: [0, -5, 0] } : undefined}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        >
          <g transform="translate(232 52)">
            {/* wing */}
            <path d="M-84 8 L-16 2 L16 2 L84 8 L16 14 L-16 14 Z" />
            {/* fuselage */}
            <path d="M-9 -12 q9 -7 18 0 l6 20 l-6 20 q-9 7 -18 0 l-6 -20 Z" />
            {/* boom and v-tail */}
            <path d="M0 28 L0 48 M0 48 L-11 57 M0 48 L11 57" fill="none" />
            {/* propeller disc */}
            <ellipse cx="0" cy="34" rx="13" ry="3" opacity="0.45" />
          </g>
        </motion.g>

        {/* the downlink: telemetry leaving the aircraft */}
        <path className="how__beam" d="M232 92 L232 176" />
        {packets.map((i) => (
          <motion.circle
            key={i}
            className="how__packet"
            cx={232}
            r={2.6}
            initial={{ cy: 92, opacity: 0 }}
            animate={motionOn ? { cy: [92, 176], opacity: [0, 1, 1, 0] } : { cy: 150, opacity: 0.8 }}
            transition={{ duration: 1.9, repeat: Infinity, delay: i * 0.38, ease: 'linear' }}
          />
        ))}

        <text className="how__beam-label" x={244} y={126}>ENGINE TELEMETRY</text>
      </svg>
    </div>
  )
}
