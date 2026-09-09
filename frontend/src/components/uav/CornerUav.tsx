/**
 * The corner UAV card.
 *
 * It is a frame, not a renderer: the actual WebGL canvas lives in UavStage and
 * is positioned over this element. That is what lets the aircraft fly out of
 * the corner rather than being replaced by a different scene.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronUp, Maximize2, X } from 'lucide-react'
import { useTwin } from '../../store/useTwin'
import { flightDynamics } from './flight'

export const CornerUav = forwardRef<HTMLDivElement, { hidden?: boolean }>(({ hidden = false }, ref) => {
  const cardRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => cardRef.current as HTMLDivElement)
  const enterMission = useTwin((s) => s.enterMission)
  const collapsed = useTwin((s) => s.cornerCollapsed)
  const toggleCorner = useTwin((s) => s.toggleCorner)
  const mission = useTwin((s) => s.mission)
  const telemetry = useTwin((s) => s.telemetry)
  const mode = useTwin((s) => s.mode)
  const dock = useTwin((s) => s.dock)
  const [docked, setDocked] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  const altRef = useRef<HTMLSpanElement>(null)
  const iasRef = useRef<HTMLSpanElement>(null)
  const rpmRef = useRef<HTMLSpanElement>(null)
  const popAltRef = useRef<HTMLSpanElement>(null)
  const popIasRef = useRef<HTMLSpanElement>(null)
  const popRpmRef = useRef<HTMLSpanElement>(null)

  /* Read the flight model directly each frame. These three numbers change
     every tick and re-rendering the card for them would be wasteful. */
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const s = flightDynamics.state
      const alt = Math.round(s.altitudeFt).toLocaleString()
      const ias = s.speedKt.toFixed(0)
      if (altRef.current) altRef.current.textContent = alt
      if (iasRef.current) iasRef.current.textContent = ias
      if (popAltRef.current) popAltRef.current.textContent = alt
      if (popIasRef.current) popIasRef.current.textContent = ias
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const rpm = Math.round(telemetry?.tick?.channels?.rpm ?? mission?.rpm ?? 0).toLocaleString()
    if (rpmRef.current) rpmRef.current.textContent = rpm
    if (popRpmRef.current) popRpmRef.current.textContent = rpm
  }, [telemetry, mission, infoOpen])

  /* On the Command Center the card docks into the hero slot instead of sitting
     in the corner.
     
     It stays a fixed-position element in the body rather than moving into the
     slot, because the console shell is its own stacking context and anything
     inside it renders underneath the shared canvas. Instead the card is driven
     onto the slot's rectangle each frame - the same rectangle the 3D stage
     tracks - so the frame and the aircraft inside it stay locked together
     through scrolling and resizing. */
  useEffect(() => {
    const card = cardRef.current
    if (!card) return

    if (dock !== 'HERO') {
      setDocked(false)
      card.style.left = ''
      card.style.top = ''
      card.style.width = ''
      card.style.height = ''
      card.style.right = ''
      card.style.bottom = ''
      return
    }

    let raf = 0
    const follow = () => {
      const slot = document.getElementById('uav-dock')
      const el = cardRef.current
      if (slot && el) {
        const r = slot.getBoundingClientRect()
        el.style.left = `${r.left}px`
        el.style.top = `${r.top}px`
        el.style.width = `${r.width}px`
        el.style.height = `${r.height}px`
        el.style.right = 'auto'
        el.style.bottom = 'auto'
        if (!docked) setDocked(true)
      }
      raf = requestAnimationFrame(follow)
    }
    raf = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(raf)
  }, [dock, docked])

  const phase = telemetry?.tick?.phase ?? mission?.mission?.phase ?? 'GROUND'
  const airborne = phase !== 'GROUND'

  /* Hidden means the console has gone to a fullscreen mission or the story
     theatre. A popover left open under either of those is a stray panel. */
  useEffect(() => {
    if (hidden || collapsed || docked) setInfoOpen(false)
  }, [hidden, collapsed, docked])

  const card = (
    <div
      ref={cardRef}
      className={`uav-card ${docked ? 'uav-card--docked' : collapsed ? 'uav-card--collapsed' : ''}`}
      /* The card lives in the body, so it cannot inherit the console's fade on
         the way into mission mode - it carries its own. */
      style={{
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? 'none' : 'auto',
        transition: 'opacity 420ms var(--ease)',
      }}
      /* Clicking the aircraft tells you about the aircraft. It used to throw
         the operator into the fullscreen mission view, which is a different
         feature entirely and a surprising place to land from a decorative
         corner card - so that now has its own labelled control below. */
      onClick={() => setInfoOpen((v) => !v)}
      role="button"
      tabIndex={0}
      aria-expanded={infoOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setInfoOpen((v) => !v)
        }
        if (e.key === 'Escape') setInfoOpen(false)
      }}
      aria-label="AeroTwin UAV - flight status"
    >
      {!docked && <button
        className="uav-card__collapse"
        onClick={(e) => {
          e.stopPropagation()
          toggleCorner()
        }}
        title={collapsed ? 'Expand the UAV view' : 'Collapse the UAV view'}
        aria-label={collapsed ? 'Expand the UAV view' : 'Collapse the UAV view'}
      >
        {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>}

      <header className="uav-card__head">
        <span className="mono" style={{ fontSize: 12, letterSpacing: '0.14em', color: 'var(--ink-2)' }}>
          {mission?.mission?.uav_id ?? 'UAV-01'}
        </span>
        <span className="spacer" />
        <span
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            color: airborne ? 'var(--ok-ink)' : 'var(--ink-4)',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <i className="dot dot--live" style={{ background: airborne ? 'var(--ok)' : 'var(--ink-4)' }} />
          {airborne ? 'AIRBORNE' : 'ON GROUND'}
        </span>
      </header>

      {!collapsed && !docked && !infoOpen && (
        <div className="uav-card__hint">
          <span className="uav-card__hint-inner">UAV status</span>
        </div>
      )}

      {/* The way into the fullscreen mission view, said in words and kept
          separate from the aircraft itself. */}
      {!collapsed && !docked && (
        <button
          className="uav-card__mission"
          onClick={(e) => { e.stopPropagation(); setInfoOpen(false); enterMission() }}
          title="Mission Control - fullscreen 3D view"
        >
          <Maximize2 size={11} strokeWidth={2} />
          Mission Control
        </button>
      )}

      <AnimatePresence>
        {infoOpen && (
          <motion.div
            className="uav-pop"
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="UAV status"
          >
            <header className="uav-pop__head">
              <span className="uav-pop__title">AeroTwin UAV</span>
              <span className="spacer" />
              <button
                className="uav-pop__close"
                onClick={(e) => { e.stopPropagation(); setInfoOpen(false) }}
                aria-label="Close"
              >
                <X size={12} />
              </button>
            </header>

            <dl className="uav-pop__facts">
              <div>
                <dt>Status</dt>
                <dd className={airborne ? 'is-ok' : ''}>{airborne ? 'IN FLIGHT' : 'ON GROUND'}</dd>
              </div>
              <div>
                <dt>Altitude</dt>
                <dd><span ref={popAltRef}>0</span> ft</dd>
              </div>
              <div>
                <dt>IAS</dt>
                <dd><span ref={popIasRef}>0</span> kt</dd>
              </div>
              <div>
                <dt>RPM</dt>
                <dd><span ref={popRpmRef}>0</span></dd>
              </div>
            </dl>

            <p className="uav-pop__note">Monitoring engine condition</p>
            <span className={`uav-pop__src uav-pop__src--${mode === 'DEMO' ? 'demo' : 'live'}`}>
              {mode === 'DEMO' ? 'LOCAL MODEL · DEMO' : 'LIVE TELEMETRY'}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="uav-card__foot">
        {collapsed && !docked && (
          <div className="stat stat--sm">
            <span className="stat__k">UAV</span>
            <span
              className="stat__v"
              style={{ fontSize: 12.5, color: airborne ? 'var(--ok-ink)' : 'var(--ink-3)' }}
            >
              {mission?.mission?.uav_id ?? 'UAV-01'}
            </span>
          </div>
        )}
        <div className="stat stat--sm">
          <span className="stat__k">ALT</span>
          <span className="stat__v" style={{ fontSize: 14 }}>
            <span ref={altRef}>0</span>
            <span className="stat__u">ft</span>
          </span>
        </div>
        <div className="stat stat--sm">
          <span className="stat__k">IAS</span>
          <span className="stat__v" style={{ fontSize: 14 }}>
            <span ref={iasRef}>0</span>
            <span className="stat__u">kt</span>
          </span>
        </div>
        <div className="stat stat--sm">
          <span className="stat__k">RPM</span>
          <span className="stat__v" style={{ fontSize: 14 }}>
            <span ref={rpmRef}>0</span>
          </span>
        </div>
        {mode === 'DEMO' && (
          <div className="stat stat--sm">
            <span className="stat__k">SRC</span>
            <span className="stat__v" style={{ fontSize: 12.5, color: 'var(--demo-ink)' }}>DEMO</span>
          </div>
        )}
      </footer>
    </div>
  )

  // Always in the body: the card is a frame drawn over the canvas, never a
  // container inside the console's stacking context.
  return createPortal(card, document.body)
})

CornerUav.displayName = 'CornerUav'
