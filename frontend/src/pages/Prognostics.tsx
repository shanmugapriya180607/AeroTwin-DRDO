/**
 * Prognostics.
 *
 * This page is deliberately restrained. The published benchmark task on the
 * open corpus is binary serviceability - P(RUL > 2 days) - and that is what is
 * reported. No continuous hours-remaining curve is drawn, because none is
 * validated behind this prototype, and drawing one would be the single easiest
 * way to lose a propulsion engineer's trust.
 */

import { useEffect, useState } from 'react'
import { Clock, TrendingDown } from 'lucide-react'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { HealthTrend } from '../components/charts/Charts'
import {
  Badge,
  Empty,
  Meter,
  PageHead,
  Stat,
  StatusBadge,
  fmt,
  signed,
} from '../components/ui/Primitives'

export default function Prognostics() {
  const telemetry = useTwin((s) => s.telemetry)
  const [prediction, setPrediction] = useState<any>(null)

  useEffect(() => {
    const load = () => void api.prediction().then((data) => data && setPrediction(data))
    load()
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const engine = telemetry?.engine
  const prognosis = prediction?.prognosis ?? engine?.prognosis
  const history = prediction?.history ?? engine?.health_history ?? []

  const trend = history.slice(-10).map((r: any) => ({
    label: r.live ? 'LIVE' : `#${r.flight_id}`,
    health: r.health,
    live: r.live,
  }))

  const decline = prognosis?.drift_per_10_flights ?? 0

  return (
    <>
      <PageHead
        title="Prognostics"
        actions={
          <div className="row row--tight">
            <Badge tone="caution">RESEARCH MODE</Badge>
            <StatusBadge status={engine?.status} />
          </div>
        }
      />

      <div className="grid grid--4" style={{ marginBottom: 16 }}>
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Health index</h2>
          </header>
          <div className="panel__body">
            <Stat
              k="Current"
              v={fmt(prediction?.health_index ?? engine?.health_index, 1)}
              size="lg"
              tone={
                (engine?.health_index ?? 100) >= 92 ? 'ok'
                  : (engine?.health_index ?? 100) >= 80 ? 'caution' : 'warn'
              }
            />
            <div style={{ marginTop: 10 }}>
              <Meter
                value={prediction?.health_index ?? engine?.health_index ?? 0}
                tone={
                  (engine?.health_index ?? 100) >= 92 ? 'ok'
                    : (engine?.health_index ?? 100) >= 80 ? 'caution' : 'warn'
                }
                tall
              />
            </div>
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <TrendingDown size={13} color={decline < 0 ? 'var(--warn-ink)' : 'var(--ok-ink)'} />
            <h2 className="panel__title">Degradation rate</h2>
          </header>
          <div className="panel__body">
            <Stat
              k="Health drift"
              v={signed(decline, 2)}
              unit="/ 10 flights"
              size="lg"
              tone={decline < -2 ? 'warn' : decline < -0.5 ? 'caution' : 'ok'}
            />
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Peak anomaly score</h2>
          </header>
          <div className="panel__body">
            <Stat
              k="Worst subject"
              v={fmt(prognosis?.peak_anomaly_score, 3)}
              size="lg"
              tone={(prognosis?.peak_anomaly_score ?? 0) > 0.7 ? 'warn' : 'caution'}
            />
          </div>
        </section>

        <section className="panel panel--glow">
          <header className="panel__head">
            <Clock size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Remaining useful life</h2>
            <span className="panel__spacer" />
            <Badge tone="caution">PROTOTYPE / RESEARCH MODE</Badge>
          </header>
          <div className="panel__body">
            {prognosis ? (
              <>
                <Stat
                  k={prognosis.task ?? 'P(SERVICEABLE > 2 DAYS)'}
                  v={fmt(prognosis.p_serviceable_2d_pct, 1)}
                  unit="%"
                  size="lg"
                  tone={
                    (prognosis.p_serviceable_2d ?? 1) > 0.85 ? 'ok'
                      : (prognosis.p_serviceable_2d ?? 1) > 0.6 ? 'caution' : 'warn'
                  }
                />
                <div style={{ marginTop: 10 }}>
                  <Meter
                    value={prognosis.p_serviceable_2d_pct ?? 0}
                    tone={
                      (prognosis.p_serviceable_2d ?? 1) > 0.85 ? 'ok'
                        : (prognosis.p_serviceable_2d ?? 1) > 0.6 ? 'caution' : 'warn'
                    }
                    tall
                  />
                </div>
                <div className="row row--tight" style={{ marginTop: 10 }}>
                  <Badge tone="info">{prognosis.band}</Badge>
                  <Badge>{prognosis.provenance}</Badge>
                </div>
              </>
            ) : (
              <Empty label="ESTIMATE FORMING" detail="AWAITING COMPLETED SORTIES" />
            )}
          </div>
        </section>
      </div>

      {/* The trend now has the row to itself. */}
      <section className="panel" style={{ marginBottom: 16, marginRight: 372 }}>
        <header className="panel__head">
          <h2 className="panel__title">Health trend across sorties</h2>
        </header>
        <div className="panel__body panel__body--tight">
          {trend.length > 1 ? <HealthTrend points={trend} height={210} /> : <Empty label="Collecting flight history" />}
        </div>
      </section>

      <section className="panel" style={{ marginRight: 372 }}>
        <header className="panel__head">
          <h2 className="panel__title">Flight history</h2>
                  </header>
        <div className="panel__body panel__body--flush">
          <div className="scroll-y" style={{ maxHeight: 280 }}>
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Flight</th>
                  <th>Profile</th>
                  <th className="num">Health</th>
                  <th className="num">Peak residual</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row: any, i: number) => (
                  <tr key={`${row.flight_id}-${i}`}>
                    <td className="mono">{row.live ? 'LIVE SORTIE' : `#${row.flight_id}`}</td>
                    <td>{row.profile_id}</td>
                    <td className="num">{fmt(row.health, 1)}</td>
                    <td className="num" style={{ color: 'var(--residual-ink)' }}>
                      {row.peak_residual_c !== undefined ? `${signed(row.peak_residual_c, 1)} °C` : '—'}
                    </td>
                    <td><StatusBadge status={row.status} dot={false} /></td>
                    <td style={{ color: 'var(--ink-4)' }}>{row.notes ?? '—'}</td>
                  </tr>
                ))}
                {!history.length && (
                  <tr>
                    <td colSpan={6}><Empty label="No completed sorties yet" /></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  )
}
