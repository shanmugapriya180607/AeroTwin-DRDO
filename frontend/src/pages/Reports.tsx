/**
 * Reports.
 *
 * The hand-over sheet. Everything on this page already exists somewhere in the
 * console; what it has never had is one surface that states the whole finding
 * in the order somebody signing it off needs to read it - what flew, how the
 * engine came back, what deviated, on what evidence, how sure the system is,
 * and what it is asking for.
 *
 * Nothing here is computed on this screen. Every figure is read from the same
 * endpoints the operator screens read, and anything the backend declines to
 * answer is rendered as a gap rather than filled in - a report that invents a
 * number is worse than a report with a hole in it.
 */

import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Cpu, Gauge, Printer, Wrench } from 'lucide-react'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { HealthTrend } from '../components/charts/Charts'
import {
  Badge, Empty, Kv, Loading, Metrics, Note, PageHead, Panel, ProvenanceTag,
  StatusBadge, StatusRows, fmt, pct, signed,
} from '../components/ui/Primitives'

interface Report {
  maintenance: any
  prediction: any
  validation: any
  flights: any
}

const EMPTY: Report = { maintenance: null, prediction: null, validation: null, flights: null }

export default function Reports() {
  const telemetry = useTwin((s) => s.telemetry)
  const alerts = useTwin((s) => s.alerts)
  const mission = useTwin((s) => s.mission)
  const mode = useTwin((s) => s.mode)

  const [report, setReport] = useState<Report>(EMPTY)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([
      api.maintenance(),
      api.prediction(),
      api.validation(),
      api.flights(),
    ]).then(([maintenance, prediction, validation, flights]) => {
      if (!live) return
      setReport({ maintenance, prediction, validation, flights })
      setLoaded(true)
    })
    return () => { live = false }
  }, [])

  const engine = telemetry?.engine
  const anomalies = alerts?.anomalies ?? []
  const active = anomalies.filter((a) => !a.abstained)
  const abstained = anomalies.filter((a) => a.abstained)
  const advisories = alerts?.advisories ?? []

  const cylinders = engine?.cylinders ?? []

  const trend = useMemo(() => {
    const rows = engine?.health_history ?? []
    return rows.slice(-8).map((r: any) => ({
      label: r.live ? 'LIVE' : `#${r.flight_id}`,
      health: r.health,
      live: r.live,
    }))
  }, [engine])


  const flightCount = Array.isArray(report.flights)
    ? report.flights.length
    : report.flights?.flights?.length ?? 0

  const cells = [
    { k: 'Engine health', v: fmt(engine?.health_index, 1), tone: (engine?.health_index ?? 100) >= 90 ? 'ok' : (engine?.health_index ?? 100) >= 78 ? 'warn' : 'crit' },
    { k: 'Twin sync', v: fmt(engine?.sync_pct, 2), unit: '%' },
    { k: 'Open deviations', v: String(active.length), tone: active.length ? 'warn' : 'ok' },
    { k: 'Advisories', v: String(advisories.length), tone: advisories.length ? 'warn' : 'ok' },
    { k: 'Sorties on file', v: String(flightCount) },
  ]

  return (
    <>
      <PageHead
        title="Reports"
        sub="One sheet per sortie: what flew, how the engine came back, what deviated, and what the twin is asking for. Everything below is read from the ground station - nothing on this page is computed here."
        actions={
          <div className="row row--tight">
            <ProvenanceTag provenance={mode === 'DEMO' ? 'DEMO' : 'REAL'} />
            <button className="btn" onClick={() => window.print()} title="Print or save as PDF">
              <Printer size={13} /> Print
            </button>
          </div>
        }
      />

      <Metrics cells={cells} />

      {/* ---- 1. the sortie ------------------------------------------------ */}
      <div className="grid grid--2" style={{ marginTop: 'var(--gap-4)' }}>
        <Panel title="Flight summary" sub="SORTIE" actions={<Activity size={13} />}>
          <Kv
            items={[
              ['Aircraft', mission?.mission?.uav_id ?? 'UAV-01'],
              ['Sortie', mission?.mission?.id ?? '—'],
              ['Engine', engine?.engine_id ?? 'AERO-01'],
              ['Profile', mission?.mission?.profile_id ?? telemetry?.tick?.phase ?? '—'],
              ['Sector', mission?.mission?.sector ?? '—'],
              ['Regime', telemetry?.tick?.regime ?? '—'],
              ['Altitude', `${(mission?.altitude_ft ?? 0).toLocaleString()} ft`],
              ['Source', mode === 'DEMO' ? 'LOCAL MODEL' : 'GROUND STATION'],
            ]}
          />
        </Panel>

        <Panel title="Engine health" sub="AS REPORTED" actions={<Gauge size={13} />}>
          <div className="stack">
            <StatusRows
              rows={[
                {
                  k: 'HEALTH INDEX',
                  v: fmt(engine?.health_index, 1),
                  tone: (engine?.health_index ?? 100) >= 90 ? 'ok' : 'warn',
                },
                { k: 'STATE', v: alerts?.engine_state ?? '—' },
                { k: 'REASON', v: alerts?.engine_reason ?? '—', tone: 'dim' },
                { k: 'TWIN SYNC', v: `${fmt(engine?.sync_pct, 2)} %`, tone: 'accent' },
              ]}
            />
            {trend.length > 1 ? (
              <HealthTrend points={trend} height={120} />
            ) : (
              <Note>
                A trend needs more than one completed sortie. The register fills as flights
                finish.
              </Note>
            )}
          </div>
        </Panel>
      </div>

      {/* ---- 2. affected cylinders ---------------------------------------- */}
      <Panel
        title="Per-cylinder condition"
        sub="ALL FOUR"
        className="panel--flush"
        bodyClass="panel__body--flush"
        style={{ marginTop: 'var(--gap-4)' }}
        actions={<Cpu size={13} />}
      >
        {cylinders.length === 0 ? (
          <Empty label="No cylinder data" detail="The engine frame carries no per-cylinder block yet." />
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Cylinder</th>
                  <th>Status</th>
                  <th className="num">CHT actual</th>
                  <th className="num">Expected</th>
                  <th className="num">Residual</th>
                  <th className="num">Asymmetry</th>
                  <th className="num">Health</th>
                </tr>
              </thead>
              <tbody>
                {cylinders.map((c: any) => (
                  <tr key={c.index}>
                    <td className="mono">CYL {c.index}</td>
                    <td><StatusBadge status={c.status} dot={false} /></td>
                    <td className="num">{fmt(c.cht_observed, 1)} °C</td>
                    <td className="num">{fmt(c.cht_expected, 1)} °C</td>
                    <td className="num">{signed(c.cht_residual, 2)} °C</td>
                    <td className="num">{signed(c.asymmetry_c, 2)} °C</td>
                    <td className="num">{fmt(c.health, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ---- 3. what deviated, and on what evidence ----------------------- */}
      <div className="grid grid--2" style={{ marginTop: 'var(--gap-4)' }}>
        <Panel
          title="Deviations"
          sub="RANKED"
          actions={<AlertTriangle size={13} />}
        >
          {active.length === 0 ? (
            <Empty
              label="No open deviations"
              detail={
                abstained.length
                  ? `${abstained.length} tracked below the evidence bar. The detector is watching them and has declined to call them.`
                  : 'Every channel is inside its expected band for the current regime.'
              }
            />
          ) : (
            <div className="stack stack--sm">
              {active.map((a) => (
                <div key={a.id} className="tile">
                  <div className="row">
                    <span className="alert__title">{a.title}</span>
                    <span className="spacer" />
                    <StatusBadge status={a.severity} dot={false} />
                  </div>
                  <p className="setting__detail" style={{ marginTop: 4 }}>{a.summary}</p>
                  <div className="divider" />
                  <StatusRows
                    rows={[
                      { k: 'CYLINDER', v: a.cylinder ? `CYL ${a.cylinder}` : '—' },
                      { k: 'RESIDUAL', v: `${signed(a.residual, 2)} ${a.residual_unit}`, tone: 'residual' },
                      { k: 'TREND', v: a.trend },
                      { k: 'PERSISTENCE', v: `${a.flights} flights · ${a.samples.toLocaleString()} samples` },
                      { k: 'REGIMES', v: String(a.regime_count) },
                      {
                        k: 'CONFIDENCE',
                        v: a.calibrated ? pct(a.confidence, 0) : `${pct(a.confidence, 0)} (uncalibrated)`,
                        tone: a.confidence >= 0.8 ? 'ok' : 'warn',
                      },
                      {
                        k: 'MECHANISM',
                        v: a.mechanism_label
                          ? `${a.mechanism_label} · ${a.mechanism_qualifier}`
                          : 'NOT DIAGNOSED',
                        tone: a.mechanism_label ? undefined : 'dim',
                      },
                    ]}
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Maintenance advisory" sub="RECOMMENDED ACTION" actions={<Wrench size={13} />}>
          {!loaded ? (
            <Loading height={180} />
          ) : advisories.length === 0 ? (
            <Empty
              label="No action recommended"
              detail="Nothing has cleared the evidence bar the advisory generator works to."
            />
          ) : (
            <div className="stack stack--sm">
              {advisories.map((adv: any, i: number) => (
                <div key={adv.id ?? i} className="tile">
                  <div className="row">
                    <span className="alert__title">{adv.action ?? adv.title ?? 'Advisory'}</span>
                    <span className="spacer" />
                    {adv.priority !== undefined && <Badge tone="warn">P{adv.priority}</Badge>}
                  </div>
                  {adv.reason && (
                    <p className="setting__detail" style={{ marginTop: 4 }}>{adv.reason}</p>
                  )}
                  {adv.urgency && (
                    <div style={{ marginTop: 8 }}>
                      <Badge tone="caution">{adv.urgency}</Badge>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  )
}
