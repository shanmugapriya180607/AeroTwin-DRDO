/**
 * The alert centre: bell, panel, history and toasts.
 *
 * Three surfaces on one feed. The bell says how many deviations have been
 * raised since you last looked; the panel is the history, newest first; the
 * toast is the interruption, and it is the only one of the three that is
 * allowed to take the operator's attention without being asked.
 *
 * Restraint is the point. A toast appears when a deviation is first raised or
 * when it escalates, and never again for the same finding - a console that
 * re-announces the same drift every second is a console people learn to
 * ignore, which is the one failure mode an alerting system cannot have.
 */

import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle, ArrowRight, Bell, BellOff, Check, Info, ShieldAlert, Volume2,
  VolumeX, X,
} from 'lucide-react'
import { useTwin } from '../../store/useTwin'
import { useSettings } from '../../store/useSettings'
import {
  alertState, startVoiceLoop, stopVoiceLoop, useNotifications,
  type AlertState, type Level, type Notification,
} from '../../store/useNotifications'
import { onVoiceStatus, unlockVoice, voiceStatus, type VoiceStatus } from '../../services/voice'
import { pct } from '../ui/Primitives'

const EASE = [0.22, 1, 0.36, 1] as const

const TONE: Record<Level, string> = {
  INFO: 'info',
  WARNING: 'warn',
  CRITICAL: 'crit',
}

function LevelIcon({ level, size = 14 }: { level: Level; size?: number }) {
  if (level === 'CRITICAL') return <ShieldAlert size={size} strokeWidth={2} />
  if (level === 'WARNING') return <AlertTriangle size={size} strokeWidth={2} />
  return <Info size={size} strokeWidth={2} />
}

const STATE_LABEL: Record<AlertState, string> = {
  ACTIVE_UNACKNOWLEDGED: 'Unacknowledged',
  ACTIVE_MUTED: 'Voice muted · unacknowledged',
  ACKNOWLEDGED: 'Acknowledged',
}

/**
 * The alert's own state, said plainly.
 *
 * Three things an operator has to be able to tell apart at a glance: nobody
 * has seen this yet, somebody silenced the voice but still has not seen it,
 * and somebody has. Acknowledged is not the same as fixed, so the chip never
 * says "resolved" - whether the cylinder is still deviating is a separate
 * fact, carried beside it.
 */
function StateChip({ n }: { n: Notification }) {
  // Re-render when the mute switch moves: the state is derived from it.
  useSettings((s) => s.voiceAlerts)
  const state = alertState(n)
  const tone = state === 'ACKNOWLEDGED' ? 'ack' : state === 'ACTIVE_MUTED' ? 'muted' : 'open'
  return (
    <span className={`astate astate--${tone}`}>
      {state === 'ACKNOWLEDGED' ? <Check size={10} strokeWidth={2.5} />
        : state === 'ACTIVE_MUTED' ? <VolumeX size={10} strokeWidth={2.5} />
          : <AlertTriangle size={10} strokeWidth={2.5} />}
      {STATE_LABEL[state]}
    </span>
  )
}

function when(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  return `${Math.round(secs / 3600)}h ago`
}

/* ------------------------------------------------------------ the feed --- */

/**
 * Turn alert frames into events.
 *
 * Mounted once. It reads the same frame every panel reads and hands it to the
 * notification store, which is where the "is this new" decision lives.
 */
export function AlertFeed() {
  const alerts = useTwin((s) => s.alerts)
  const ingest = useNotifications((s) => s.ingest)

  useEffect(() => {
    if (!alerts?.anomalies) return
    ingest(alerts.anomalies, alerts.advisories ?? [])
  }, [alerts, ingest])

  /* One announcement loop for the console, started and stopped with the feed
     that supplies it. */
  useEffect(() => {
    startVoiceLoop()
    return stopVoiceLoop
  }, [])

  return null
}

/* ----------------------------------------------------------------- bell -- */

export function AlertBell() {
  const items = useNotifications((s) => s.items)
  const open = useNotifications((s) => s.panelOpen)
  const setPanel = useNotifications((s) => s.setPanel)
  const notifications = useSettings((s) => s.notifications)
  const outstanding = items.filter((n) => !n.acknowledged && n.level !== 'INFO').length
  const unread = outstanding || items.filter((n) => !n.read).length
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)

  /*
   * The panel is drawn in the body, not under the bell.
   *
   * The 3D stage and the aircraft card are portalled to the body at z-index 41
   * and 42, which puts them above the whole console shell - so a panel nested
   * inside the top bar is painted over by an aeroplane no matter what rank it
   * is given, because its rank is measured inside the shell. Escaping to the
   * body is the same move the toasts already make; the cost is that the
   * position has to be measured rather than inherited.
   */
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = () => {
      const r = ref.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 10, right: Math.max(12, window.innerWidth - r.right) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  /* Click-away and Escape both close it. A panel that can only be dismissed by
     hitting the same small target again is a panel that gets left open. The
     portalled panel is not a DOM descendant of the bell, so it has to be
     checked separately or every click inside it would close it. */
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setPanel(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(false) }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, setPanel])

  const pool = outstanding ? items.filter((n) => !n.acknowledged) : items.slice(0, 12)
  const worst: Level | null = pool.length
    ? pool.reduce<Level>((acc, n) => (
      n.level === 'CRITICAL' ? 'CRITICAL' : acc === 'CRITICAL' ? acc : n.level === 'WARNING' ? 'WARNING' : acc
    ), 'INFO')
    : null

  return (
    <div className="bell" ref={ref}>
      <button
        className={`btn btn--icon bell__button ${unread ? 'bell__button--active' : ''}`}
        onClick={() => setPanel(!open)}
        aria-label={
          outstanding
            ? `Alerts - ${outstanding} outstanding, unacknowledged`
            : 'Alerts - none outstanding'
        }
        aria-expanded={open}
        title={notifications ? 'Alerts' : 'Alerts (notifications are off)'}
      >
        {notifications ? <Bell size={14} /> : <BellOff size={14} />}
        {unread > 0 && (
          <span className={`bell__badge bell__badge--${worst ? TONE[worst] : 'info'}`}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* The portal wraps AnimatePresence, not the other way round:
          createPortal returns a portal, not an element, and AnimatePresence
          filters its children with isValidElement - so a portal handed to it
          is silently dropped and the panel never mounts. */}
      {createPortal(
        <AnimatePresence>
          {open && anchor && (
            <AlertPanel ref={panelRef} anchor={anchor} onClose={() => setPanel(false)} />
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- voice -- */

/**
 * The voice switch.
 *
 * Three states, not two. Off is a choice; unavailable is the browser having
 * no speech synthesis at all; locked is the audio gate that every browser
 * keeps shut until the page has been interacted with. Saying "on" while the
 * gate is shut would be a lie the operator only discovers by not hearing
 * anything.
 */
export function VoiceToggle() {
  const voiceAlerts = useSettings((s) => s.voiceAlerts)
  const toggleVoice = useSettings((s) => s.toggleVoice)
  const [status, setStatus] = useState<VoiceStatus>(() => voiceStatus())

  useEffect(() => onVoiceStatus(() => setStatus(voiceStatus())), [])

  const unavailable = status === 'UNAVAILABLE'
  const locked = voiceAlerts && status === 'LOCKED'
  const on = voiceAlerts && !unavailable

  const label = unavailable
    ? 'Voice alerts unavailable on this browser'
    : locked
      ? 'Voice alerts on - waiting for a click anywhere to allow audio'
      : on
        ? 'Voice alerts on'
        : 'Voice alerts off'

  return (
    <button
      className={`btn btn--icon voice ${on ? 'voice--on' : ''} ${locked ? 'voice--locked' : ''}`}
      onClick={() => { unlockVoice(); if (!unavailable) toggleVoice() }}
      disabled={unavailable}
      aria-pressed={on}
      title={label}
      aria-label={label}
    >
      {on ? <Volume2 size={14} /> : <VolumeX size={14} />}
      {locked && <span className="voice__gate" aria-hidden />}
    </button>
  )
}

/* ---------------------------------------------------------------- panel -- */

const AlertPanel = forwardRef<
  HTMLDivElement,
  { anchor: { top: number; right: number }; onClose: () => void }
>(function AlertPanel({ anchor, onClose }, ref) {
  const items = useNotifications((s) => s.items)
  const clear = useNotifications((s) => s.clear)
  const acknowledge = useNotifications((s) => s.acknowledge)
  const acknowledgeAll = useNotifications((s) => s.acknowledgeAll)
  const notifications = useSettings((s) => s.notifications)
  const navigate = useNavigate()
  const open = items.filter((n) => !n.acknowledged && n.level !== 'INFO').length

  return (
    <motion.div
      ref={ref}
      className="bell__panel"
      style={{ top: anchor.top, right: anchor.right }}
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98 }}
      transition={{ duration: 0.22, ease: EASE }}
      role="dialog"
      aria-label="Alert history"
    >
      <header className="bell__head">
        <span className="panel__title">Alerts</span>
        {open > 0 && <span className="bell__count">{open} outstanding</span>}
        <span className="panel__spacer" />
        {open > 0 && (
          <button className="btn btn--sm btn--primary" onClick={acknowledgeAll}>
            <Check size={12} /> Acknowledge all
          </button>
        )}
        {items.length > 0 && open === 0 && (
          <button className="btn btn--sm btn--ghost" onClick={clear}>
            <Check size={12} /> Clear
          </button>
        )}
        <button className="btn btn--sm btn--ghost" onClick={onClose} aria-label="Close alerts">
          <X size={13} />
        </button>
      </header>

      {!notifications && (
        <p className="bell__muted">
          Notifications are off in Settings. Deviations are still detected and still recorded
          here - only the interruption is silenced.
        </p>
      )}

      <div className="bell__list">
        {items.length === 0 ? (
          <div className="bell__empty">
            <Check size={18} strokeWidth={2} />
            <span className="bell__empty-title">No deviations raised</span>
            <span className="bell__empty-detail">
              Every channel is inside its expected band for the current regime.
            </span>
          </div>
        ) : (
          items.map((n) => (
            <div
              key={n.id}
              className={`bell__item bell__item--${TONE[n.level]} ${n.acknowledged ? 'is-ack' : ''}`}
            >
              <span className={`bell__level bell__level--${TONE[n.level]}`}>
                <LevelIcon level={n.level} size={13} />
              </span>
              <span className="bell__body">
                <span className="bell__row">
                  <span className="bell__title">{n.title}</span>
                  <span className="bell__when">{when(n.at)}</span>
                </span>
                <span className="bell__summary">{n.body}</span>
                <span className="bell__meta">
                  {n.cylinder ? `CYL ${n.cylinder}` : 'ENGINE'} · {n.evidence}
                  {n.confidence !== null && (
                    <> · {pct(n.confidence, 0)}{n.calibrated ? '' : ' uncalibrated'}</>
                  )}
                </span>
                <span className="bell__flags">
                  <StateChip n={n} />
                  {!n.conditionActive && (
                    <span className="astate astate--cleared">Condition no longer active</span>
                  )}
                  {n.spoken && (
                    <span className="astate astate--voice">
                      <Volume2 size={10} /> {n.announcements}×
                    </span>
                  )}
                </span>

                <span className="bell__actions">
                  {!n.acknowledged && (
                    <button className="toast__ack" onClick={() => acknowledge(n.id)}>
                      <Check size={11} /> Acknowledge
                    </button>
                  )}
                  <button
                    className="toast__cta"
                    onClick={() => { onClose(); navigate('/anomalies') }}
                  >
                    Diagnostics <ArrowRight size={11} />
                  </button>
                </span>
              </span>
            </div>
          ))
        )}
      </div>

      {items.length > 0 && (
        <footer className="bell__foot">
          <button className="btn btn--sm btn--block" onClick={() => { onClose(); navigate('/anomalies') }}>
            Open diagnostics <ArrowRight size={12} />
          </button>
        </footer>
      )}
    </motion.div>
  )
})

/* --------------------------------------------------------------- toasts -- */

/**
 * The interruption.
 *
 * Warnings clear themselves after nine seconds; a critical alert stays until
 * it is dismissed. That asymmetry is the whole design - the operator can miss
 * a warning and pick it up from the bell, but a critical finding should not be
 * able to disappear while they were looking somewhere else.
 */
export function AlertToasts() {
  const items = useNotifications((s) => s.items)
  const toasts = useNotifications((s) => s.toasts)
  const dismiss = useNotifications((s) => s.dismissToast)
  const acknowledge = useNotifications((s) => s.acknowledge)
  const navigate = useNavigate()

  const shown = toasts
    .map((id) => items.find((n) => n.id === id))
    .filter((n): n is Notification => !!n)

  return createPortal(
    <div className="toast-stack" aria-live="polite">
      <AnimatePresence initial={false}>
        {shown.map((n) => (
          <Toast
            key={n.id}
            n={n}
            onDismiss={() => dismiss(n.id)}
            onAck={() => acknowledge(n.id)}
            /* Opening the evidence is not an acknowledgement. The engineer
               may be checking exactly the thing that then needs confirming,
               and an alert that goes quiet because a page was opened is an
               alert that can be walked away from. */
            onOpen={() => navigate('/anomalies')}
          />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  )
}

function Toast({
  n,
  onDismiss,
  onOpen,
  onAck,
}: {
  n: Notification
  onDismiss: () => void
  onOpen: () => void
  onAck: () => void
}) {
  /* No timer. An outstanding alert stays on screen until it is acknowledged -
     a warning that clears itself after nine seconds is one an engineer can
     miss entirely by looking at another panel. The close button hides the
     toast without acknowledging it; the alert stays in the bell and the voice
     keeps going. */

  return (
    <motion.div
      className={`toast toast--${TONE[n.level]}`}
      initial={{ opacity: 0, x: 30, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 30, scale: 0.97 }}
      transition={{ duration: 0.34, ease: EASE }}
      role="alert"
    >
      <span className={`toast__level toast__level--${TONE[n.level]}`}>
        <LevelIcon level={n.level} size={15} />
      </span>

      <div className="toast__body">
        <div className="toast__head">
          <span className={`toast__tag toast__tag--${TONE[n.level]}`}>{n.level}</span>
          <span className="toast__title">{n.title}</span>
          <span className="panel__spacer" />
          <button className="toast__close" onClick={onDismiss} aria-label="Dismiss alert">
            <X size={13} />
          </button>
        </div>

        <p className="toast__text">{n.body}</p>

        {/* One line, not a table. A toast has to be readable in the second it
            is glanced at, and it is sitting over the operator's work. */}
        <p className="toast__facts">
          <b>{n.cylinder ? `CYL ${n.cylinder}` : 'ENGINE'}</b>
          <i />
          {n.confidence === null ? 'no confidence' : `${pct(n.confidence, 0)} confidence`}
          {n.confidence !== null && !n.calibrated && ' (uncalibrated)'}
          <i />
          {n.evidence}
        </p>

        <div className="toast__states">
          <StateChip n={n} />
          {!n.conditionActive && (
            <span className="astate astate--cleared">Condition no longer active</span>
          )}
        </div>

        {n.spoken && (
          <p className="toast__spoken">
            <Volume2 size={11} strokeWidth={2} />
            Announced {n.announcements}×
          </p>
        )}

        {n.action && <p className="toast__action">{n.action}</p>}

        <div className="toast__foot">
          {/* The only thing that ends the spoken alert. */}
          <button className="toast__ack" onClick={onAck}>
            <Check size={12} /> Acknowledge alert
          </button>
          <span className="panel__spacer" />
          <button className="toast__cta" onClick={onOpen}>
            View diagnostics <ArrowRight size={12} />
          </button>
        </div>
      </div>
    </motion.div>
  )
}
