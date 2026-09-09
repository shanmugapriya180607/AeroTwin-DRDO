/**
 * The typographic layer over the film.
 *
 * Almost nothing. One word per act, one monospace marker under it, a chapter
 * rail, and the way in. The picture is doing the explaining, so an act that
 * needs no label carries none and the frame is left clear.
 *
 * The only sentence anywhere is the provenance line, which stays because a
 * rendered explanation must never be mistaken for measured data.
 */

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { ACTS, ACT, ENGINE_MODES, PILLARS, type Act } from './introTimeline'
import { Wordmark } from '../brand/Wordmark'

const EASE = [0.22, 1, 0.36, 1] as const

export function IntroOverlay({
  act,
  actIndex,
  progress,
  elapsed,
  onSkip,
  onEnter,
  onSeek,
}: {
  act: Act
  actIndex: number
  progress: number
  elapsed: number
  onSkip: () => void
  onEnter: () => void
  onSeek: (index: number) => void
}) {
  const brand = act.id === 'BRAND'
  /* The engine views are walked through inside one act, so the marker has to
     name whichever one is on screen rather than the act as a whole. */
  const marker =
    act.id === 'MODES'
      ? ENGINE_MODES[Math.min(ENGINE_MODES.length - 1, Math.floor(progress / 0.26))]
      : act.marker
  // The wordmark resolves out of the scan rather than being typed over it.
  const wordmark = act.id === 'SCAN' || brand
  const showTitle = !!act.title && !wordmark

  return (
    <div className="intro__overlay">
      <div className="intro__bar intro__bar--top" />
      <div className="intro__bar intro__bar--bottom" />

      {/* ---- corner brand: quiet until the reveal claims the centre ------ */}
      <motion.div
        className="intro__brand"
        animate={{ opacity: wordmark ? 0 : 1 }}
        transition={{ duration: 0.6, ease: EASE }}
      >
        <Wordmark size={16} />
      </motion.div>

      <button className="intro__skip" onClick={onSkip}>
        SKIP INTRO <ArrowRight size={13} strokeWidth={2} />
      </button>

      {/* ---- chapter rail ------------------------------------------------ */}
      <nav className="intro__chapters" aria-label="Chapters">
        {ACTS.map((a, i) => (
          <button
            key={a.id}
            className={`intro__chapter ${i === actIndex ? 'is-active' : ''} ${i < actIndex ? 'is-done' : ''}`}
            onClick={() => onSeek(i)}
            title={a.chapter}
          >
            <span className="intro__chapter-dot" />
            <span className="intro__chapter-label">{a.chapter}</span>
          </button>
        ))}
      </nav>

      {/* ---- the centred reveal ------------------------------------------ */}
      <AnimatePresence>
        {wordmark && (
          <motion.div
            className={`intro__reveal ${brand ? 'intro__reveal--final' : ''}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, filter: 'blur(8px)' }}
            transition={{ duration: 0.8, ease: EASE }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, filter: 'blur(14px)' }}
              animate={{
                opacity: brand ? 1 : Math.min(1, Math.max(0, (progress - 0.42) / 0.24)),
                scale: 1,
                filter: 'blur(0px)',
              }}
              transition={{ duration: 1.1, ease: EASE }}
            >
              <Wordmark size={brand ? 62 : 54} stacked />
            </motion.div>

            {brand && (
              <>
                <motion.div
                  className="intro__pillars"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.7, delay: 0.45, ease: EASE }}
                >
                  {PILLARS.map((word, i) => (
                    <motion.span
                      key={word}
                      className="intro__pillar"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.5, delay: 0.6 + i * 0.12, ease: EASE }}
                    >
                      {word}
                    </motion.span>
                  ))}
                </motion.div>

                <motion.button
                  className="intro__enter"
                  onClick={onEnter}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6, delay: 1.05, ease: EASE }}
                >
                  ENTER AEROTWIN
                  <ArrowRight size={16} strokeWidth={2} />
                </motion.button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- the act label, lower left ----------------------------------- */}
      <div className="intro__copy">
        <AnimatePresence mode="wait">
          {(showTitle || marker) && (
            <motion.div
              key={`${act.id}-${marker}`}
              initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -10, filter: 'blur(5px)' }}
              transition={{ duration: 0.6, ease: EASE }}
            >
              {showTitle && <h1 className="intro__title">{act.title}</h1>}
              {marker && !wordmark && <div className="intro__marker">{marker}</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ---- footer: honesty, and where we are --------------------------- */}
      <div className="intro__foot">
        <span className="intro__prov">RENDERED · NOT MEASURED FLIGHT DATA</span>
        <span className="intro__foot-spacer" />
        <span className="intro__timecode mono">
          {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
          {String(Math.floor(elapsed % 60)).padStart(2, '0')} · {act.chapter}
        </span>
      </div>

      <div className="intro__progress">
        <div
          className="intro__progress-fill"
          style={{
            width: `${Math.min(100, ((actIndex + (actIndex >= ACT.BRAND ? 1 : progress)) / ACTS.length) * 100)}%`,
          }}
        />
      </div>
    </div>
  )
}
