/**
 * Engine health.
 *
 * Per-cylinder first. The engine-level index is a roll-up of four cylinder
 * indices, never the other way round - a four-cylinder mean can sit perfectly
 * normal while one cylinder is 60 °C hot, which is precisely the case this
 * system exists to catch.
 */

import { useEffect, useState } from 'react'
import { Flame, Thermometer } from 'lucide-react'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { EngineStage } from '../components/engine3d/EngineStage'
import { CylinderBank } from '../components/engine/CylinderBank'
import { CylinderChart, ExpectedActualChart, HealthGauge, ResidualChart } from '../components/charts/Charts'
import {
  Badge, BipolarBar, Empty, Kv, Meter, Note, PageHead, StatusBadge,
  fmt, pct, signed,
} from '../components/ui/Primitives'

export default function EngineHealth() {
  const telemetry = useTwin((s) => s.telemetry)
  const residuals = useTwin((s) => s.residuals)
  const history = useTwin((s) => s.history)
  const alerts = useTwin((s) => s.alerts)
  const selected = useTwin((s) => s.selectedCylinder)

  const [limits, setLimits] = useState<any>(null)

  useEffect(() => {
    void api.cylinders().then((data) => data && setLimits(data))
  }, [])

  const engine = telemetry?.engine
  const cylinder = engine?.cylinders?.find((c) => c.index === selected)
  const anomaly = alerts?.anomalies?.find((a) => a.cylinder === selected)

  const chtSeries = history[`cht_${selected}`] ?? []
  const egtSeries = history[`egt_${selected}`] ?? []

  const contributors = (engine?.cylinders ?? [])
    .map((c) => ({ label: `CYL ${c.index}`, value: 100 - c.health, health: c.health }))
    .sort((a, b) => b.value - a.value)

  return (
    <>
      <PageHead
        title="Engine Health"
        actions={
          <div className="row row--tight">
            <StatusBadge status={engine?.status} />
            <Badge tone="info">
              CHT SPREAD {fmt(residuals?.asymmetry?.cht, 1)} °C
            </Badge>
          </div>
        }
      />

      {/* ---- the engine itself -------------------------------------------- */}
      <section className="panel panel--marked" style={{ marginBottom: 16 }}>
        <header className="panel__head">
          <h2 className="panel__title">Cylinder assembly</h2>
          <span className="panel__sub">LIVE</span>
          <span className="panel__spacer" />
          <Badge tone="info">4 CYL - HORIZONTALLY OPPOSED</Badge>
        </header>
        <div className="panel__body panel__body--flush">
          <EngineStage height={318} defaultMode="THERMAL" />
        </div>
      </section>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(260px, 0.8fr) minmax(0, 2.2fr)', marginBottom: 16 }}>
        <section className="panel panel--glow">
          <header className="panel__head">
            <h2 className="panel__title">Engine health index</h2>
            <span className="panel__spacer" />
            <Badge tone="neutral">0 – 100</Badge>
          </header>
          <div className="panel__body panel__body--tight">
            <HealthGauge value={engine?.health_index ?? null} height={168} />
            <p style={{ textAlign: 'center', fontSize: 'var(--t-small)', color: 'var(--ink-3)', marginTop: -4 }}>
              {engine?.reason}
            </p>
            <div className="divider" />
            <span className="micro">MAJOR CONTRIBUTORS</span>
            <div className="stack stack--sm" style={{ marginTop: 8 }}>
              {contributors.map((c) => (
                <div key={c.label}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c.label}</span>
                    <span className="mono" style={{ fontSize: 12 }}>−{fmt(c.value, 1)}</span>
                  </div>
                  <Meter
                    value={c.value}
                    max={40}
                    tone={c.value > 22 ? 'crit' : c.value > 10 ? 'warn' : c.value > 4 ? 'caution' : 'ok'}
                  />
                </div>
              ))}
            </div>
            <div className="divider" />
            <Kv
              items={[
                ['Confidence', engine?.confidence ? pct(engine.confidence, 1) : 'ABSTAINED'],
                ['Twin sync', `${fmt(engine?.sync_pct, 2)}%`],
                ['Threshold alerts', String(engine?.threshold_count ?? 0)],
              ]}
            />
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <Thermometer size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Cylinder bank</h2>
            <span className="panel__sub">SELECT TO INSPECT</span>
            <span className="panel__spacer" />
            <Badge tone="residual">EXPECTED · ACTUAL · RESIDUAL</Badge>
          </header>
          <div className="panel__body">
            <CylinderBank />
            <div className="row row--tight row--wrap" style={{ marginTop: 14 }}>
              <Badge tone="residual">ASYMMETRY, NOT AVERAGE</Badge>
              <Badge tone="neutral">PER-CYLINDER EGT / CHT</Badge>
            </div>
          </div>
        </section>
      </div>

      {/* ---- selected cylinder detail -------------------------------------- */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', marginBottom: 16 }}>
        <section className="panel">
          <header className="panel__head">
            <Flame size={13} color="var(--warn-ink)" />
            <h2 className="panel__title">Cylinder {selected} · CHT</h2>
            <span className="panel__spacer" />
            {cylinder && <StatusBadge status={cylinder.status} />}
          </header>
          <div className="panel__body panel__body--tight">
            {chtSeries.length > 3 ? (
              <ExpectedActualChart series={chtSeries} unit="°C" height={172} />
            ) : (
              <div className="skeleton" style={{ height: 172 }} />
            )}
            {chtSeries.length > 3 && <ResidualChart series={chtSeries} unit="°C" height={108} threshold={6} />}
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Cylinder {selected} · EGT</h2>
                        <span className="panel__spacer" />
            <span className="mono" style={{ fontSize: 12, color: 'var(--residual-ink)' }}>
              {signed(cylinder?.egt_residual, 1)} °C
            </span>
          </header>
          <div className="panel__body panel__body--tight">
            {egtSeries.length > 3 ? (
              <ExpectedActualChart series={egtSeries} unit="°C" height={172} />
            ) : (
              <div className="skeleton" style={{ height: 172 }} />
            )}
            {egtSeries.length > 3 && <ResidualChart series={egtSeries} unit="°C" height={108} threshold={18} />}
          </div>
        </section>
      </div>

      {/* ---- four-cylinder overlay ------------------------------------------ */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', marginRight: 372 }}>
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Four-cylinder residual overlay</h2>
                      </header>
          <div className="panel__body panel__body--tight">
            {(history.cht_1?.length ?? 0) > 3 ? (
              <CylinderChart histories={history} field="residual" unit="°C" height={220} highlight={selected} />
            ) : (
              <div className="skeleton" style={{ height: 220 }} />
            )}
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Limits and margins</h2>
            <span className="panel__spacer" />
            <Badge tone="caution">SAFETY FLOOR</Badge>
          </header>
          <div className="panel__body">
            <Kv
              items={[
                ['CHT caution', `${limits?.limits?.cht_caution_c ?? 232} °C`],
                ['CHT redline', `${limits?.limits?.cht_redline_c ?? 260} °C`],
                ['EGT redline', `${limits?.limits?.egt_redline_c ?? 843} °C`],
              ]}
            />
            <div className="divider" />
            <span className="micro">CURRENT MARGINS</span>
            <div className="stack stack--sm" style={{ marginTop: 8 }}>
              {(engine?.cylinders ?? []).map((c) => (
                <div key={c.index}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 3 }}>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>CYL {c.index}</span>
                    <span className="mono" style={{ fontSize: 12 }}>{fmt(c.margin_to_redline_c, 1)} °C to redline</span>
                  </div>
                  <BipolarBar value={-c.asymmetry_c} range={14} />
                </div>
              ))}
            </div>
            {alerts?.threshold?.length ? (
              <>
                <div className="divider" />
                <span className="micro">ACTIVE THRESHOLD ALERTS</span>
                <div className="stack stack--sm" style={{ marginTop: 7 }}>
                  {alerts.threshold.map((t, i) => (
                    <div key={i} className="alert alert--high">
                      <span className="alert__rank">!</span>
                      <div>
                        <div className="alert__title">{t.channel?.toUpperCase()}</div>
                        <div className="alert__sub">{t.message}</div>
                      </div>
                      <Badge tone="crit">{t.level}</Badge>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ marginTop: 12 }}>
                <Empty label="NO THRESHOLD ALARM" detail="ALL VALUES INSIDE LIMITS" />
              </div>
            )}
          </div>
        </section>
      </div>

      {anomaly && (
        <div style={{ marginTop: 16, marginRight: 372 }}>
          <Note tone={anomaly.abstained ? undefined : 'warn'}>
            <strong>Cylinder {selected}:</strong> {anomaly.summary}{' '}
            {anomaly.abstained
              ? 'Evidence is below the diagnosis threshold, so the system abstains rather than naming a mechanism.'
              : `Likely contributing mechanism — ${anomaly.mechanism_label}. Confidence ${pct(anomaly.confidence, 1)}.`}
          </Note>
        </div>
      )}
    </>
  )
}
