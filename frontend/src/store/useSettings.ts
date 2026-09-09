/**
 * Operator preferences.
 *
 * Deliberately separate from `useTwin`. That store owns the aircraft - frames,
 * residuals, the simulation clock - and nothing in it should re-render because
 * somebody changed a theme. This one owns only what the person in front of the
 * screen has asked for, and it is the only store that writes to localStorage.
 *
 * Every setting here does something. A preference that the product ignores is
 * worse than no preference at all, so there is no entry for anything the
 * console cannot actually honour.
 */

import { create } from 'zustand'
import { silence } from '../services/voice'

export type Theme = 'light' | 'dark'

const KEY = 'aerotwin_settings_v1'

export interface Settings {
  theme: Theme
  /** Toast + bell alerts for newly raised anomalies. */
  notifications: boolean
  /** A short tone with a CRITICAL toast. Off by default - a console that makes
   *  noise without being asked is a console people mute permanently. */
  alertSound: boolean
  /** Route transitions, the decorative aircraft, chart tweens. Reduced-motion
   *  at the OS level still wins over this; it can only turn things further
   *  down, never back on. */
  animation: boolean
  /** Spoken announcement of warning and critical findings. Decision-support,
   *  not a certified aircraft warning system. */
  voiceAlerts: boolean
  /** 0..1. Applies to the announcement and the tone that precedes it. */
  voiceVolume: number
  /** Re-announce an unacknowledged CRITICAL once, after a pause. Off by
   *  default: an alert that nags is an alert that gets muted. */
  voiceRepeat: boolean
}

const DEFAULTS: Settings = {
  theme: 'light',
  notifications: true,
  alertSound: false,
  animation: true,
  voiceAlerts: true,
  voiceVolume: 0.85,
  voiceRepeat: false,
}

function load(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const saved = JSON.parse(raw) as Partial<Settings>
    return {
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      notifications: saved.notifications !== false,
      alertSound: saved.alertSound === true,
      animation: saved.animation !== false,
      voiceAlerts: saved.voiceAlerts !== false,
      voiceVolume: typeof saved.voiceVolume === 'number'
        ? Math.max(0, Math.min(1, saved.voiceVolume))
        : DEFAULTS.voiceVolume,
      voiceRepeat: saved.voiceRepeat === true,
    }
  } catch {
    // Private browsing, a blocked storage partition, or corrupted JSON. The
    // console works identically; the choice just does not survive the tab.
    return { ...DEFAULTS }
  }
}

function persist(settings: Settings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* nothing to do - the preference simply lasts as long as the tab */
  }
}

/**
 * Put the theme on the document.
 *
 * `data-theme` is what the token sheet keys off, and `color-scheme` is what
 * tells the browser which form controls, scrollbars and native widgets to
 * draw. Setting only the first leaves white scrollbars on a navy console.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  // Repaint every surface as a dip rather than a flash. The class is removed
  // once the transition has run so it never interferes with hover states.
  root.classList.add('theme-shifting')
  window.setTimeout(() => root.classList.remove('theme-shifting'), 320)
}

interface SettingsStore extends Settings {
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  toggleVoice: () => void
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void
}

const initial = load()

export const useSettings = create<SettingsStore>((setState, get) => ({
  ...initial,

  setTheme: (theme) => {
    applyTheme(theme)
    setState({ theme })
    persist({ ...get(), theme })
  },

  toggleTheme: () => {
    const theme: Theme = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(theme)
  },

  toggleVoice: () => {
    const next = !get().voiceAlerts
    // Turning it off should stop whatever is mid-sentence, not wait it out.
    if (!next) silence()
    get().set('voiceAlerts', next)
  },

  set: (key, value) => {
    setState({ [key]: value } as Pick<Settings, typeof key>)
    persist({ ...get(), [key]: value })
  },
}))

/** Applied before React mounts, so the first paint is already the right theme
 *  and nobody sees a white flash on the way into a dark console. */
export function bootTheme() {
  applyTheme(initial.theme)
  // The class is only wanted for deliberate changes, not the initial paint.
  document.documentElement.classList.remove('theme-shifting')
}

/** True when the dark theme is active. The 3D stages read this to pick a
 *  ground and a light rig; a white studio floor under a navy console blows out
 *  every readout printed over it. */
export function useIsDark(): boolean {
  return useSettings((s) => s.theme === 'dark')
}

/**
 * Whether motion should run.
 *
 * The OS setting is a floor, not a suggestion: if the operator has asked their
 * machine for reduced motion, the preference here cannot turn it back on.
 */
export function motionEnabled(): boolean {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  } catch {
    /* matchMedia unavailable - fall through to the preference */
  }
  return useSettings.getState().animation
}
