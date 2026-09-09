/**
 * Startup cinematic.
 *
 * Short and technical rather than decorative: a distant contact resolves into
 * the aircraft while the system reports what it is actually bringing up. The
 * step list mirrors the backend's own boot state where it is reachable, so the
 * sequence is a status display, not a loading bar with invented captions.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight, Check, RotateCcw } from 'lucide-react'
import { Mark } from '../brand/Wordmark'
import { useTwin } from '../../store/useTwin'

const FALLBACK_STEPS = [
  { key: 'link', label: 'DATA LINK INITIALIZING' },
  { key: 'physics', label: 'PHYSICS MODEL ONLINE' },
  { key: 'residual', label: 'RESIDUAL ENGINE ACTIVE' },
  { key: 'twin', label: 'DIGITAL TWIN SYNCHRONIZED' },
]

const STEP_MS = 240

/** A distant contact approaching: pure canvas, no 3D cost during startup. */
function ApproachCanvas({ phase }: { phase: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const start = performance.now()

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      const t = (performance.now() - start) / 1000
      ctx.clearRect(0, 0, w, h)

      // Horizon glow
      const gradient = ctx.createRadialGradient(w * 0.5, h * 0.52, 10, w * 0.5, h * 0.52, w * 0.62)
      gradient.addColorStop(0, 'rgba(207,224,242,0.55)')
      gradient.addColorStop(1, 'rgba(244,249,255,0)')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)

      // Scan rings
      for (let i = 0; i < 3; i += 1) {
        const p = ((t * 0.32 + i / 3) % 1)
        ctx.beginPath()
        ctx.arc(w * 0.5, h * 0.52, p * w * 0.46, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(10,110,214,${0.16 * (1 - p)})`
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // The contact: a silhouette growing out of the haze
      const approach = Math.min(1, t / 2.6)
      const scale = 0.1 + approach * approach * 1.35
      const x = w * 0.5
      const y = h * 0.52 - approach * 18
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(scale, scale)
      ctx.globalAlpha = 0.14 + approach * 0.5
      ctx.fillStyle = '#5a7089'
      // Wing
      ctx.fillRect(-62, -1.4, 124, 2.8)
      // Fuselage
      ctx.beginPath()
      ctx.ellipse(0, 0, 7, 20, 0, 0, Math.PI * 2)
      ctx.fill()
      // V-tail
      ctx.fillRect(-13, 14, 26, 2)
      ctx.restore()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [phase])

  return (
    <canvas
      ref={ref}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.85 }}
    />
  )
}

export function BootSequence({ onDone, onReplay }: { onDone: () => void; onReplay?: () => void }) {
  const status = useTwin((s) => s.status)
  const [index, setIndex] = useState(-1)
  const [closing, setClosing] = useState(false)
  /* The returning operator gets the way in and the way back to the full
     sequence. It arms itself after a beat so a demo is not held up, and
     hovering the card cancels the countdown. */
  const [armed, setArmed] = useState(false)
  const [held, setHeld] = useState(false)

  const steps = useMemo(() => {
    const backend = status?.boot?.steps
    if (backend?.length) {
      return backend.map((s) => ({ key: s.key, label: s.label.toUpperCase() }))
    }
    return FALLBACK_STEPS
  }, [status])

  /* The bring-up runs on a schedule, so the effect keys on how many steps
     there are rather than on the array. With a backend reachable the status
     poll rebuilds `steps` every few seconds, and depending on its identity
     restarted the whole sequence each time. */
  const count = steps.length
  useEffect(() => {
    const timers: number[] = []
    timers.push(window.setTimeout(() => setIndex(0), 400))
    for (let i = 0; i < count; i += 1) {
      timers.push(window.setTimeout(() => setIndex(i + 1), 400 + (i + 1) * STEP_MS))
    }
    timers.push(window.setTimeout(() => setArmed(true), 400 + (count + 1) * STEP_MS))
    return () => timers.forEach(window.clearTimeout)
  }, [count])

  /*
   * Auto-entry, cancelled the moment the operator reaches for the card.
   *
   * The callback is held in a ref rather than named as a dependency. Callers
   * pass an inline arrow, so its identity changes on every render of the
   * console - and the console re-renders with every telemetry frame. Depending
   * on it meant this effect tore down and rebuilt its own timer several times a
   * second, the timeout never reached its end, and the card sat on top of the
   * application forever swallowing every click.
   */
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    if (!armed || held) return
    const id = window.setTimeout(() => {
      setClosing(true)
      window.setTimeout(() => done.current(), 620)
    }, 1800)
    return () => window.clearTimeout(id)
  }, [armed, held])

  const enter = () => {
    setClosing(true)
    window.setTimeout(onDone, 340)
  }

  const replay = () => {
    setHeld(true)
    onReplay?.()
  }

  return (
    <AnimatePresence>
      {!closing && (
        <motion.div
          className="boot"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, filter: 'blur(6px)' }}
          transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1] }}
          /* A fullscreen layer over the console takes every click while it is
             up. Anywhere outside the card means "let me in" - without it the
             console reads as unresponsive to anyone who does not spot the
             button. */
          onClick={enter}
        >
          <ApproachCanvas phase={index} />

          {/*
            Holding the countdown is for when the operator reaches for the card.
            It has to key on intent the operator actually expressed: the primary
            action carries autoFocus for keyboard users, focus bubbles, and an
            onFocus here therefore fired on mount and cancelled the countdown
            permanently - leaving this card on top of the console swallowing
            every click. Pointer intent instead, and reversible, so drifting
            across the card does not wedge it either.
          */}
          <div
            className="boot__inner"
            onClick={(e) => e.stopPropagation()}
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
            onKeyDown={() => setHeld(true)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.86, rotate: -18 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
              className="boot__mark"
            >
              <Mark size={40} />
            </motion.div>

            <motion.div
              initial={{ opacity: 0, letterSpacing: '0.9em', y: 12 }}
              animate={{ opacity: 1, letterSpacing: '0.34em', y: 0 }}
              transition={{ duration: 1.5, ease: [0.22, 1, 0.36, 1], delay: 0.55 }}
              className="boot__title"
            >
              AEROTWIN
            </motion.div>

            <motion.div
              className="boot__sub"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.5, duration: 0.7 }}
            >
              Propulsion Intelligence System
            </motion.div>

            <motion.div
              className="boot__steps"
              initial={{ opacity: 0 }}
              animate={{ opacity: index >= 0 ? 1 : 0 }}
              transition={{ duration: 0.4 }}
            >
              {steps.map((step, i) => {
                const done = index > i
                const active = index === i
                return (
                  <motion.div
                    key={step.key}
                    className={`boot__step ${done ? 'boot__step--done' : active ? 'boot__step--active' : ''}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: index >= i ? 1 : 0.24, x: 0 }}
                    transition={{ duration: 0.32 }}
                  >
                    <span style={{ width: 14, display: 'inline-flex' }}>
                      {done ? <Check size={12} strokeWidth={2.4} /> : active ? '›' : '·'}
                    </span>
                    {step.label}
                    {done && <span style={{ marginLeft: 'auto', color: 'var(--ok-ink)' }}>OK</span>}
                  </motion.div>
                )
              })}
            </motion.div>

            <motion.div
              className="boot__entry"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: armed ? 1 : 0, y: armed ? 0 : 10 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              style={{ pointerEvents: armed ? 'auto' : 'none' }}
            >
              <button className="boot__enter" onClick={enter} autoFocus>
                ENTER AEROTWIN
                <ArrowRight size={14} strokeWidth={2} />
              </button>
              {onReplay && (
                <button className="boot__replay" onClick={replay}>
                  <RotateCcw size={12} strokeWidth={1.9} />
                  REPLAY INTRO
                </button>
              )}
              <div className={`boot__countdown ${held ? 'is-held' : ''}`} aria-hidden />
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
