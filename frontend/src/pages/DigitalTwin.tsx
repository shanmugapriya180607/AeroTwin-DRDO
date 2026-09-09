/**
 * Digital Twin.
 *
 * The page that shows the actual contribution: a physics model running in
 * lockstep on the same inputs as the engine, the residual between the two, and
 * the state estimator whose output is fed back to re-tune the model. Without
 * that feedback arm this would be a simulation running next to a sensor feed,
 * not a twin.
 */

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, RefreshCw, Repeat } from 'lucide-react'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { ExpectedActualChart, ResidualChart } from '../components/charts/Charts'
import { EngineStage } from '../components/engine3d/EngineStage'
import { PipelineFlow } from '../components/twin/PipelineFlow'
import { STORY_BEATS } from '../components/demo/DemoStory'
import {
  Badge,
  BipolarBar,
  Empty,
  Kv,
  Meter,
  PageHead,
  ProvenanceTag,
  fmt,
  pct,
  signed,
} from '../components/ui/Primitives'

export default function DigitalTwin() {
  const residuals = useTwin((s) => s.residuals)
  const history = useTwin((s) => s.history)
  const selected = useTwin((s) => s.selectedCylinder)
  const setCylinder = useTwin((s) => s.setCylinder)
  const storyStep = useTwin((s) => s.storyStep)

  const [twinState, setTwinState] = useState<any>(null)
  const [comparison, setComparison] = useState<any>(null)

  useEffect(() => {
    const load = async () => {
      const [state, compare] = await Promise.all([api.twinState(), api.comparison()])
      if (state) setTwinState(state)
      if (compare) setComparison(compare)
    }
    void load()
    const timer = window.setInterval(load, 2400)
    return () => window.clearInterval(timer)
  }, [])

  const estimator = residuals?.estimator ?? twinState?.estimator
  const chtKey = `cht_${selected}`
  const series = history[chtKey] ?? []

  const rows = useMemo(() => {
    if (comparison?.rows?.length) return comparison.rows
    if (!residuals?.channels) return []
    return Object.values(residuals.channels).map((r: any) => ({
      channel: r.key,
      label: r.key.toUpperCase(),
      unit: r.unit,
      expected: r.expected,
      actual: r.observed,
      residual: r.residual,
      normalised: r.normalised,
      drift: r.ewma,
      provenance: r.key === 'vibration_g' || r.key === 'inj_timing_deg' ? 'SIMULATED' : 'REAL',
    }))
  }, [comparison, residuals])

  const realCount = rows.filter((r: any) => r.provenance === 'REAL').length
  const simCount = rows.filter((r: any) => r.provenance === 'SIMULATED').length


  return (
    <>
      <PageHead
        title="Digital Twin"
        actions={
          <div className="row row--tight">
            <Badge tone="info" dot live>
              SYNC {fmt(twinState?.sync_pct ?? residuals?.sync_pct, 2)}%
            </Badge>
            <Badge tone={estimator?.baseline_locked ? 'ok' : 'caution'}>
              {estimator?.state ?? 'INITIALISING'}
            </Badge>
          </div>
        }
      />

      {/* ---- the machine, and the pipeline running on it ------------------ */}
      <div
        className="grid"
        style={{ gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1fr)', marginBottom: 16 }}
      >
        <section className="panel panel--marked">
          <header className="panel__head">
            <h2 className="panel__title">Propulsion unit</h2>
                        <span className="panel__spacer" />
            <Badge tone="info" dot live>LIVE BOUND</Badge>
          </header>
          <div className="panel__body panel__body--flush">
            {/* Crank speed, head temperature and the flagged cylinder are the
                live values - the assembly is an instrument, not an ornament. */}
            <EngineStage height={352} defaultMode="TWIN" />
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Twin pipeline</h2>
                        <span className="panel__spacer" />
            <Badge tone="residual">RESIDUAL-DRIVEN</Badge>
          </header>
          <div className="panel__body panel__body--tight">
            <PipelineFlow
              variant="full"
              orientation="stacked"
              storyStage={storyStep >= 0 ? STORY_BEATS[storyStep]?.stage : null}
            />

            {/* Backend stage states, where the service reports them. */}
            {!!twinState?.pipeline?.length && (
              <div className="row row--tight" style={{ flexWrap: 'wrap', gap: 6, marginTop: 26 }}>
                {twinState.pipeline.map((node: any) => (
                  <Badge key={node.id} tone={node.active === false ? 'neutral' : 'ok'} dot>
                    {String(node.label ?? node.id).toUpperCase()} {node.state ?? ''}
                  </Badge>
                ))}
              </div>
            )}

            {/* the feedback arm */}
            <div
              className="row"
              style={{
                marginTop: 12,
                padding: '9px 12px',
                border: '1px dashed rgba(119,57,224,0.34)',
                borderRadius: 'var(--r)',
                background: 'rgba(119,57,224,0.05)',
              }}
            >
              <Repeat size={14} color="var(--residual-ink)" />
              <span className="label" style={{ color: 'var(--residual-ink)' }}>
                The model re-tunes itself to this engine
              </span>
              <ArrowDown size={12} color="var(--ink-4)" />
              {/* The three quantities the estimator feeds back, in words an
                  engineer reads rather than the field names it stores. */}
              <Badge tone="residual">Breathing</Badge>
              <Badge tone="residual">Cooling</Badge>
              <Badge tone="residual">Cylinder balance</Badge>
            </div>
          </div>
        </section>
      </div>

      {/* ---- comparison + estimator -------------------------------------- */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', marginBottom: 16 }}>
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Expected vs actual</h2>
                        <span className="panel__spacer" />
            <ProvenanceTag provenance="REAL" title={`${realCount} measured channels`} />
            <ProvenanceTag provenance="SIMULATED" title={`${simCount} generated by the physics model`} />
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>
              t = {fmt(residuals?.t, 0)} s
            </span>
          </header>
          <div className="panel__body panel__body--flush">
            <div className="scroll-y" style={{ maxHeight: 372 }}>
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th className="num">Expected</th>
                    <th className="num">Actual</th>
                    <th className="num">Residual</th>
                    <th style={{ width: 90 }}>Deviation</th>
                    <th className="num">z</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: any) => {
                    const hot = Math.abs(row.normalised) > 3
                    return (
                      <tr key={row.channel}>
                        <td style={{ color: hot ? 'var(--crit-ink)' : undefined }}>{row.label}</td>
                        <td className="num" style={{ color: 'var(--expected-ink)' }}>{fmt(row.expected, 1)}</td>
                        <td className="num" style={{ color: 'var(--actual)' }}>{fmt(row.actual, 1)}</td>
                        <td className="num" style={{ color: 'var(--residual-ink)' }}>{signed(row.residual, 2)}</td>
                        <td>
                          <BipolarBar value={row.normalised} range={6} />
                        </td>
                        <td className="num" style={{ color: hot ? 'var(--crit-ink)' : 'var(--ink-4)' }}>
                          {fmt(row.normalised, 1)}
                        </td>
                        <td>
                          <ProvenanceTag provenance={row.provenance} />
                        </td>
                      </tr>
                    )
                  })}
                  {!rows.length && (
                    <tr>
                      <td colSpan={7}>
                        <Empty label="Awaiting twin frames" />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <RefreshCw size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">State estimation</h2>
            <span className="panel__spacer" />
            <Badge tone={estimator?.gated ? 'caution' : 'ok'}>
              {estimator?.gated ? 'GATED' : 'TRACKING'}
            </Badge>
          </header>
          <div className="panel__body">

            <div className="stack">
              {[
                {
                  k: 'Volumetric efficiency',
                  current: estimator?.current?.volumetric_efficiency,
                  baseline: estimator?.baseline?.volumetric_efficiency,
                },
                {
                  k: 'Cooling effectiveness',
                  current: estimator?.current?.cooling_effectiveness,
                  baseline: estimator?.baseline?.cooling_effectiveness,
                },
              ].map((item) => (
                <div key={item.k}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                    <span className="micro">{item.k.toUpperCase()}</span>
                    <span className="mono" style={{ fontSize: 12.5 }}>
                      {fmt(item.current, 4)}
                      <span style={{ color: 'var(--ink-3)' }}> / {fmt(item.baseline, 4)} base</span>
                    </span>
                  </div>
                  <Meter value={(item.current ?? 0) * 100} max={110} tone="ok" />
                </div>
              ))}
            </div>

            <div className="divider" />

            <span className="micro">CYLINDER BALANCE AGAINST A HEALTHY ENGINE</span>
            <div className="stack stack--sm" style={{ marginTop: 8 }}>
              {(estimator?.trim_divergence ?? [0, 0, 0, 0]).map((value: number, i: number) => (
                <button
                  key={i}
                  onClick={() => setCylinder(i + 1)}
                  style={{ display: 'grid', gridTemplateColumns: '44px 1fr 62px', gap: 9, alignItems: 'center' }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: selected === i + 1 ? 'var(--accent-ink)' : 'var(--ink-4)' }}
                  >
                    CYL {i + 1}
                  </span>
                  <BipolarBar value={value * 100} range={3} />
                  <span className="mono" style={{ fontSize: 12, textAlign: 'right', color: 'var(--ink-2)' }}>
                    {signed(value * 100, 2)}%
                  </span>
                </button>
              ))}
            </div>

            <div className="divider" />

            <Kv
              items={[
                ['Convergence', pct(estimator?.convergence ?? 0, 1)],
                ['Steady samples', (estimator?.steady_samples ?? 0).toLocaleString()],
                ['Innovation', fmt(estimator?.innovation, 5)],
                ['Baseline', estimator?.baseline_locked ? 'LOCKED' : 'ACQUIRING'],
              ]}
            />
          </div>
        </section>
      </div>

      {/* ---- residual detail ---------------------------------------------- */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', marginBottom: 16, marginRight: 372 }}>
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Lockstep comparison · CHT {selected}</h2>
            <span className="panel__spacer" />
            <div className="btn-group">
              {[1, 2, 3, 4].map((i) => (
                <button
                  key={i}
                  className={`btn btn--sm ${selected === i ? 'btn--active' : ''}`}
                  onClick={() => setCylinder(i)}
                >
                  C{i}
                </button>
              ))}
            </div>
          </header>
          <div className="panel__body panel__body--tight">
            {series.length > 3 ? (
              <ExpectedActualChart series={series} unit="°C" height={200} />
            ) : (
              <div className="skeleton" style={{ height: 200 }} />
            )}
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Residual · CHT {selected}</h2>
            <span className="panel__spacer" />
            <span className="mono" style={{ fontSize: 12, color: 'var(--residual-ink)' }}>
              {signed(residuals?.channels?.[chtKey]?.residual, 2)} °C
            </span>
          </header>
          <div className="panel__body panel__body--tight">
            {series.length > 3 ? (
              <ResidualChart series={series} unit="°C" height={200} threshold={6} />
            ) : (
              <div className="skeleton" style={{ height: 200 }} />
            )}
          </div>
        </section>
      </div>
    </>
  )
}
