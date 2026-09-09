/**
 * The single source of truth for the interface.
 *
 * Frames arrive over four websockets from the ground-station backend. If those
 * cannot be established the store attaches the local transport instead and
 * flips `mode` to DEMO, so every panel keeps rendering and every value on
 * screen is labelled for what it is. Nothing in the UI reads the network
 * directly.
 *
 * What this file does *not* own any more is time. Every timer that advanced
 * simulation state used to live here - a 220 ms interval driving the local
 * model, a watchdog, a status poll - and the one driving the model knew
 * nothing about the paused flag, which is why PAUSE did not pause. The clock
 * now lives in `simulation/SimulationEngine`, this store subscribes to it, and
 * frames that arrive while the simulation is held are dropped at the gate.
 */

import { create } from 'zustand'
import { api, onConnectivity } from '../services/api'
import { connectAll, topicSocket, type SocketState } from '../services/ws'
import {
  LiveTransport, LocalTransport, simulation, type SimulationSnapshot,
} from '../simulation'
import { flightDynamics } from '../components/uav/flight'
import type { OperatorCommand } from '../mission/decision'
import { launchSequencer } from '../mission/launch'
import { useNotifications } from './useNotifications'
import { useSettings } from './useSettings'
import { announce, voiceStatus } from '../services/voice'
import type {
  AlertFrame, Anomaly, EventEntry, MissionFrame, ResidualFrame, Sector,
  SystemStatus, TelemetryFrame,
} from '../types'

export type Mode = 'LIVE' | 'DEMO' | 'CONNECTING'

/** The console's own entry gate. BOOT -> the short startup card; READY -> the
 *  console itself. The full first-entry film is a route (/intro), not a phase:
 *  reaching the console at all means the film is behind us. */
export type IntroPhase = 'BOOT' | 'READY'

/** The persistent 3D stage parks either in the corner card or in the Command
 *  Center hero. Both are the same never-unmounted canvas. */
export type Dock = 'CORNER' | 'HERO'

/**
 * Where the sortie is, as the operator sees it.
 *
 * Distinct from the simulation engine's own status, which describes a
 * transport - is a stream advancing, is it held. This describes the mission:
 * flying the plan, recalled, stopped where it stands, or finished.
 */
export type MissionPhase =
  | 'READY'
  | 'INITIALIZING'
  | 'PRE_FLIGHT'
  | 'PRE_FLIGHT_COMPLETE'
  | 'PRE_FLIGHT_FAILED'
  | 'ENGINE_STARTING'
  | 'ENGINE_READY'
  | 'TAKEOFF'
  | 'CLIMB'
  | 'SAFE_ALTITUDE'
  | 'ACTIVE'
  | 'RETURNING_TO_BASE'
  | 'ABORTED'
  | 'COMPLETED'

const INTRO_KEY = 'aerotwin_intro_seen'

export function introSeen(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) === 'true'
  } catch {
    // Private browsing or a blocked storage partition. Treat as a returning
    // operator rather than forcing the full sequence on every load.
    return true
  }
}

export function markIntroSeen(): void {
  try {
    window.localStorage.setItem(INTRO_KEY, 'true')
  } catch {
    /* nothing to do - the intro simply replays next time */
  }
}

const HISTORY = 240

/** How long to wait for a live frame before concluding there is no backend. */
const LIVE_GRACE_MS = 6000

export interface TrendPoint {
  t: number
  [key: string]: number
}

interface TwinStore {
  mode: Mode
  socketState: SocketState
  status: SystemStatus | null
  telemetry: TelemetryFrame | null
  residuals: ResidualFrame | null
  alerts: AlertFrame | null
  mission: MissionFrame | null
  sector: Sector | null
  log: EventEntry[]

  /** Rolling series for the charts, keyed by channel. */
  history: Record<string, TrendPoint[]>
  healthTrail: Array<{ t: number; health: number }>

  selectedCylinder: number
  selectedAnomaly: string | null
  flightMode: 'DASHBOARD' | 'TRANSITION_OUT' | 'MISSION' | 'TRANSITION_IN'
  cameraMode: string
  /** True while the backend is replaying the compressed demonstration sortie
   *  rather than a routine one. Distinct from the simulation status. */
  demoRunning: boolean
  bootDone: boolean
  /** Entry gate: the cinematic intro, the short boot, then the console. */
  introPhase: IntroPhase
  /** Where the persistent 3D stage is parked when not in mission mode. */
  dock: Dock
  /** The narrated fault story. Step -1 means not running. */
  storyStep: number
  /** Collapsed corner card, so the overlay can never hide a control. */
  cornerCollapsed: boolean

  /** Where the sortie is. */
  missionPhase: MissionPhase
  /** The last command the operator issued, so the console can say what it is
   *  doing *because somebody told it to* rather than on its own initiative. */
  operatorCommand: OperatorCommand
  /** The diversion track, in sector kilometres, once a recall has been
   *  ordered. Drawn on the map so the new route is visibly not the plan. */
  rtbRoute: Array<{ x: number; y: number }> | null
  /** Operator decisions and mission milestones. Kept separate from the
   *  ground station's own event stream, which arrives whole on every frame
   *  and would overwrite anything appended locally. */
  operatorLog: EventEntry[]
  /** The launch status line. */
  missionLabel: string
  /** Set once the aircraft is away. Normal alerting - anomaly toasts and
   *  spoken findings - is held until then, so a launch is not narrated over
   *  by a cylinder deviation. */
  missionLive: boolean
  /** Pre-flight results, by check id. Drives the panel. */
  preflight: Record<string, { state: string; detail?: string }>
  /** Why the launch was refused, when it was. */
  preflightFailure: { label: string; detail: string } | null

  start: () => void
  setCylinder: (index: number) => void
  setAnomaly: (id: string | null) => void
  enterMission: () => void
  exitMission: () => void
  setCameraMode: (mode: string) => void
  setBootDone: (v: boolean) => void
  setIntroPhase: (phase: IntroPhase) => void
  replayIntro: () => void
  setDock: (dock: Dock) => void
  setStoryStep: (step: number) => void
  toggleCorner: () => void
  refreshStatus: () => Promise<void>
  /** Start or resume, whichever the engine's current state calls for. */
  ensureRunning: () => Promise<void>
  /** ENTER MISSION. Runs the pre-flight, the engine start and the climb-out
   *  before anything flies the route. Idempotent. */
  launchMission: () => Promise<void>

  /* Operator commands. Each one changes what the aircraft actually does; none
     of them is only a label. */
  commandContinue: () => void
  commandReturnToBase: () => void
  commandAbort: () => void
  logEvent: (level: string, message: string) => void

  /** Simulation control. Every one of these goes through the engine; nothing
   *  in the UI commands the backend directly. */
  startDemo: () => Promise<void>
  pauseSim: () => Promise<void>
  resumeSim: () => Promise<void>
  /** Pull the frame the twin is holding at. Used after PAUSE and STEP, where
   *  no frame arrives over the socket by design. */
  syncHeldFrame: () => Promise<void>
  /** Release a backend left held by an earlier session. */
  releaseIfHeld: () => Promise<void>
  stopSim: () => Promise<void>
  resetSim: () => Promise<void>
  stepSim: () => Promise<void>
  setSpeed: (speed: number) => Promise<void>

  topAnomaly: () => Anomaly | null
}

let started = false
/** Set once a live frame has been seen, so the grace timer knows not to fall
 *  back and the reconnect path knows which transport belongs in the seat. */
let liveSeen = false
let graceTimer: number | null = null
let statusPoll: number | null = null

const live = new LiveTransport(false)
const liveDemo = new LiveTransport(true)
const local = new LocalTransport()

export const useTwin = create<TwinStore>((set, get) => ({
  mode: 'CONNECTING',
  socketState: 'CLOSED',
  status: null,
  telemetry: null,
  residuals: null,
  alerts: null,
  mission: null,
  sector: null,
  log: [],
  history: {},
  healthTrail: [],
  selectedCylinder: 3,
  selectedAnomaly: null,
  flightMode: 'DASHBOARD',
  cameraMode: 'FOLLOW',
  demoRunning: false,
  bootDone: false,
  introPhase: 'BOOT',
  dock: 'CORNER',
  storyStep: -1,
  cornerCollapsed: false,
  missionPhase: 'READY',
  operatorCommand: 'NONE',
  rtbRoute: null,
  operatorLog: [],
  missionLabel: 'MISSION STANDBY',
  missionLive: false,
  preflight: {},
  preflightFailure: null,

  start: () => {
    if (started) return
    started = true

    const pushHistory = (frame: TelemetryFrame) => {
      const { history, healthTrail } = get()
      const next: Record<string, TrendPoint[]> = { ...history }
      const t = frame.tick.t
      const keys = Object.keys(frame.tick.channels)
      for (const key of keys) {
        const observed = frame.tick.channels[key]
        const expected = frame.tick.expected?.[key]
        const residual = frame.tick.residuals?.[key]?.r
        const series = next[key] ? next[key].slice(-HISTORY + 1) : []
        series.push({
          t,
          observed,
          expected: expected ?? observed,
          residual: residual ?? 0,
        })
        next[key] = series
      }
      // An abstained frame contributes no point. A gap in the trend is the
      // truth; a zero would be a health verdict the twin declined to give.
      const health = frame.engine.health_index
      const trail = health === null || health === undefined
        ? healthTrail
        : [...healthTrail.slice(-HISTORY + 1), { t, health }]
      set({ history: next, healthTrail: trail })
    }

    // -- the local model -------------------------------------------------
    // One listener, fired by the engine's clock and only while it is running.
    // This is the whole of the local feed's timing: it has none of its own.
    simulation.onAdvance(() => {
      if (simulation.transportKind !== 'LOCAL') return
      const frames = local.frames()
      set({
        telemetry: frames.telemetry,
        residuals: frames.residualFrame,
        alerts: frames.alerts,
        mission: frames.mission,
      })
      pushHistory(frames.telemetry)
    })

    // -- live sockets ----------------------------------------------------
    topicSocket('telemetry').subscribe((message) => {
      if (!message?.tick) return
      onLiveFrame()
      // The gate. A frame that arrives after PAUSE - already in flight when
      // the command went out - must not move a single number on screen.
      if (!simulation.observeFrame(message.tick.t)) return
      set({ mode: 'LIVE', telemetry: message as TelemetryFrame })
      pushHistory(message as TelemetryFrame)
    })

    topicSocket('residuals').subscribe((message) => {
      if (!message?.channels) return
      if (simulation.getState().status !== 'running') return
      set({ residuals: message as ResidualFrame })
    })

    topicSocket('alerts').subscribe((message) => {
      if (!message?.anomalies) return
      if (simulation.getState().status !== 'running') return
      set({ alerts: message as AlertFrame })
      if (message.log) set({ log: message.log })
      const current = get().selectedAnomaly
      if (!current && message.anomalies.length) {
        set({ selectedAnomaly: message.anomalies[0].id })
      }
    })

    topicSocket('mission').subscribe((message) => {
      if (!message?.mission) return
      if (simulation.getState().status !== 'running') return
      // The sortie length is only known once the backend has said what it is
      // replaying; until then the progress bar has no honest denominator.
      simulation.setTotalSteps(Number(message.mission?.duration_s) || 0)
      set({ mission: message as MissionFrame })
    })

    topicSocket('telemetry').onState((state) => set({ socketState: state }))

    simulation.attach(live)
    connectAll()

    /** The backend answered. Take the live seat and adopt the sortie already
     *  in progress rather than making the operator press START to see it. */
    function onLiveFrame() {
      if (liveSeen) return
      liveSeen = true
      if (graceTimer !== null) {
        window.clearTimeout(graceTimer)
        graceTimer = null
      }
      simulation.attach(live)
      /* Adopted held, whatever the ground station is doing.
         Opening the console is not a request to fly: the stream is connected
         and the picture is live, but frames are dropped at the gate until
         ENTER MISSION runs the launch. */
      simulation.adopt(Number(get().mission?.mission?.duration_s) || 0, true)
      set({ mode: 'LIVE' })
      // The ground station keeps its paused flag between console sessions, so
      // a pause left over from an earlier one would open this console onto a
      // sortie where nothing moves. Opening it is an intent to watch, so a
      // held stream is released rather than presented frozen.
      void get().releaseIfHeld()
    }

    /** No backend. Hand the seat to the in-browser model so the console is
     *  demonstrable on a static host, and label everything DEMO. */
    function fallBackToLocal() {
      if (liveSeen || simulation.transportKind === 'LOCAL') return
      simulation.attach(local)
      simulation.adopt(local.feed.duration, true)
      set({ mode: 'DEMO' })
    }

    graceTimer = window.setTimeout(() => {
      graceTimer = null
      if (!get().telemetry) fallBackToLocal()
    }, LIVE_GRACE_MS)

    onConnectivity((up) => {
      if (!up && !get().telemetry) fallBackToLocal()
    })

    void get().refreshStatus()
    void api.sector().then((sector) => sector && set({ sector }))
    statusPoll = window.setInterval(() => void get().refreshStatus(), 8000)
  },

  /* ------------------------------------------------------------ launch -- */

  /**
   * ENTER MISSION.
   *
   * Idempotent: the sequencer refuses to begin while it is already running and
   * this refuses to command the transport twice, so five clicks launch one
   * sortie. Every side effect the sequence has - status, checklist,
   * notification, callout, and whether the route may be flown - goes through
   * the one `onPhase` hook below, which is what keeps them from drifting
   * apart.
   */
  launchMission: async () => {
    if (get().missionPhase !== 'READY' || launchSequencer.running) return

    set({
      missionPhase: 'INITIALIZING',
      missionLabel: 'MISSION INITIALIZING',
      preflight: {},
      preflightFailure: null,
    })

    try {
      await get().releaseIfHeld()
      await get().ensureRunning()
      await get().refreshStatus()
    } catch {
      set({ missionPhase: 'READY', missionLabel: 'MISSION STANDBY' })
      return
    }

    const settings = () => useSettings.getState()
    const canSpeak = () => settings().voiceAlerts && voiceStatus() === 'READY'

    launchSequencer.begin({
      context: () => {
        const st = get()
        return {
          telemetry: st.telemetry,
          mission: st.mission,
          alerts: st.alerts,
          status: st.status,
          mode: st.mode,
        }
      },

      // Everything a phase change means, in one place.
      onPhase: (spec) => {
        set({
          missionPhase: spec.phase as MissionPhase,
          missionLabel: spec.label,
          missionLive: spec.phase === 'ACTIVE',
        })
        if (spec.notice) {
          useNotifications.getState().pushMissionEvent(spec.notice, spec.phase)
          get().logEvent('INFO', spec.notice)
        }
        if (spec.say && canSpeak()) announce(spec.say, settings().voiceVolume)
      },

      onCheck: (id, state, detail) => {
        set({ preflight: { ...get().preflight, [id]: { state, detail } } })
      },

      onFailed: (label, detail) => {
        set({
          missionPhase: 'PRE_FLIGHT_FAILED',
          missionLabel: 'PRE-FLIGHT FAILED',
          missionLive: false,
          preflightFailure: { label, detail },
        })
        get().logEvent('CRIT', `Pre-flight failed: ${label} - ${detail}`)
        useNotifications.getState().pushMissionEvent(`Pre-flight failed: ${label}`, 'PREFLIGHT_FAIL')
        if (canSpeak()) announce('Pre-flight check failed. Takeoff is inhibited.', settings().voiceVolume)
        void simulation.pause()
      },

      isRunning: () => simulation.clock.running,
      say: (line) => { if (canSpeak()) announce(line, settings().voiceVolume) },
    })
  },

  /* ---------------------------------------------------------- commands -- */

  /**
   * Make sure the clock is turning.
   *
   * `resume` only lifts a pause - from `idle` or `stopped` it is a no-op by
   * design, because resuming something that was never started is meaningless.
   * An operator command has to work from wherever the console happens to be,
   * including straight after a reset, so this picks the right verb rather than
   * asking the caller to know which one applies.
   */
  ensureRunning: async () => {
    const status = simulation.getState().status
    if (status === 'running' || status === 'starting') return
    if (status === 'paused') { await simulation.resume(); return }
    await simulation.start()
  },

  logEvent: (level, message) => {
    const entry: EventEntry = {
      t: new Date().toISOString(),
      level,
      source: 'OPERATOR',
      message,
    }
    // Newest first, and bounded: this is a mission log, not an audit trail.
    set({ operatorLog: [entry, ...get().operatorLog].slice(0, 60) })
  },

  /**
   * Fly on.
   *
   * Deliberately does not clear anything. The deviation that prompted the
   * decision is still there, the health index still says what it said, and the
   * twin keeps running - continuing is a choice to accept a known risk, not a
   * way of making it go away. All this does is release the aircraft back onto
   * the plan and record who released it.
   */
  commandContinue: () => {
    if (get().missionPhase === 'ABORTED' || get().missionPhase === 'COMPLETED') return
    flightDynamics.frozen = false
    if (flightDynamics.diverted) flightDynamics.restorePlan()
    set({
      missionPhase: 'ACTIVE', operatorCommand: 'CONTINUE', rtbRoute: null,
      missionLabel: 'MISSION ACTIVE', missionLive: true,
    })
    // Continuing from the ground means flying the launch first.
    if (flightDynamics.groundHold && !launchSequencer.running) {
      void get().launchMission()
      return
    }
    get().logEvent('INFO', 'Operator selected CONTINUE TO FLY')
    get().logEvent('INFO', 'UAV continuing planned mission route')
    void get().ensureRunning()
  },

  /**
   * Recall.
   *
   * The diversion is built from where the aircraft actually is, not from the
   * next waypoint - a recall that first flies on to the waypoint it was
   * heading for is not a recall. The track is handed to the map so the new
   * route is visibly not the plan.
   */
  commandReturnToBase: () => {
    const phase = get().missionPhase
    if (phase === 'ABORTED' || phase === 'COMPLETED' || phase === 'RETURNING_TO_BASE') return

    const waypoints = (get().sector?.waypoints ?? []) as Array<{ id: string; x: number; y: number }>
    const base = waypoints.find((w) => w.id === 'BASE') ?? { x: 18, y: 22 }

    flightDynamics.frozen = false
    const legs = flightDynamics.divertToBase({ x: base.x, y: base.y })

    // A recall releases the ground hold: the aircraft is flying home, not
    // still sitting on the launch profile.
    flightDynamics.groundHold = false
    set({
      missionPhase: 'RETURNING_TO_BASE',
      operatorCommand: 'RETURN_TO_BASE',
      rtbRoute: legs.map((l) => ({ x: l.x, y: l.y })),
      missionLabel: 'RETURNING TO BASE',
      missionLive: true,
    })
    get().logEvent('WARN', 'Operator selected RETURN TO BASE')
    get().logEvent('INFO', 'RTB route activated')
    get().logEvent('INFO', 'UAV returning to base')
    void get().ensureRunning()
  },

  /**
   * Stop where you are.
   *
   * Not a pause and not a reset. The aircraft holds its position and every
   * reading keeps the value it had at the moment the command was given, so the
   * final state stays available for whoever has to explain it afterwards.
   *
   * The sortie is *stopped*, not paused. A pause leaves RESUME offered on the
   * toolbar, and an aborted mission that can be resumed from the toolbar was
   * never aborted - the clock would start again and mission-driven telemetry,
   * the fault progression and the timer would all carry on behind a panel
   * reading MISSION ABORTED. Stopping tears the clock down and keeps every
   * computed quantity on screen, which is exactly what an abort has to leave
   * behind: nothing moving, everything readable.
   *
   * A completed sortie is left alone. It is already closed, and re-labelling
   * it as aborted would rewrite the record of how it ended.
   */
  commandAbort: () => {
    const phase = get().missionPhase
    if (phase === 'ABORTED' || phase === 'COMPLETED') return

    /* The launch, if one is still running, goes with it - otherwise the
       sequencer keeps walking its phases behind an aborted mission. Abandoned
       rather than reset: a reset puts the aircraft back on the ground, and an
       abort has to leave it at the altitude it was aborted at. */
    launchSequencer.abandon()
    flightDynamics.frozen = true

    set({
      missionPhase: 'ABORTED', operatorCommand: 'ABORT',
      missionLabel: 'MISSION ABORTED', missionLive: false,
    })

    get().logEvent('CRIT', 'Operator selected ABORT MISSION')
    get().logEvent('CRIT', 'Mission aborted by operator')
    get().logEvent('INFO', 'UAV movement stopped - final state preserved')

    useNotifications.getState().pushMissionEvent('Mission aborted by operator', 'ABORT')
    if (useSettings.getState().voiceAlerts && voiceStatus() === 'READY') {
      announce('Mission aborted by operator.', useSettings.getState().voiceVolume)
    }

    void get().stopSim()
  },

  setCylinder: (index) => set({ selectedCylinder: index }),
  setAnomaly: (id) => set({ selectedAnomaly: id }),
  enterMission: () => {
    if (get().flightMode !== 'DASHBOARD') return
    // The button an operator already reaches for is the one that launches -
    // rather than a second control beside it.
    void get().launchMission()
    set({ flightMode: 'TRANSITION_OUT' })
    window.setTimeout(() => set({ flightMode: 'MISSION', cameraMode: 'CINEMATIC' }), 1500)
  },
  exitMission: () => {
    if (get().flightMode !== 'MISSION') return
    set({ flightMode: 'TRANSITION_IN' })
    window.setTimeout(() => set({ flightMode: 'DASHBOARD', cameraMode: 'FOLLOW' }), 1300)
  },
  setCameraMode: (mode) => set({ cameraMode: mode }),
  setBootDone: (v) => set({ bootDone: v }),

  setIntroPhase: (phase) => {
    markIntroSeen()
    set({ introPhase: phase, bootDone: phase === 'READY' })
  },

  replayIntro: () => {
    // Leaving mission mode first, or the stage would animate its rect while
    // the intro owns the screen. The caller navigates to /intro.
    set({ flightMode: 'DASHBOARD', cameraMode: 'FOLLOW', bootDone: false })
  },

  setDock: (dock) => set({ dock }),

  setStoryStep: (step) => set({ storyStep: step }),
  toggleCorner: () => set((s) => ({ cornerCollapsed: !s.cornerCollapsed })),

  refreshStatus: async () => {
    // Captured before the request goes out. If the operator issues a command
    // while it is in flight, the answer describes a state that no longer
    // exists and must not be allowed to reverse the command.
    const epoch = simulation.commandEpoch
    const status = await api.systemStatus()
    if (!status) return
    set({ status, demoRunning: !!status.demo_active })
    // In LIVE mode the backend owns the clock, so it is the authority on
    // whether anything is advancing. This is what catches a server paused or
    // released from somewhere else - another tab, a restart, a stale session.
    simulation.reconcile(!!status.paused, epoch)
  },

  // -- simulation control -------------------------------------------------

  /**
   * START DEMO.
   *
   * Runs the full start-up sequence against whichever transport is available,
   * and falls back to the local model if the backend refuses or disappears
   * mid-start. It never leaves the operator with a button that did nothing:
   * either the simulation starts, or the failure is on screen with its reason.
   */
  startDemo: async () => {
    set({ history: {}, healthTrail: [], alerts: null })
    if (liveSeen || simulation.transportKind === 'LIVE') {
      simulation.attach(liveDemo)
      await simulation.restart()
      if (simulation.getState().status !== 'error') {
        await get().refreshStatus()
        return
      }
      // The backend went away between the last frame and this command.
      liveSeen = false
    }
    simulation.attach(local)
    set({ mode: 'DEMO' })
    await simulation.restart()
  },

  pauseSim: async () => {
    await simulation.pause()
    // The frame the twin is actually holding at. The websocket will not send
    // another - that is what being held means - so it is pulled once here,
    // and the panels show the sample the index refers to.
    if (simulation.transportKind === 'LIVE') await get().syncHeldFrame()
  },

  resumeSim: async () => {
    await simulation.resume()
    await get().refreshStatus()
  },

  stopSim: async () => {
    await simulation.stop()
    await get().refreshStatus()
  },

  resetSim: async () => {
    await simulation.reset()
    // Everything the operator changed goes back too, or a reset would leave
    // the aircraft recalled and frozen over a fresh sortie.
    flightDynamics.restorePlan()
    set({
      history: {}, healthTrail: [], alerts: null, residuals: null,
      selectedAnomaly: null, demoRunning: false,
      missionPhase: 'READY', operatorCommand: 'NONE', rtbRoute: null, operatorLog: [],
      missionLabel: 'MISSION STANDBY', missionLive: false,
      preflight: {}, preflightFailure: null,
    })
    launchSequencer.reset()
    await get().refreshStatus()
  },

  stepSim: async () => {
    await simulation.step()
    // The backend advanced one sample while held, so the websocket will not
    // push. Pull the frame the step produced.
    if (simulation.transportKind === 'LIVE') await get().syncHeldFrame()
  },

  releaseIfHeld: async () => {
    const status = await api.systemStatus()
    if (!status?.paused) return
    await simulation.release()
    await get().refreshStatus()
  },

  syncHeldFrame: async () => {
    const [frame, residuals, alerts] = await Promise.all([
      api.telemetry(), api.residuals(), api.anomalies(),
    ])
    if (frame?.tick) {
      set({ telemetry: frame as TelemetryFrame })
      pushHistoryExternal(frame as TelemetryFrame)
    }
    if (residuals?.channels) set({ residuals: residuals as ResidualFrame })
    if (alerts?.anomalies) set({ alerts: alerts as AlertFrame })
  },

  setSpeed: async (speed) => {
    await simulation.setSpeed(speed)
    await get().refreshStatus()
  },

  topAnomaly: () => {
    const alerts = get().alerts
    if (!alerts?.anomalies?.length) return null
    const selected = get().selectedAnomaly
    return alerts.anomalies.find((a) => a.id === selected) ?? alerts.anomalies[0]
  },
}))

/** The history push, reachable from an action rather than only from the
 *  socket handler. STEP is the one path that produces a frame without one. */
function pushHistoryExternal(frame: TelemetryFrame) {
  const { history, healthTrail } = useTwin.getState()
  const next: Record<string, TrendPoint[]> = { ...history }
  const t = frame.tick.t
  for (const key of Object.keys(frame.tick.channels)) {
    const series = next[key] ? next[key].slice(-HISTORY + 1) : []
    series.push({
      t,
      observed: frame.tick.channels[key],
      expected: frame.tick.expected?.[key] ?? frame.tick.channels[key],
      residual: frame.tick.residuals?.[key]?.r ?? 0,
    })
    next[key] = series
  }
  const health = frame.engine.health_index
  useTwin.setState({
    history: next,
    healthTrail: health === null || health === undefined
      ? healthTrail
      : [...healthTrail.slice(-HISTORY + 1), { t, health }],
  })
}

/** Release the store's own timers. The engine releases its own. */
export function disposeTwin(): void {
  if (graceTimer !== null) window.clearTimeout(graceTimer)
  if (statusPoll !== null) window.clearInterval(statusPoll)
  graceTimer = null
  statusPoll = null
  simulation.dispose()
  started = false
}

/** Keep a snapshot of the simulation on the store for components that already
 *  subscribe here, without making them import the engine as well. */
export function simulationSnapshot(): SimulationSnapshot {
  return simulation.getState()
}

/** Convenience selectors so components subscribe to the narrowest slice.
 *  Each returns a referentially stable value - zustand v5 re-renders on
 *  identity, so a selector that builds a new array every call spins. */
/**
 * Whether the channels arriving right now were measured.
 *
 * A channel's registry provenance says whether it *can* be measured - that is a
 * property of the contract. Whether it *was* depends on which source has the
 * live seat, and only the source descriptor knows that. Everything that renders
 * a REAL badge has to pass through here, or the badge ends up on the output of
 * the simulator.
 */
export const selectSourceIsReal = (s: TwinStore) =>
  s.telemetry?.source?.provenance === 'REAL'

export const selectCylinders = (s: TwinStore) => s.telemetry?.engine.cylinders
export const selectHealth = (s: TwinStore) => s.telemetry?.engine.health_index ?? null
export const selectPhase = (s: TwinStore) => s.telemetry?.tick.phase ?? 'GROUND'
