/**
 * Spoken alerts.
 *
 * A second channel for a finding the console has already made visually. An
 * engineer watching the residual chart is not watching the alert list, and a
 * cylinder that has just crossed the evidence bar is exactly the moment they
 * are looking somewhere else.
 *
 * Built on the browser's own SpeechSynthesis. That is a deliberate choice for
 * a prototype: no external voice service, no key to leak, no network round
 * trip, and it keeps working with the ground station offline - which is the
 * mode this console has to survive in anyway.
 *
 * What it will not do:
 *   - speak anything the detector has not raised;
 *   - speak a cause. It reports the measurement and the cylinder, because
 *     that is what the twin actually knows;
 *   - repeat itself. One announcement per finding, and an escalation counts
 *     as a new finding. An alert that nags is an alert that gets muted.
 *
 * This is decision-support, not a certified aircraft warning system, and the
 * wording is kept plain for that reason: it tells an engineer what to look at,
 * it does not issue a flight instruction.
 */

export type VoiceLevel = 'INFO' | 'WARNING' | 'CRITICAL'

export interface VoiceRequest {
  level: VoiceLevel
  cylinder: number | null
  /** CHT, EGT, RPM ... whatever the detector actually flagged. */
  parameter: string | null
  /** The detector's own trend word, lower-cased for speech. */
  trend: string | null
  persistent: boolean
}

/* ------------------------------------------------------------ capability -- */

export type VoiceStatus = 'READY' | 'LOCKED' | 'UNAVAILABLE'

function synth(): SpeechSynthesis | null {
  try {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
      ? window.speechSynthesis
      : null
  } catch {
    return null
  }
}

export function voiceSupported(): boolean {
  return synth() !== null && typeof window !== 'undefined' && 'SpeechSynthesisUtterance' in window
}

/*
 * Browsers will not speak until the page has been interacted with, and they
 * do not tell you which state you are in - a blocked utterance simply never
 * fires `start`. So the gate is tracked here: the first real gesture unlocks
 * it, and until then the UI says so rather than silently failing.
 */
let unlocked = false
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((fn) => fn())
}

export function onVoiceStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function voiceStatus(): VoiceStatus {
  if (!voiceSupported()) return 'UNAVAILABLE'
  return unlocked ? 'READY' : 'LOCKED'
}

/** Marks the audio gate open. Called from any deliberate user gesture. */
export function unlockVoice() {
  if (unlocked || !voiceSupported()) return
  unlocked = true
  notify()
}

if (typeof window !== 'undefined') {
  const open = () => unlockVoice()
  window.addEventListener('pointerdown', open, { once: true, passive: true })
  window.addEventListener('keydown', open, { once: true })
}

/* ---------------------------------------------------------------- voice -- */

/**
 * Pick something calm and intelligible.
 *
 * Novelty and whispering voices are filtered out - this is read out over an
 * engine bay, not a podcast - and an English locale is preferred so the
 * cylinder numbers are pronounced as numbers.
 */
function pickVoice(): SpeechSynthesisVoice | null {
  const s = synth()
  if (!s) return null
  const voices = s.getVoices()
  if (!voices.length) return null
  const usable = voices.filter((v) => /^en(-|_|$)/i.test(v.lang) && !/novelty|whisper|bad|zarvox|albert/i.test(v.name))
  const pool = usable.length ? usable : voices
  const preferred = pool.find((v) => /google uk english female|samantha|microsoft (aria|libby|sonia)/i.test(v.name))
  return preferred ?? pool.find((v) => v.localService) ?? pool[0]
}

/* ----------------------------------------------------------------- tone -- */

/**
 * The attention tone before the words.
 *
 * Two soft notes, a quarter of a second, well under the level of a siren. It
 * exists so the first syllable is not the thing that has to get noticed.
 */
function tone(volume: number) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(784, ctx.currentTime)
    osc.frequency.setValueAtTime(1046, ctx.currentTime + 0.11)
    const peak = Math.max(0.0002, Math.min(0.12, volume * 0.12))
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.26)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.28)
    osc.onended = () => ctx.close().catch(() => {})
  } catch {
    /* No audio device or a blocked context. The words still go out. */
  }
}

/* -------------------------------------------------------------- phrasing -- */

/**
 * Build the announcement from what was actually detected.
 *
 * Every part is a value from the anomaly - the cylinder, the channel, the
 * trend - so cylinder 1 and cylinder 4 read correctly without any of this
 * knowing they exist. Short sentences: this is read aloud, and a subordinate
 * clause is lost by the time it arrives.
 *
 * `cycle` is how many times this alert has already been announced. An
 * unacknowledged alert repeats, and repeating one identical sentence every ten
 * seconds is the fastest way to turn an alert into wallpaper - so the wording
 * moves through a short rotation. The facts do not change; only the sentence
 * carrying them does.
 */
export function phraseFor(req: VoiceRequest, cycle = 0): string {
  const where = req.cylinder ? `Cylinder ${req.cylinder}` : 'Engine'
  const param = req.parameter ? `${req.parameter} ` : ''
  const lower = where.toLowerCase()

  if (req.level === 'CRITICAL') {
    const lines = [
      req.persistent
        ? `Critical alert. ${where} shows a persistent abnormal ${param}condition. Immediate inspection is recommended.`
        : `Critical alert. ${where} ${param}abnormality detected. Inspect ${lower}.`,
      `Critical alert. ${where} remains abnormal. Inspection is recommended.`,
      `Attention. ${where} requires inspection.`,
    ]
    return lines[cycle % lines.length]
  }

  if (req.level === 'WARNING') {
    const lines = [
      req.trend
        ? `Warning. ${where} shows an abnormal ${param}residual trend.`
        : `Warning. ${where} ${param}abnormality detected.`,
      `Warning. ${where} shows an abnormal condition.`,
      `Attention. ${where} requires inspection.`,
    ]
    return lines[cycle % lines.length]
  }

  return `Attention. ${where} ${param}residual deviation noted.`
}

/* ------------------------------------------------------------- speaking -- */

let current: SpeechSynthesisUtterance | null = null

export interface SpeakOptions {
  volume: number
  withTone?: boolean
}

/**
 * Say it once.
 *
 * Returns false when nothing was spoken - no support, or the audio gate is
 * still shut - so the caller can say so on screen instead of assuming the
 * operator heard something they did not.
 */
export function speak(text: string, { volume, withTone = true }: SpeakOptions): boolean {
  const s = synth()
  if (!s || !voiceSupported()) return false
  if (!unlocked) return false

  try {
    // A queued backlog is worse than silence: the newest finding is the one
    // worth hearing, so anything still speaking is dropped.
    s.cancel()
    if (withTone) tone(volume)

    const utter = new SpeechSynthesisUtterance(text)
    const voice = pickVoice()
    if (voice) utter.voice = voice
    utter.lang = voice?.lang ?? 'en-GB'
    utter.volume = Math.max(0, Math.min(1, volume))
    utter.rate = 1.0
    utter.pitch = 1.0
    current = utter
    utter.onend = () => { if (current === utter) current = null }
    // The tone runs first, so the words start just behind it.
    window.setTimeout(() => s.speak(utter), withTone ? 260 : 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether the voice is mid-sentence.
 *
 * The repeat loop checks this before it opens its mouth: two announcements
 * talking over each other is worse than a late one, and `speechSynthesis`
 * will happily queue them.
 */
export function isSpeaking(): boolean {
  try {
    const s = synth()
    return !!s && (s.speaking || s.pending || current !== null)
  } catch {
    return false
  }
}

/** Stop whatever is being said. Used on acknowledgement. */
export function silence() {
  try {
    synth()?.cancel()
    current = null
  } catch {
    /* nothing to stop */
  }
}

/**
 * Say one prepared line.
 *
 * The launch callouts are not findings - no cylinder, no residual, no severity
 * - so they do not go through `phraseFor`. Same gate though: if the browser
 * will not let us speak this returns false and the sequence carries on
 * silently rather than pretending it was heard.
 */
export function announce(text: string, volume: number): boolean {
  return speak(text, { volume, withTone: false })
}

/** A sample announcement, for the Test control in Settings. */
export function speakTest(volume: number): boolean {
  return speak('Voice alerts are working. This is a test announcement.', { volume })
}
