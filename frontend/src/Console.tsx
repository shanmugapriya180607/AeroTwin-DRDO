/**
 * The console.
 *
 * The twelve operator screens, the shared 3D stage, the corner card, the
 * mission HUD and the narrated demonstration.
 *
 * This lives in its own chunk on purpose. It statically imports the 3D stage
 * and, through the pages, the chart stack - well over a megabyte of JavaScript
 * that the two cinematic routes have no use for. Keeping it out of the entry
 * is what lets the first paint happen before any of it has arrived.
 */

import { Suspense, lazy, useCallback, useEffect, useRef } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useTwin } from './store/useTwin'
import { NavRail, TopBar } from './components/layout/Shell'
import { CornerUav } from './components/uav/CornerUav'
import { UavStage } from './components/uav/UavStage'
import { MissionHud } from './components/mission/MissionHud'
import { BootSequence } from './components/cinematic/BootSequence'
import { DemoControls } from './components/dashboard/DemoControls'
import { DemoStory } from './components/demo/DemoStory'
import { AlertFeed, AlertToasts } from './components/alerts/AlertCenter'
import { Loading } from './components/ui/Primitives'

const CommandCenter = lazy(() => import('./pages/CommandCenter'))
const DigitalTwin = lazy(() => import('./pages/DigitalTwin'))
const EngineHealth = lazy(() => import('./pages/EngineHealth'))
const Telemetry = lazy(() => import('./pages/Telemetry'))
const Anomalies = lazy(() => import('./pages/Anomalies'))
const Prognostics = lazy(() => import('./pages/Prognostics'))
const Maintenance = lazy(() => import('./pages/Maintenance'))
const Simulation = lazy(() => import('./pages/Simulation'))
const MissionControl = lazy(() => import('./pages/MissionControl'))
const Architecture = lazy(() => import('./pages/Architecture'))
const DataModels = lazy(() => import('./pages/DataModels'))
const Dataset = lazy(() => import('./pages/Dataset'))
const Validation = lazy(() => import('./pages/Validation'))
const FlightReplay = lazy(() => import('./pages/FlightReplay'))
const Reports = lazy(() => import('./pages/Reports'))
const Settings = lazy(() => import('./pages/Settings'))

/**
 * Route change is a camera move, not a cut.
 *
 * Each screen enters from the direction of the subject it is about: the twin
 * and the engine push in toward the machine, the mission screens pull out
 * toward the sector, the reference screens slide laterally.
 */
const ENTRY: Record<string, { x?: number; y?: number; scale?: number }> = {
  '/': { y: 10, scale: 0.996 },
  '/dashboard': { y: 10, scale: 0.996 },
  '/twin': { scale: 0.965 },
  '/engine': { scale: 0.965 },
  '/telemetry': { y: 12 },
  '/anomalies': { y: 12 },
  '/prognostics': { y: 12 },
  '/maintenance': { scale: 0.972 },
  '/simulation': { scale: 1.028 },
  '/mission': { scale: 1.035 },
  '/replay': { y: 12 },
  '/reports': { x: 22 },
  '/settings': { x: 22 },
  '/architecture': { x: 22 },
  '/data': { x: 22 },
  '/dataset': { x: 22 },
  '/validation': { x: 22 },
}

function PageFrame({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const entry = ENTRY[location.pathname] ?? { y: 10 }

  return (
    <motion.div
      key={location.pathname}
      initial={{ opacity: 0, filter: 'blur(5px)', ...entry }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** A single instrument sweep across the screen when the route changes. */
function RouteSweep() {
  const location = useLocation()
  return (
    <AnimatePresence>
      <motion.div
        key={location.pathname}
        className="route-sweep"
        initial={{ opacity: 0.5, scaleX: 0 }}
        animate={{ opacity: 0, scaleX: 1 }}
        transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
      />
    </AnimatePresence>
  )
}

export default function Console() {
  const introPhase = useTwin((s) => s.introPhase)
  const setIntroPhase = useTwin((s) => s.setIntroPhase)
  const flightMode = useTwin((s) => s.flightMode)
  /* The narrated demonstration takes the fullscreen frame for itself. Its own
     chrome replaces the mission HUD, which would otherwise fight it for the
     same four corners. */
  const storyRunning = useTwin((s) => s.storyStep) >= 0
  const location = useLocation()
  const navigate = useNavigate()
  const cardRef = useRef<HTMLDivElement>(null)

  /* Stable identities. The card times itself, and a callback that changes on
     every telemetry frame is a timer that never fires. */
  const bootDone = useCallback(() => setIntroPhase('READY'), [setIntroPhase])
  const replayIntro = useCallback(() => navigate('/intro'), [navigate])

  const inMission = flightMode === 'MISSION' || flightMode === 'TRANSITION_OUT'
  const dashboardVisible = flightMode === 'DASHBOARD' || flightMode === 'TRANSITION_IN'

  /* The route drives the ambient wash behind the console, so moving between
     screens reads as moving between environments. */
  useEffect(() => {
    document.body.dataset.route = location.pathname
  }, [location.pathname])

  return (
    <>
      {introPhase === 'BOOT' && (
        <BootSequence onDone={bootDone} onReplay={replayIntro} />
      )}

      {/* The dashboard recedes rather than disappearing, so the UAV reads as
          flying past it rather than replacing it. */}
      <motion.div
        className="shell"
        animate={{
          opacity: inMission ? 0 : 1,
          scale: inMission ? 1.06 : 1,
          filter: inMission ? 'blur(9px)' : 'blur(0px)',
        }}
        transition={{ duration: inMission ? 1.1 : 0.75, ease: [0.22, 1, 0.36, 1] }}
        style={{ pointerEvents: inMission ? 'none' : 'auto' }}
        aria-hidden={inMission}
      >
        <TopBar actions={<DemoControls />} />
        <NavRail />
        <main className="shell__main">
          <RouteSweep />
          <Suspense fallback={<Loading height={280} />}>
            <PageFrame>
              <Routes>
                <Route path="/dashboard" element={<CommandCenter />} />
                <Route path="/twin" element={<DigitalTwin />} />
                <Route path="/engine" element={<EngineHealth />} />
                <Route path="/telemetry" element={<Telemetry />} />
                <Route path="/anomalies" element={<Anomalies />} />
                <Route path="/prognostics" element={<Prognostics />} />
                <Route path="/maintenance" element={<Maintenance />} />
                <Route path="/simulation" element={<Simulation />} />
                <Route path="/mission" element={<MissionControl />} />
                <Route path="/architecture" element={<Architecture />} />
                <Route path="/data" element={<DataModels />} />
                <Route path="/dataset" element={<Dataset />} />
                <Route path="/validation" element={<Validation />} />
                <Route path="/replay" element={<FlightReplay />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<CommandCenter />} />
              </Routes>
            </PageFrame>
          </Suspense>
        </main>
      </motion.div>

      {/* The frame for the shared 3D stage. Hidden in mission mode, but the
          stage under it never unmounts. */}
      <CornerUav ref={cardRef} hidden={!dashboardVisible} />

      <UavStage cardRef={cardRef} />

      <AnimatePresence>
        {flightMode === 'MISSION' && !storyRunning && <MissionHud />}
      </AnimatePresence>

      {/* Turns alert frames into events, and puts the urgent ones on screen.
          Both sit outside the shell so a fullscreen mission or the narrated
          demonstration cannot hide a critical finding. */}
      <AlertFeed />
      <AlertToasts />

      <DemoStory />
    </>
  )
}
