/**
 * Maintenance intelligence.
 *
 * A recommendation without an audit trail is an instruction to trust a black
 * box. Every advisory here carries the full chain from signal to action, so an
 * engineer can decide whether the evidence supports the work before booking it.
 */

import { useEffect, useState } from 'react'
import { ClipboardList, ListChecks, Wrench } from 'lucide-react'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { ContributionBars } from '../components/charts/Charts'
import {
  Badge,
  Empty,
  Meter,
  PageHead,
  StatusBadge,
  fmt,
  signed,
} from '../components/ui/Primitives'

export default function Maintenance() {
  const alerts = useTwin((s) => s.alerts)
  const [data, setData] = useState<any>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    const load = () => void api.maintenance().then((result) => result && setData(result))
    load()
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const advisories = data?.advisories ?? alerts?.advisories ?? []
  const selected = advisories.find((a: any) => a.id === selectedId) ?? advisories[0] ?? null
  const trail = selected?.evidence_trail

  const contributions = (trail?.contributions ?? []).slice(0, 6).map((c: any) => ({
    label: c.label,
    value: c.share ?? Math.abs(c.contribution ?? 0),
  }))

  return (
    <>
      <PageHead
        title="Maintenance Intelligence"
        actions={
          <div className="row row--tight">
            <Badge tone={advisories.length ? 'warn' : 'ok'}>{advisories.length} ADVISORY</Badge>
            <StatusBadge status={data?.engine_state ?? alerts?.engine_state} />
          </div>
        }
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(300px, 0.85fr) minmax(0, 1.5fr)', marginBottom: 16 }}>
        {/* ---- ranked list -------------------------------------------------- */}
        <section className="panel">
          <header className="panel__head">
            <ClipboardList size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Work queue</h2>
            <span className="panel__sub">BY PRIORITY</span>
          </header>
          <div className="panel__body panel__body--tight">
            {!advisories.length && (
              <Empty
                label="No maintenance action recommended"
                detail="NO ADVISORY AT THE EVIDENCE BAR"
              />
            )}
            <div className="stack stack--sm">
              {advisories.map((advisory: any) => (
                <button
                  key={advisory.id}
                  className={`alert alert--${(advisory.severity ?? 'low').toLowerCase()} ${selected?.id === advisory.id ? 'alert--selected' : ''}`}
                  onClick={() => setSelectedId(advisory.id)}
                  style={{ textAlign: 'left', width: '100%' }}
                >
                  <span className="alert__rank">{advisory.priority_code}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="alert__title">{advisory.title}</div>
                    <div className="alert__sub">{advisory.action}</div>
                  </div>
                  <Badge tone={advisory.severity === 'HIGH' ? 'crit' : advisory.severity === 'MEDIUM' ? 'warn' : 'caution'}>
                    {advisory.priority_label}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ---- selected advisory ------------------------------------------- */}
        <section className="panel panel--glow">
          <header className="panel__head">
            <Wrench size={13} color="var(--warn-ink)" />
            <h2 className="panel__title">{selected?.title ?? 'Advisory detail'}</h2>
            <span className="panel__spacer" />
            {selected && <Badge tone="warn">{selected.despatch_impact}</Badge>}
          </header>
          <div className="panel__body">
            {!selected ? (
              <Empty label="No advisory selected" />
            ) : (
              <div className="stack stack--lg">
                <div>
                  <span className="micro">RECOMMENDED ACTION</span>
                  <div style={{ fontSize: 21, fontWeight: 600, marginTop: 4, letterSpacing: '0.02em' }}>
                    {selected.action}
                  </div>
                </div>

                <div className="grid grid--2">
                  <div className="tile">
                    <span className="micro">LIKELY CONTRIBUTING MECHANISM</span>
                    <div style={{ fontSize: 'var(--t-lead)', fontWeight: 600, marginTop: 4 }}>
                      {selected.mechanism_label ?? 'NOT DIAGNOSED'}
                    </div>
                    <div className="row row--tight" style={{ marginTop: 6 }}>
                      <Badge tone={selected.qualifier === 'LIKELY' ? 'warn' : 'neutral'}>{selected.qualifier}</Badge>
                    </div>
                  </div>
                  <div className="tile">
                    <span className="micro">CONFIDENCE</span>
                    <div style={{ fontSize: 'var(--t-num)', fontWeight: 500, marginTop: 4 }} className="mono">
                      {fmt(selected.confidence_pct, 1)}%
                    </div>
                    <div style={{ marginTop: 7 }}>
                      <Meter
                        value={selected.confidence_pct ?? 0}
                        tone={(selected.confidence ?? 0) > 0.75 ? 'ok' : (selected.confidence ?? 0) > 0.5 ? 'caution' : 'warn'}
                      />
                    </div>
                  </div>
                </div>

                {/* evidence ------------------------------------------------- */}
                <div>
                  <span className="micro">EVIDENCE</span>
                  <div className="grid grid--3" style={{ gap: 9, marginTop: 8 }}>
                    {(selected.evidence ?? []).map((item: any, i: number) => (
                      <div className="tile" key={i}>
                        <span className="micro">{item.label}</span>
                        <div className="mono" style={{ fontSize: 'var(--t-body)', marginTop: 3 }}>{item.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* trail ---------------------------------------------------- */}
                {trail && (
                  <div>
                    <span className="micro">WHY THIS WAS RAISED</span>
                    <div className="trail" style={{ marginTop: 9 }}>
                      {[
                        { k: 'ALERT', v: trail.title, dot: '1' },
                        { k: 'SIGNAL', v: trail.primary_signal, dot: '2' },
                        {
                          k: 'PRIMARY VALUE',
                          v: `${signed(trail.primary_value, 2)} ${trail.primary_unit}`,
                          dot: '3',
                        },
                        {
                          k: 'RESIDUAL',
                          v: `${signed(trail.residual, 2)} ${trail.residual_unit}`,
                          dot: '4',
                          accent: true,
                        },
                        { k: 'TREND', v: trail.trend, dot: '5' },
                        {
                          k: 'PERSISTENCE',
                          v: `${trail.flights} flight${trail.flights === 1 ? '' : 's'} · ${(trail.samples ?? 0).toLocaleString()} samples`,
                          dot: '6',
                        },
                        {
                          k: 'OPERATING REGIME CONSISTENCY',
                          v: `${trail.regime_count} regimes · ${(trail.operating_regimes ?? []).slice(0, 2).join(', ')}`,
                          dot: '7',
                        },
                        {
                          k: 'SUPPORTING SIGNAL',
                          v: `${trail.supporting_signal} ${signed(trail.supporting_value, 2)} ${trail.supporting_unit}`,
                          dot: '8',
                        },
                        {
                          k: 'MODEL EVIDENCE',
                          v: trail.attribution?.method ?? 'RESIDUAL FEATURE ATTRIBUTION',
                          dot: '9',
                        },
                        { k: 'CONFIDENCE', v: `${fmt(trail.confidence_pct, 1)}%`, dot: '10' },
                        { k: 'RECOMMENDATION', v: selected.action, dot: '✓', accent: true },
                      ].map((step) => (
                        <div className="trail__step" key={step.k}>
                          <span className={`trail__dot ${step.accent ? 'trail__dot--accent' : ''}`}>{step.dot}</span>
                          <div>
                            <div className="trail__k">{step.k}</div>
                            <div className="trail__v mono">{step.v}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* procedure ------------------------------------------------ */}
                {selected.procedure?.length > 0 && (
                  <div>
                    <div className="row row--tight" style={{ marginBottom: 8 }}>
                      <ListChecks size={13} color="var(--accent-ink)" />
                      <span className="micro">SUGGESTED PROCEDURE</span>
                    </div>
                    <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
                      {selected.procedure.map((step: string, i: number) => (
                        <li key={i} style={{ fontSize: 'var(--t-small)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
                          {step}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {contributions.length > 0 && (
                  <div>
                    <span className="micro">FEATURE ATTRIBUTION</span>
                    <ContributionBars items={contributions} height={Math.max(110, contributions.length * 26)} />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
