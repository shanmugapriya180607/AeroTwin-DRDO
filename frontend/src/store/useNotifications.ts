/**
 * The notification centre, and the alert lifecycle.
 *
 * The detector has always found deviations; what the console lacked was a way
 * of telling anybody who was not already looking at the Diagnostics screen.
 * This turns the alert frame into events: something crossed the bar, here is
 * which cylinder, here is how strong the evidence is, here is what to check.
 *
 * It derives, it does not decide. Every field below is copied from the anomaly
 * the backend raised - the severity, the confidence, the mechanism and the
 * qualifier are the detector's, not this file's. Nothing here upgrades a
 * suspicion into a diagnosis, and where the twin has abstained the notice says
 * so rather than inventing a cause.
 *
 * ---------------------------------------------------------------------------
 * The lifecycle
 *
 *   ACTIVE_UNACKNOWLEDGED  the alert is outstanding and the voice repeats
 *   ACTIVE_MUTED           the voice is off; the alert is still outstanding
 *   ACKNOWLEDGED           an engineer has said they have seen it
 *
 * Only an explicit acknowledgement ends the spoken alert. Reading the
 * diagnostics does not, dismissing the toast does not, and the deviation
 * clearing does not - an alert that silences itself because the operator
 * happened to open a screen is an alert that can be missed entirely.
 *
 * Muting and acknowledging are deliberately different things. Mute is "not
 * now"; acknowledge is "I have seen this". Turning the voice back on while
 * something is still outstanding resumes it, which is the whole point of the
 * distinction.
 *
 * ACKNOWLEDGED is also not RESOLVED. An engineer confirming they have heard an
 * alert says nothing about whether the cylinder is still deviating, and the
 * interface keeps those two facts apart.
 */

import { create } from 'zustand'
import type { Anomaly, Advisory } from '../types'
import { useSettings } from './useSettings'
import { useTwin } from './useTwin'
import { isSpeaking, phraseFor, silence, speak, voiceStatus } from '../services/voice'

export type Level = 'INFO' | 'WARNING' | 'CRITICAL'
export type AlertState = 'ACTIVE_UNACKNOWLEDGED' | 'ACTIVE_MUTED' | 'ACKNOWLEDGED'

export interface Notification {
  /** Stable for the life of the condition. One continuous deviation is one
   *  alert, however long it runs and however many frames carry it. */
  id: string
  sourceId: string
  level: Level
  title: string
  /** One sentence, from the detector's own summary. */
  body: string
  cylinder: number | null
  /** 0..1, or null where the model abstained. */
  confidence: number | null
  calibrated: boolean
  /** What the detector actually saw. Never a cause. */
  evidence: string
  /** What to check. Absent when the system has not earned a recommendation. */
  action: string | null
  /** The channel the detector flagged - CHT, EGT, RPM. Spoken, so it has to
   *  come from the finding rather than be assumed. */
  parameter: string | null
  trend: string | null
  persistent: boolean

  /** True while the detector is still reporting this deviation. A condition
   *  that clears does not clear the alert - it still has to be acknowledged -
   *  but the interface says which of the two it is. */
  conditionActive: boolean
  acknowledged: boolean
  acknowledgedAt: number | null
  /** How many times the voice has announced it. Drives the wording rotation
   *  and is shown on the alert. */
  announcements: number
  lastSpokenAt: number | null
  /** The most recent sentence spoken for this alert, or null if it has never
   *  been announced. */
  spoken: string | null

  at: number
  read: boolean
}

/** How the detector's severity maps to the three levels an operator scans for. */
function levelOf(severity: string): Level {
  const s = severity?.toUpperCase()
  if (s === 'HIGH' || s === 'CRITICAL') return 'CRITICAL'
  if (s === 'MEDIUM' || s === 'WARNING') return 'WARNING'
  return 'INFO'
}

const RANK: Record<Level, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 }

/**
 * The evidence line.
 *
 * Deliberately a description of the measurement rather than of a fault: a
 * persistent residual across several regimes is a fact, "exhaust valve
 * distress" is a hypothesis, and only the second one needs a qualifier.
 *
 * The residual figure is deliberately absent. The detector's own summary
 * already quotes one, and the two are not always the same statistic - the
 * sentence can be describing a peak while the field carries the current value.
 */
function evidenceOf(a: Anomaly): string {
  const parts: string[] = []
  if (a.trend) parts.push(a.trend.toLowerCase())
  if (a.regime_count > 1) parts.push(`${a.regime_count} operating regimes`)
  if (a.flights > 1) parts.push(`${a.flights} flights`)
  if (a.samples) parts.push(`${a.samples.toLocaleString()} samples`)
  return parts.join(' · ') || 'Deviation from the physics expectation'
}

/**
 * Which channel was flagged.
 *
 * Read off the finding rather than assumed, so an EGT deviation is announced
 * as EGT and a manifold-pressure one is not announced as CHT.
 */
function parameterOf(a: Anomaly): string | null {
  const haystack = `${a.title ?? ''} ${a.subsystem ?? ''}`.toUpperCase()
  const known = ['CHT', 'EGT', 'RPM', 'MANIFOLD PRESSURE', 'OIL PRESSURE', 'OIL TEMPERATURE', 'FUEL FLOW']
  return known.find((k) => haystack.includes(k)) ?? null
}

function actionOf(a: Anomaly, advisories: Advisory[]): string | null {
  const match = advisories.find((adv: any) => adv.cylinder === a.cylinder || adv.anomaly_id === a.id)
  const action = (match as any)?.action
  if (action) return action
  // Without an advisory the console can still say where to look - that is the
  // localisation the detector already published - but not what is wrong.
  return a.cylinder ? `Inspect cylinder ${a.cylinder}` : null
}

const MAX_HISTORY = 60

/* At most three interruptions on screen at once. Beyond that the stack stops
   being an alert and becomes a wall. The rest are in the bell. */
const MAX_TOASTS = 3

/** How often an outstanding alert is re-announced. */
export const REPEAT_MS = 10_000

interface NotificationStore {
  items: Notification[]
  /** Currently on screen as toasts. A subset of `items`. */
  toasts: string[]
  panelOpen: boolean

  /** Fold a new alert frame in. Called once per frame; cheap when nothing has
   *  changed, which is the common case. */
  ingest: (anomalies: Anomaly[], advisories: Advisory[]) => void
  /** Take the toast off screen. Explicitly *not* an acknowledgement: the alert
   *  stays outstanding and the voice keeps going. */
  dismissToast: (id: string) => void
  /** A launch milestone. Informational, and never spoken from here - the
   *  sequencer says those lines itself on the same transition, so the two
   *  cannot drift apart. */
  pushMissionEvent: (text: string, key: string) => void
  /** The one thing that ends a spoken alert. */
  acknowledge: (id: string) => void
  acknowledgeAll: () => void
  markAllRead: () => void
  clear: () => void
  setPanel: (open: boolean) => void
  /** Everything still outstanding, worst first. */
  outstanding: () => Notification[]
}

/** Severity already recorded for a given anomaly, so a deviation that is still
 *  there does not create a second alert - only an escalation reopens it. */
const announced = new Map<string, Level>()

/**
 * The display state of one alert.
 *
 * Muted is a property of the console, not of the alert - one switch silences
 * everything - so it is worked out on read rather than stored per row, which
 * would leave rows disagreeing with the switch.
 */
export function alertState(n: Notification): AlertState {
  if (n.acknowledged) return 'ACKNOWLEDGED'
  const { voiceAlerts } = useSettings.getState()
  return voiceAlerts && voiceStatus() === 'READY' ? 'ACTIVE_UNACKNOWLEDGED' : 'ACTIVE_MUTED'
}

export const useNotifications = create<NotificationStore>((set, get) => ({
  items: [],
  toasts: [],
  panelOpen: false,

  outstanding: () => get().items
    .filter((n) => !n.acknowledged && n.level !== 'INFO')
    .sort((a, b) => RANK[b.level] - RANK[a.level] || a.at - b.at),

  ingest: (anomalies, advisories) => {
    /* Nothing is raised until the aircraft is away.
       A cylinder deviation announced over a pre-flight checklist is noise at
       the one moment the operator is watching something else, and before ENTER
       MISSION there is no sortie for a finding to be about. */
    if (!useTwin.getState().missionLive) return

    const settings = useSettings.getState()
    const live = new Set(anomalies.filter((a) => !a.abstained).map((a) => a.id))
    const existing = get().items
    const fresh: Notification[] = []
    /* Escalations update the alert in place rather than opening a second one -
       one continuous condition is one alert, however loud it gets. */
    const escalated = new Map<string, Level>()

    for (const a of anomalies) {
      // An abstention is the twin declining to call it. That belongs on the
      // Diagnostics screen, not in a notification demanding attention.
      if (a.abstained) continue
      const level = levelOf(a.severity)
      const already = announced.get(a.id)
      if (already !== undefined && RANK[level] <= RANK[already]) continue
      announced.set(a.id, level)

      const open = existing.find((n) => n.sourceId === a.id && !n.acknowledged)
      if (open) {
        escalated.set(open.id, level)
        continue
      }

      fresh.push({
        id: `${a.id}:${Date.now()}`,
        sourceId: a.id,
        level,
        title: a.title,
        body: a.summary,
        cylinder: a.cylinder,
        confidence: a.calibrated ? a.confidence : a.confidence_raw ?? a.confidence,
        calibrated: a.calibrated,
        evidence: evidenceOf(a),
        action: actionOf(a, advisories),
        parameter: parameterOf(a),
        trend: a.trend ?? null,
        persistent: /PERSIST/i.test(a.trend ?? '') || a.flights > 2,
        conditionActive: true,
        acknowledged: false,
        acknowledgedAt: null,
        announcements: 0,
        lastSpokenAt: null,
        spoken: null,
        at: Date.now(),
        read: false,
      })
    }

    /* Every outstanding alert is re-checked against the live set. A deviation
       that clears is marked as such and stays on the board - the engineer
       still has to acknowledge that it happened. */
    let touched = false
    let items = existing.map((n) => {
      const stillLive = n.acknowledged ? n.conditionActive : live.has(n.sourceId)
      const up = escalated.get(n.id)
      if (up === undefined && stillLive === n.conditionActive) return n
      touched = true
      return {
        ...n,
        conditionActive: stillLive,
        // A new severity is a new thing to say, so the rotation restarts.
        ...(up !== undefined ? { level: up, announcements: 0, lastSpokenAt: null, read: false } : null),
      }
    })

    if (fresh.length) items = [...fresh, ...items].slice(0, MAX_HISTORY)
    if (!fresh.length && !escalated.size && !touched) return

    const interrupting = [
      ...fresh.filter((n) => n.level !== 'INFO').map((n) => n.id),
      ...escalated.keys(),
    ]

    set({
      items,
      toasts: settings.notifications && interrupting.length
        ? [...interrupting, ...get().toasts.filter((t) => !interrupting.includes(t))].slice(0, MAX_TOASTS)
        : get().toasts,
    })
  },

  pushMissionEvent: (text, key) => {
    const entry: Notification = {
      id: `mission:${key}:${Date.now()}`,
      sourceId: `mission:${key}`,
      level: 'INFO',
      title: text,
      body: '',
      cylinder: null,
      confidence: null,
      calibrated: true,
      evidence: 'Mission sequence',
      action: null,
      parameter: null,
      trend: null,
      persistent: false,
      conditionActive: true,
      // A milestone is a record, not something to chase: no acknowledgement
      // needed and it never enters the spoken queue.
      acknowledged: true,
      acknowledgedAt: Date.now(),
      announcements: 0,
      lastSpokenAt: null,
      spoken: null,
      at: Date.now(),
      read: false,
    }
    set({ items: [entry, ...get().items].slice(0, MAX_HISTORY) })
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t !== id) }),

  acknowledge: (id) => {
    // Stop mid-sentence. Waiting for the current phrase to finish would mean
    // the console carries on talking after being told it has been heard.
    silence()
    set({
      items: get().items.map((n) => (
        n.id === id ? { ...n, acknowledged: true, acknowledgedAt: Date.now(), read: true } : n
      )),
      toasts: get().toasts.filter((t) => t !== id),
    })
  },

  acknowledgeAll: () => {
    silence()
    const now = Date.now()
    set({
      items: get().items.map((n) => (
        n.acknowledged ? n : { ...n, acknowledged: true, acknowledgedAt: now, read: true }
      )),
      toasts: [],
    })
  },

  markAllRead: () => set({ items: get().items.map((n) => ({ ...n, read: true })) }),

  clear: () => {
    silence()
    announced.clear()
    set({ items: [], toasts: [] })
  },

  setPanel: (open) => {
    if (!open) {
      set({ panelOpen: false })
      return
    }
    /* Opening the panel marks the entries read - it does not acknowledge
       them. Reading a list is not the same as taking responsibility for what
       is on it, and the voice keeps going until somebody says so. */
    get().markAllRead()
    set({ panelOpen: true })
  },
}))

/* --------------------------------------------------------------- the loop -- */

/**
 * One scheduler for the whole console.
 *
 * Not a timer per alert: several outstanding findings would then talk over
 * each other, and a condition that keeps re-arming would stack loops until the
 * console was unusable. A single tick picks the most severe outstanding alert
 * and says one thing.
 *
 * It stays on that alert until it is acknowledged. That is deliberate - the
 * queue is by priority, not a rota, so a critical finding is not interleaved
 * with a warning while it is still outstanding.
 *
 * Every precondition is re-checked at the moment of speaking rather than when
 * the repeat was scheduled: the operator may have muted or acknowledged in
 * between, and a queued sentence that is no longer true is worse than silence.
 */
let loop: number | undefined

function tick() {
  const settings = useSettings.getState()
  if (!settings.voiceAlerts) return          // muted
  if (voiceStatus() !== 'READY') return      // no support, or gate still shut
  if (isSpeaking()) return                   // never two at once

  const target = useNotifications.getState().outstanding()[0]
  if (!target) return

  const since = target.lastSpokenAt === null ? Infinity : Date.now() - target.lastSpokenAt
  if (since < REPEAT_MS) return

  const phrase = phraseFor(
    {
      level: target.level,
      cylinder: target.cylinder,
      parameter: target.parameter,
      trend: target.trend,
      persistent: target.persistent,
    },
    target.announcements,
  )

  if (!speak(phrase, { volume: settings.voiceVolume })) return

  useNotifications.setState({
    items: useNotifications.getState().items.map((n) => (
      n.id === target.id
        ? { ...n, announcements: n.announcements + 1, lastSpokenAt: Date.now(), spoken: phrase }
        : n
    )),
  })
}

/** Start the announcement loop. Mounted once, by the alert feed. */
export function startVoiceLoop() {
  if (loop !== undefined) return
  /* Polled rather than scheduled per alert. The tick is a no-op unless
     something is outstanding and due, so it costs nothing while the engine is
     healthy - which is almost all of the time - and there is exactly one of
     it however many alerts are open. */
  loop = window.setInterval(tick, 1000)
}

export function stopVoiceLoop() {
  if (loop === undefined) return
  window.clearInterval(loop)
  loop = undefined
}

/** Forget what has been announced. Used when the simulation is reset, so a
 *  replayed sortie raises its alerts again rather than staying silent. */
export function resetAnnounced() {
  announced.clear()
}
