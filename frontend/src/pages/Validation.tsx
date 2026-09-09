/**
 * Validation.
 *
 * A system that cannot state the boundary of its own competence should not be
 * trusted with a maintenance decision - so the boundary is on screen. It is on
 * screen as tags and numbers, not as prose: the same information, at the
 * density the rest of the console is read at.
 */

import { useEffect, useMemo, useState } from 'react'
import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { api } from '../services/api'
import { liveOrSnapshot, snapshotAge } from '../services/reports'
import {
  AXIS,
  CHART_BASE,
  EChart,
  chartToken,
  monoGutter,
  useChartTheme,
} from '../components/charts/EChart'
import {
  Badge,
  Empty,
  Meter,
  Metrics,
  PageHead,
  StatusRows,
  TagRow,
  fmt,
} from '../components/ui/Primitives'

/**
 * A one-line reason, for the meta slot on a tag row.
 *
 * Only ever applied to free text the register does not carry a label for -
 * everything with a `tag` uses it, because a label guessed out of a sentence
 * comes back as a fragment.
 */
function reason(text: string, words = 4): string {
  const clause = String(text ?? '').trim().split(/[.;:]/)[0].trim()
  if (!clause) return ''
  return clause.split(/\s+/).slice(0, words).join(' ').toUpperCase()
}

export default function Validation() {
  const [data, setData] = useState<any>(null)
  /* Distinguish 'not fetched yet' from 'not available'. */
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void liveOrSnapshot(api.validation, 'validation').then((result) => {
      if (result) setData(result)
      setLoaded(true)
    })
  }, [])

  const report = data?.report
  const gap = data?.domain_gap
  const calibration = data?.calibration

  /*
   * Three states, not two.
   *
   * The page used to treat "no report" as "the harness is running", which is
   * true while a validation run is in progress and false in the two other ways
   * a report can be missing: the request has not answered yet, or nothing
   * answered at all. On a static deployment that left the badge reading
   * RUNNING, with a live dot, indefinitely - the page asserting that work was
   * happening when none was. The fetch flag was added to tell them apart and
   * then never read.
   */
  const settled = loaded && !!report && report.status !== 'RUNNING'
  const statusLabel = !loaded ? 'CHECKING' : !report ? 'UNAVAILABLE' : report.status

  const theme = useChartTheme()
  const reliabilityOption = useMemo(() => {
    const bins = report?.reliability ?? []
    if (!bins.length) return null
    const populated = bins.filter((b: any) => b.count > 0)
    return {
      ...CHART_BASE,
      grid: { left: 46, right: 16, top: 18, bottom: 32 },
      legend: {
        show: true, top: 0, right: 0, itemWidth: 12, itemHeight: 2,
        textStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: populated.map((b: any) => b.bin),
        ...AXIS,
        name: 'STATED',
        nameLocation: 'middle',
        nameGap: 22,
        nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
      },
      yAxis: { type: 'value', min: 0, max: 1, ...AXIS },
      series: [
        {
          name: 'PERFECT',
          type: 'line',
          data: populated.map((b: any) => b.mean_confidence),
          showSymbol: false,
          lineStyle: { color: chartToken('--ink-5', '#b2c1d3'), width: 1, type: 'dashed' },
        },
        {
          name: 'OBSERVED',
          type: 'bar',
          data: populated.map((b: any) => b.observed_accuracy),
          barWidth: '52%',
          itemStyle: { color: chartToken('--accent', '#0a6ed6'), borderRadius: [2, 2, 0, 0] },
        },
      ],
    }
  }, [report, theme])

  const fidelityOption = useMemo(() => {
    const rows = report?.model_fidelity ?? []
    if (!rows.length) return null
    return {
      ...CHART_BASE,
      grid: {
        left: monoGutter(rows.map((r: any) => r.channel), 11),
        right: 62, top: 8, bottom: 30, containLabel: false,
      },
      tooltip: { ...CHART_BASE.tooltip, trigger: 'item' },
      xAxis: { type: 'value', ...AXIS, name: 'P95 |ERR|', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 } },
      yAxis: {
        type: 'category',
        data: rows.map((r: any) => r.channel).reverse(),
        ...AXIS,
        splitLine: { show: false },
        axisLabel: { ...AXIS.axisLabel, fontSize: 11 },
      },
      series: [
        {
          type: 'bar',
          data: rows.map((r: any) => r.p95_abs_error).reverse(),
          barWidth: 8,
          itemStyle: { color: chartToken('--expected', '#7691b6'), borderRadius: [0, 2, 2, 0] },
          label: {
            show: true, position: 'right', color: chartToken('--ink-3', '#3d5471'), fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace',
          },
        },
      ],
    }
  }, [report, theme])

  return (
    <>
      <PageHead
        title="Validation"
        actions={
          <div className="row row--tight">
            {data?.snapshot && (
              <Badge tone="caution" title={`Captured at build time, ${snapshotAge(data.generated_at)}`}>
                BUILD SNAPSHOT
              </Badge>
            )}
            <Badge tone={settled ? 'ok' : 'caution'} dot live={!settled}>
              {statusLabel}
            </Badge>
            <Badge tone="caution">NOT CERTIFIED</Badge>
          </div>
        }
      />

      {/* ---- measured performance ----------------------------------------- */}
      <section className="panel panel--marked" style={{ marginBottom: 16 }}>
        <header className="panel__head">
          <ShieldCheck size={13} color="var(--accent-ink)" />
          <h2 className="panel__title">Measured</h2>
          <span className="panel__spacer" />
          {report && (
            <Badge tone="info">
              {report.trials} TRIALS · {report.positives}P / {report.negatives}N
            </Badge>
          )}
        </header>
        <div className="panel__body panel__body--tight">
          {!settled ? (
            <Empty
              label={
                !loaded ? 'CHECKING VALIDATION'
                  : !report ? 'VALIDATION UNAVAILABLE' : 'VALIDATION RUNNING'
              }
              detail={
                !loaded ? 'Reading the validation report.'
                  : !report
                    ? 'No ground station answered and no build-time report shipped with this bundle.'
                    : 'No metric before the harness completes.'
              }
            />
          ) : (
            <>
              <div className="grid grid--4" style={{ gap: 12, marginBottom: 12 }}>
                {(report.metrics ?? []).map((metric: any) => (
                  <div className="tile" key={metric.key}>
                    <span className="micro">{metric.label}</span>
                    <div
                      className="mono"
                      style={{ fontSize: 28, marginTop: 3, fontWeight: 600, color: 'var(--ink)' }}
                    >
                      {fmt(metric.value, 3)}
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <Meter
                        value={metric.value * 100}
                        tone={
                          metric.key === 'ece' ? (metric.value < 0.1 ? 'ok' : 'caution')
                            : metric.value > 0.85 ? 'ok' : metric.value > 0.65 ? 'caution' : 'warn'
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>

              {report.confusion && (
                <Metrics
                  cells={[
                    { k: 'TRUE POSITIVE', v: String(report.confusion.tp), tone: 'ok' },
                    { k: 'FALSE POSITIVE', v: String(report.confusion.fp), tone: 'warn' },
                    { k: 'FALSE NEGATIVE', v: String(report.confusion.fn), tone: 'warn' },
                    { k: 'TRUE NEGATIVE', v: String(report.confusion.tn), tone: 'ok' },
                    { k: 'SCOPE', v: 'SYNTHETIC', tone: 'warn' },
                  ]}
                />
              )}
            </>
          )}
        </div>
      </section>

      {/* ---- calibration + fidelity ---------------------------------------- */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', marginBottom: 16 }}>
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Calibration</h2>
            <span className="panel__spacer" />
            <Badge tone={calibration?.fitted ? 'ok' : 'caution'}>
              {calibration?.fitted ? calibration.method : 'DEFERRED'}
            </Badge>
          </header>
          <div className="panel__body panel__body--tight">
            {reliabilityOption ? (
              <EChart option={reliabilityOption} height={196} />
            ) : (
              <Empty label="PENDING" />
            )}
            {calibration && (
              <StatusRows
                rows={[
                  { k: 'ECE BEFORE', v: fmt(calibration.ece_before, 4) },
                  { k: 'ECE AFTER', v: fmt(calibration.ece_after, 4), tone: 'ok' },
                  { k: 'SAMPLES', v: String(calibration.samples ?? 0) },
                  { k: 'FITTED ON', v: String(calibration.fitted_on ?? '—').toUpperCase() },
                ]}
              />
            )}
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Model fidelity</h2>
            <span className="panel__spacer" />
            <Badge tone="info">P95 ABS ERROR</Badge>
          </header>
          <div className="panel__body panel__body--tight">
            {fidelityOption ? (
              <EChart
                option={fidelityOption}
                height={Math.max(200, (report?.model_fidelity?.length ?? 6) * 22)}
              />
            ) : (
              <Empty label="PENDING" />
            )}
          </div>
        </section>
      </div>

      {/* ---- domain gap ---------------------------------------------------- */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <header className="panel__head">
          <TriangleAlert size={13} color="var(--caution-ink)" />
          <h2 className="panel__title">What carries over to the UAV engine</h2>
          <span className="panel__spacer" />
          <Badge tone="real">{gap?.from ?? 'NGAFID-MC'}</Badge>
          <span className="micro">→</span>
          <Badge tone="caution">{gap?.to ?? 'MALE UAV'}</Badge>
        </header>
        <div className="panel__body panel__body--tight">
          <div className="grid grid--2">
            <div>
              <span className="micro" style={{ color: 'var(--ok-ink)' }}>CARRIES OVER</span>
              <div className="stack stack--sm" style={{ marginTop: 8 }}>
                {(gap?.transfers ?? []).map((item: any, i: number) => (
                  <TagRow
                    key={i}
                    label={item.tag ?? reason(item)}
                    meta={item.detail}
                    tone="ok"
                  />
                ))}
              </div>
            </div>
            <div>
              <span className="micro" style={{ color: 'var(--caution-ink)' }}>DOES NOT CARRY OVER</span>
              <div className="stack stack--sm" style={{ marginTop: 8 }}>
                {(gap?.does_not_transfer ?? []).map((item: any, i: number) => (
                  <TagRow
                    key={i}
                    label={item.tag ?? reason(item)}
                    meta={item.detail}
                    tone="caution"
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
