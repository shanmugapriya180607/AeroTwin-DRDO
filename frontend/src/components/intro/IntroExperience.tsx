/**
 * First-entry experience.
 *
 * Runs once per browser (localStorage: aerotwin_intro_seen) and on demand from
 * "Replay intro". One clock drives both the 3D scene and the overlay; the
 * operator can skip at any point, jump between chapters, or let it run to the
 * way in.
 *
 * If the machine has no WebGL the same story is told on a 2D canvas rather
 * than showing an empty stage - the product must never depend on the
 * cinematic layer to be usable.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { motion } from 'framer-motion'
import * as THREE from 'three'
import { hasWebGL, prefersReducedMotion } from '../../services/capability'
import { RenderBoundary } from '../ui/Boundary'
import { IntroOverlay } from './IntroOverlay'
import { IntroScene, type IntroClock } from './IntroScene'
import { IntroFallback } from './IntroFallback'
import { ACTS, ACT_STARTS, actAt } from './introTimeline'

export function IntroExperience({ onEnter }: { onEnter: () => void }) {
  const clock = useRef<IntroClock>({ t: 0, act: 0, progress: 0, local: 0 })
  const startedAt = useRef(performance.now())
  const offset = useRef(0)

  const [actIndex, setActIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [closing, setClosing] = useState(false)

  const webgl = useMemo(hasWebGL, [])
  const reduced = useMemo(prefersReducedMotion, [])

  /* One rAF loop owns the clock. React state is updated at a low rate - the
     act, a coarse progress for the overlay, and the timecode - so the 3D
     scene is never re-rendered by the timeline. */
  useEffect(() => {
    let raf = 0
    let lastPublish = 0

    const tick = () => {
      const now = performance.now()
      const t = offset.current + (now - startedAt.current) / 1000
      const { index, progress } = actAt(t)
      clock.current.t = t
      clock.current.act = index
      clock.current.progress = progress
      clock.current.local = t - ACT_STARTS[index]

      if (now - lastPublish > 90) {
        lastPublish = now
        setActIndex(index)
        setProgress(progress)
        setElapsed(t)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  /* Reduced motion: hold on the final frame rather than running the whole
     camera move. The information is identical. */
  useEffect(() => {
    if (!reduced) return
    offset.current = ACT_STARTS[ACTS.length - 1]
    startedAt.current = performance.now()
  }, [reduced])

  const finish = useCallback(() => {
    if (closing) return
    setClosing(true)
    window.setTimeout(onEnter, 820)
  }, [closing, onEnter])

  const seek = useCallback((index: number) => {
    offset.current = ACT_STARTS[index]
    startedAt.current = performance.now()
  }, [])

  /* Esc skips, Enter/Space enters once the sequence has arrived. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      if ((e.key === 'Enter' || e.key === ' ') && ACTS[actIndex]?.id === 'BRAND') {
        e.preventDefault()
        finish()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finish, actIndex])

  const act = ACTS[actIndex] ?? ACTS[0]

  return (
    <motion.div
      className="intro"
      initial={{ opacity: 0 }}
      animate={{
        opacity: closing ? 0 : 1,
        scale: closing ? 1.05 : 1,
        filter: closing ? 'blur(9px)' : 'blur(0px)',
      }}
      transition={{ duration: closing ? 0.82 : 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="intro__stage">
        {webgl ? (
          <RenderBoundary label="intro scene" fallback={<IntroFallback clock={clock} />}>
            <Canvas
              dpr={[1, 1.6]}
              shadows={false}
              gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
              camera={{ position: [0, 60, 200], fov: 48, near: 0.1, far: 1600 }}
              onCreated={({ gl, scene }) => {
                gl.setClearColor('#cfe0f2')
                gl.toneMapping = THREE.ACESFilmicToneMapping
                gl.toneMappingExposure = 1.0
                scene.background = new THREE.Color('#cfe0f2')
              }}
            >
              <Suspense fallback={null}>
                <IntroScene clock={clock} />
              </Suspense>
            </Canvas>
          </RenderBoundary>
        ) : (
          <IntroFallback clock={clock} />
        )}
        <div className="intro__vignette" />
        <div className="intro__grain" />
      </div>

      <IntroOverlay
        act={act}
        actIndex={actIndex}
        progress={progress}
        elapsed={elapsed}
        onSkip={finish}
        onEnter={finish}
        onSeek={seek}
      />
    </motion.div>
  )
}
