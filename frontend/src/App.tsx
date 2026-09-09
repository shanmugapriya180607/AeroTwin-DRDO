/**
 * The router, and nothing else.
 *
 * Every experience below is lazy. That is deliberate: the console statically
 * imports the 3D stage and the chart stack, and the two cinematic routes carry
 * a renderer and a scene each. Anything imported here would land in the entry
 * chunk and have to arrive before React could mount at all - which is the
 * difference between a branded first paint and a blank page while a megabyte
 * of JavaScript streams in.
 *
 * So this file imports the store, the router and a splash made of one SVG.
 */

import { Suspense, lazy, useEffect, useRef } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { introSeen, useTwin } from './store/useTwin'
import { RenderBoundary } from './components/ui/Boundary'
import { Splash } from './components/brand/Splash'

const IntroExperience = lazy(() =>
  import('./components/intro/IntroExperience').then((m) => ({ default: m.IntroExperience })),
)
const HowItWorks = lazy(() => import('./pages/HowItWorks'))
const UavShowcase = lazy(() => import('./pages/UavShowcase'))
const Console = lazy(() => import('./Console'))

/** The film. Entering it hands over to the aircraft showcase. */
function IntroRoute() {
  const navigate = useNavigate()
  const setIntroPhase = useTwin((s) => s.setIntroPhase)

  return (
    <RenderBoundary label="intro">
      <Suspense fallback={<Splash />}>
        <IntroExperience
          onEnter={() => {
            setIntroPhase('READY')
            /* First entry runs film -> method -> aircraft -> console. Each
               step carries its own way out, so nobody is held here. */
            navigate('/how')
          }}
        />
      </Suspense>
    </RenderBoundary>
  )
}

/** The method, between the film and the aircraft. */
function HowRoute() {
  return (
    <Suspense fallback={<Splash />}>
      <HowItWorks />
    </Suspense>
  )
}

function ShowcaseRoute() {
  return (
    <Suspense fallback={<Splash />}>
      <UavShowcase />
    </Suspense>
  )
}

function ConsoleRoute() {
  return (
    <Suspense fallback={<Splash />}>
      <Console />
    </Suspense>
  )
}

export default function App() {
  const start = useTwin((s) => s.start)
  const navigate = useNavigate()
  const location = useLocation()

  /* The twin streams from the moment the tab opens, whichever experience is
     on screen: the showcase reads the same numbers the console does. */
  useEffect(() => {
    start()
  }, [start])

  /* The entry gate.
   *
   * A first-time visitor gets the whole film; anyone who has seen it lands on
   * the console. This is a redirect rather than a route of its own on purpose:
   * a `/` route would unmount the console every time something navigated home,
   * taking the never-unmounted 3D stage and the flight model with it. */
  const gated = useRef(false)
  useEffect(() => {
    if (gated.current) return
    gated.current = true
    if (location.pathname === '/' && !introSeen()) navigate('/intro', { replace: true })
  }, [location.pathname, navigate])

  return (
    <Routes>
      <Route path="/intro" element={<IntroRoute />} />
      <Route path="/how" element={<HowRoute />} />
      <Route path="/uav" element={<ShowcaseRoute />} />
      <Route path="*" element={<ConsoleRoute />} />
    </Routes>
  )
}
