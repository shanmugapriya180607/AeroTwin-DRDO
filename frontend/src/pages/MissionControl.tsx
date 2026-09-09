/**
 * Mission control (2D tactical view).
 *
 * The sector picture as a plan view, with the route, the ISR orbit and the
 * live aircraft position. The immersive 3D view is one click away on the
 * corner card; this page is the planner's version of the same picture.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Compass, Maximize2, Navigation } from 'lucide-react'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { flightDynamics } from '../components/uav/flight'
import { OperatorCommand } from '../components/mission/OperatorCommand'
import { PreFlight } from '../components/mission/PreFlight'
import {
  Badge, Empty, Kv, Meter, PageHead, Stat, StatusBadge, clock, fmt, pct,
} from '../components/ui/Primitives'

const VIEW = { w: 220, h: 190, pad: 12 }

function SectorMap({ sector, rtbRoute }: { sector: any; rtbRoute: Array<{ x: number; y: number }> | null }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const uavRef = useRef<SVGGElement>(null)
  const trackRef = useRef<SVGPolylineElement>(null)
  const trail = useRef<Array<[number, number]>>([])

  /* The aircraft marker is driven straight off the flight model each frame,
     the same object the 3D scene integrates. */
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const s = flightDynamics.state
      const x = s.position.x
      const y = VIEW.h - s.position.z
      if (uavRef.current) {
        uavRef.current.setAttribute(
          'transform',
          `translate(${x} ${y}) rotate(${(s.heading * 180) / Math.PI})`,
        )
      }
      const last = trail.current[trail.current.length - 1]
      if (!last || Math.hypot(last[0] - x, last[1] - y) > 1.4) {
        trail.current.push([x, y])
        if (trail.current.length > 260) trail.current.shift()
        trackRef.current?.setAttribute('points', trail.current.map((p) => p.join(',')).join(' '))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const routePoints = useMemo(
    () => (sector?.route ?? []).map((p: any) => `${p.x},${VIEW.h - p.y}`).join(' '),
    [sector],
  )
  const orbitPoints = useMemo(
    () => (sector?.orbit ?? []).map((p: any) => `${p.x},${VIEW.h - p.y}`).join(' '),
    [sector],
  )

  return (
    <svg
      ref={svgRef}
      viewBox={`${-VIEW.pad} ${-VIEW.pad} ${VIEW.w + VIEW.pad * 2} ${VIEW.h + VIEW.pad * 2}`}
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(205,218,234,0.9)" strokeWidth="0.35" />
        </pattern>
        <radialGradient id="isrGlow">
          <stop offset="0%" stopColor="rgba(119,57,224,0.20)" />
          <stop offset="100%" stopColor="rgba(119,57,224,0)" />
        </radialGradient>
      </defs>

      <rect x={-VIEW.pad} y={-VIEW.pad} width={VIEW.w + VIEW.pad * 2} height={VIEW.h + VIEW.pad * 2} fill="#f7fafd" />
      <rect x="0" y="0" width={VIEW.w} height={VIEW.h} fill="url(#grid)" />
      <rect x="0" y="0" width={VIEW.w} height={VIEW.h} fill="none" stroke="#cddaea" strokeWidth="0.5" />

      {/* ISR zone */}
      {sector?.waypoints?.filter((w: any) => w.kind === 'ISR').map((w: any) => (
        <g key={w.id}>
          <circle
            cx={w.x}
            cy={VIEW.h - w.y}
            r={sector.orbit_radius_km ?? 18}
            fill="url(#isrGlow)"
            stroke="rgba(119,57,224,0.45)"
            strokeWidth="0.5"
          />
        </g>
      ))}

      {/* planned route */}
      <polyline
        points={routePoints}
        fill="none"
        stroke="rgba(10,110,214,0.34)"
        strokeWidth="0.7"
        strokeDasharray="2.2 1.6"
      />
      <polyline points={orbitPoints} fill="none" stroke="rgba(119,57,224,0.5)" strokeWidth="0.6" />

      {/* the diversion, when one has been ordered */}
      {rtbRoute && rtbRoute.length > 1 && (
        <g>
          <polyline
            points={rtbRoute.map((p) => `${p.x},${VIEW.h - p.y}`).join(' ')}
            fill="none"
            stroke="rgba(217,154,0,0.9)"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          <text
            x={(rtbRoute[0].x + rtbRoute[1].x) / 2 + 2}
            y={VIEW.h - (rtbRoute[0].y + rtbRoute[1].y) / 2 - 2}
            fontSize="3.4"
            fill="#8a6200"
            fontWeight="700"
            letterSpacing="0.3"
          >
            RTB
          </text>
        </g>
      )}

      {/* flown track */}
      <polyline ref={trackRef} points="" fill="none" stroke="rgba(11,26,46,0.5)" strokeWidth="0.65" />

      {/* waypoints */}
      {(sector?.waypoints ?? []).map((w: any) => {
        const color = w.kind === 'ISR' ? '#7739e0' : w.kind === 'BASE' ? '#0aa06e' : '#0a6ed6'
        return (
          <g key={w.id}>
            {w.kind === 'BASE' ? (
              <rect x={w.x - 2} y={VIEW.h - w.y - 2} width="4" height="4" fill="none" stroke={color} strokeWidth="0.7" />
            ) : (
              <circle cx={w.x} cy={VIEW.h - w.y} r="1.9" fill="none" stroke={color} strokeWidth="0.7" />
            )}
            <circle cx={w.x} cy={VIEW.h - w.y} r="0.6" fill={color} />
            <text
              x={w.x + 3.4}
              y={VIEW.h - w.y + 1.4}
              fill="#5a7089"
              fontSize="3.4"
              fontFamily="JetBrains Mono, monospace"
              letterSpacing="0.2"
            >
              {w.label}
            </text>
          </g>
        )
      })}

      {/* aircraft */}
      <g ref={uavRef}>
        <path d="M 0 -3.4 L 2.4 3 L 0 1.8 L -2.4 3 Z" fill="#0b1a2e" stroke="#0a6ed6" strokeWidth="0.4" />
        <circle r="6.5" fill="none" stroke="rgba(10,110,214,0.28)" strokeWidth="0.35" />
      </g>
    </svg>
  )
}

export default function MissionControl() {
  const mission = useTwin((s) => s.mission)
  const telemetry = useTwin((s) => s.telemetry)
  const sector = useTwin((s) => s.sector)
  const enterMission = useTwin((s) => s.enterMission)
  const rtbRoute = useTwin((s) => s.rtbRoute)
  const missionPhase = useTwin((s) => s.missionPhase)
  const diverted = missionPhase === 'RETURNING_TO_BASE' || missionPhase === 'COMPLETED'

  const [sectorData, setSectorData] = useState<any>(sector)

  useEffect(() => {
    if (sector) {
      setSectorData(sector)
      return
    }
    void api.sector().then((data) => data && setSectorData(data))
  }, [sector])

  const engine = telemetry?.engine
  const position = mission?.mission?.position
  /* Sampled once per render rather than per frame: this panel re-renders on
     each telemetry frame, which is often enough for a descent to read as one
     without putting the whole page on the animation loop. */
  const base = (sectorData?.waypoints ?? []).find((w: any) => w.id === 'BASE') ?? { x: 18, y: 22 }
  const air = diverted
    ? {
      altitudeFt: flightDynamics.state.altitudeFt,
      speedKt: flightDynamics.state.speedKt,
      heading: ((flightDynamics.state.heading * 180) / Math.PI + 360) % 360,
      /* The ground station is still flying its own sortie and its idea of the
         range home is the plan's, not the recall's - so under a diversion this
         comes off the flight model like everything else on this panel. A
         distance to base that ignores the recall is the one number an operator
         would use to decide whether the recall was working. */
      distanceToBaseKm: flightDynamics.distanceTo(base.x, base.y),
    }
    : {
      altitudeFt: mission?.altitude_ft ?? 0,
      speedKt: mission?.ias_kt ?? 0,
      heading: position?.heading ?? 0,
      distanceToBaseKm: position?.distance_to_base_km ?? 0,
    }
  const waypoints = sectorData?.waypoints ?? []

  return (
    <>
      <PageHead
        title="Mission Control"
        sub={sectorData?.note ?? 'Fictional training area. Positions are reported as a local sector grid reference, not as geographic coordinates.'}
        actions={
          <div className="row row--tight">
            <Badge tone="info">{sectorData?.classification ?? 'UNCLASSIFIED / TRAINING'}</Badge>
            <button className="btn btn--primary btn--sm" onClick={enterMission}>
              <Maximize2 size={12} /> Enter 3D mission view
            </button>
          </div>
        }
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(300px, 1fr)', marginBottom: 16 }}>
        <section className="panel" style={{ minHeight: 470 }}>
          <header className="panel__head">
            <Compass size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">{sectorData?.name ?? 'TRAINING SECTOR ALPHA'}</h2>
            <span className="panel__spacer" />
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-4)' }}>
              {position?.grid ?? '—'}
            </span>
          </header>
          <div className="panel__body panel__body--flush" style={{ minHeight: 400 }}>
            {sectorData
              ? <SectorMap sector={sectorData} rtbRoute={rtbRoute} />
              : <div className="skeleton" style={{ height: 400 }} />}
          </div>
        </section>

        <div className="stack">
          {/* Shown only while the sortie is being launched; it removes itself
              once the aircraft is away and the operator panel takes over. */}
          <PreFlight />
          <OperatorCommand />

          <section className="panel">
            <header className="panel__head">
              <Navigation size={13} color="var(--accent-ink)" />
              <h2 className="panel__title">Flight state</h2>
              <span className="panel__spacer" />
              <Badge tone={diverted ? 'caution' : 'ok'} dot live>
                {diverted ? 'RTB' : telemetry?.tick?.phase ?? '—'}
              </Badge>
            </header>
            <div className="panel__body">
              <div className="grid grid--2" style={{ gap: 14 }}>
                {/* Under a recall the aircraft is flying a profile the ground
                    station does not know about, so these come off the flight
                    model. Anywhere else the telemetry is the authority. */}
                <Stat k="Altitude" v={Math.round(air.altitudeFt).toLocaleString()} unit="ft" />
                <Stat k="IAS" v={fmt(air.speedKt, 0)} unit="kt" />
                <Stat k="Heading" v={fmt(air.heading, 0)} unit="°" />
                <Stat k="RPM" v={(mission?.rpm ?? 0).toLocaleString()} />
                <Stat k="OAT" v={fmt(mission?.oat_c, 1)} unit="°C" />
                <Stat k="Power" v={fmt(mission?.power_pct, 0)} unit="%" />
              </div>
              <div className="divider" />
              <Kv
                items={[
                  ['Current leg', diverted ? 'DIRECT TO BASE' : position?.leg ?? '—'],
                  ['Distance to base', `${fmt(air.distanceToBaseKm, 1)} km`],
                  ['Elapsed', clock(mission?.mission?.elapsed_s)],
                  ['Planned', clock(mission?.mission?.duration_s)],
                ]}
              />
              <div style={{ marginTop: 12 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                  <span className="micro">MISSION PROGRESS</span>
                  <span className="mono" style={{ fontSize: 12.5 }}>{pct(mission?.mission?.progress ?? 0, 1)}</span>
                </div>
                <Meter value={(mission?.mission?.progress ?? 0) * 100} tall />
              </div>
            </div>
          </section>

          <section className="panel">
            <header className="panel__head">
              <h2 className="panel__title">Propulsion</h2>
              <span className="panel__spacer" />
              <StatusBadge status={engine?.status} />
            </header>
            <div className="panel__body">
              <Stat
                k="Engine health index"
                v={fmt(engine?.health_index, 1)}
                size="lg"
                tone={
                  (engine?.health_index ?? 100) >= 92 ? 'ok'
                    : (engine?.health_index ?? 100) >= 80 ? 'caution' : 'warn'
                }
                note={engine?.reason}
              />
              <div style={{ marginTop: 10 }}>
                <Meter
                  value={engine?.health_index ?? 0}
                  tone={
                    (engine?.health_index ?? 100) >= 92 ? 'ok'
                      : (engine?.health_index ?? 100) >= 80 ? 'caution' : 'warn'
                  }
                  tall
                />
              </div>
              <div className="divider" />
              <Kv
                items={[
                  ['Twin sync', `${fmt(engine?.sync_pct, 2)}%`],
                  ['Regime', telemetry?.tick?.regime ?? '—'],
                  ['Anomalies', String(engine?.anomaly_count ?? 0)],
                  ['Advisories', String(engine?.advisory_count ?? 0)],
                ]}
              />
            </div>
          </section>
        </div>
      </div>

      <section className="panel" style={{ marginRight: 372 }}>
        <header className="panel__head">
          <h2 className="panel__title">Route plan</h2>
                  </header>
        <div className="panel__body panel__body--flush">
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Waypoint</th>
                <th>Type</th>
                <th className="num">Grid</th>
                <th>Note</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {waypoints.map((w: any) => {
                const active = position?.leg?.includes(w.label)
                return (
                  <tr key={w.id}>
                    <td className="mono">{w.label}</td>
                    <td>
                      <Badge tone={w.kind === 'ISR' ? 'residual' : w.kind === 'BASE' ? 'ok' : 'info'}>{w.kind}</Badge>
                    </td>
                    <td className="num">{w.grid}</td>
                    <td style={{ color: 'var(--ink-4)', whiteSpace: 'normal' }}>{w.note}</td>
                    <td>{active ? <Badge tone="ok" dot live>ACTIVE LEG</Badge> : <span className="dimmer">—</span>}</td>
                  </tr>
                )
              })}
              {!waypoints.length && (
                <tr><td colSpan={5}><Empty label="Sector plan unavailable" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
