/**
 * Mission simulation.
 *
 * Forward-runs a proposed sortie on the engine's CURRENT estimated state, not
 * on a nominal engine. That is the point: the same profile is safe on a
 * healthy engine and marginal on one with a cylinder already running warm, and
 * a mission planner needs to know which one they have.
 *
 * The four named operating conditions - high altitude, endurance, hot weather
 * and throttle transients - are the ones the problem statement calls out.
 */

import { useEffect, useMemo, useState } from 'react'
import { Play, Rocket, Settings2 } from 'lucide-react'
import { api } from '../services/api'
import { AXIS, CHART_BASE, EChart, chartToken, useChartTheme } from '../components/charts/EChart'
import { cylColor } from '../components/charts/Charts'
import {
  Badge, Empty, Kv, Meter, Note, PageHead, Slider, Stat, fmt,
} from '../components/ui/Primitives'

const CUSTOM = 'CUSTOM'

export default function Simulation() {
  const [profiles, setProfiles] = useState<any[]>([])
  const [profileId, setProfileId] = useState('ISR_STANDARD')
  const [result, setResult] = useState<any>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [altitude, setAltitude] = useState(15000)
  const [oat, setOat] = useState(20)
  const [ias, setIas] = useState(88)
  const [throttle, setThrottle] = useState(78)
  const [durationMin, setDurationMin] = useState(390)
  const [transients, setTransients] = useState(false)

  useEffect(() => {
    void api.profiles().then((data) => data?.profiles && setProfiles(data.profiles))
  }, [])

  const run = async () => {
    setRunning(true)
    setError(null)
    const payload =
      profileId === CUSTOM
        ? {
          profile_id: CUSTOM,
          altitude_ft: altitude,
          oat_c: oat,
          ias_kt: ias,
          throttle_pct: throttle,
          duration_s: durationMin * 60,
          transients,
        }
        : { profile_id: profileId, transients }
    const response = await api.runSimulation(payload)
    if (!response) setError('Simulation service unavailable. The backend is not reachable.')
    else setResult(response)
    setRunning(false)
  }

  const series = result?.series ?? []
  const summary = result?.summary
  const warnings = result?.warnings ?? []

  const theme = useChartTheme()
  const chartOption = useMemo(() => {
    if (!series.length) return null
    const x = series.map((p: any) => (p.t / 60).toFixed(0))
    return {
      ...CHART_BASE,
      legend: {
        show: true, top: 0, right: 0, itemWidth: 13, itemHeight: 2,
        textStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
      },
      grid: { left: 50, right: 52, top: 28, bottom: 30 },
      xAxis: {
        type: 'category', data: x, ...AXIS,
        name: 'MIN', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
      },
      yAxis: [
        { type: 'value', ...AXIS, name: '°C', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 }, scale: true },
        {
          type: 'value', ...AXIS, name: 'FT',
          nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
          splitLine: { show: false },
        },
      ],
      series: [
        ...[0, 1, 2, 3].map((i) => ({
          name: `CHT ${i + 1}`,
          type: 'line',
          data: series.map((p: any) => p.cht[i]),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: cylColor(i), width: 1.4 },
        })),
        {
          name: 'CHT EXPECTED (NOMINAL)',
          type: 'line',
          data: series.map((p: any) => p.cht_expected[0]),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: chartToken('--expected', '#7691b6'), width: 1.2, type: 'dashed' },
        },
        {
          name: 'ALTITUDE',
          type: 'line',
          yAxisIndex: 1,
          data: series.map((p: any) => p.altitude_ft),
          showSymbol: false,
          smooth: 0.3,
          lineStyle: { color: chartToken('--ink-5', '#b2c1d3'), width: 1 },
          areaStyle: { color: 'rgba(58,67,79,0.16)' },
        },
      ],
      // Caution and redline drawn as bands, so a profile that spends time in
      // the caution region is visible rather than needing to be read off.
      markArea: undefined,
    }
  }, [series, theme])

  const healthOption = useMemo(() => {
    if (!series.length) return null
    return {
      ...CHART_BASE,
      grid: { left: 46, right: 44, top: 16, bottom: 26 },
      xAxis: {
        type: 'category', data: series.map((p: any) => (p.t / 60).toFixed(0)), ...AXIS,
        name: 'MIN', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
      },
      yAxis: [
        { type: 'value', ...AXIS, min: 40, max: 100, name: 'HEALTH', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 } },
        { type: 'value', ...AXIS, name: '°C', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 }, splitLine: { show: false } },
      ],
      series: [
        {
          name: 'PROJECTED HEALTH',
          type: 'line',
          data: series.map((p: any) => p.projected_health),
          showSymbol: false,
          smooth: 0.3,
          lineStyle: { color: chartToken('--accent', '#0a6ed6'), width: 1.7 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(10,110,214,0.2)' },
                { offset: 1, color: 'rgba(10,110,214,0)' },
              ],
            },
          },
        },
        {
          name: 'PEAK RESIDUAL',
          type: 'line',
          yAxisIndex: 1,
          data: series.map((p: any) => p.residual_max_c),
          showSymbol: false,
          smooth: 0.3,
          lineStyle: { color: chartToken('--residual', '#7739e0'), width: 1.5 },
        },
      ],
    }
  }, [series, theme])

  // mission_risk is a structured verdict, not a label: band, probability,
  // the recommendation that follows from it, and what escalated it.
  const risk = summary?.mission_risk
  const riskTone =
    risk?.band === 'HIGH' ? 'crit'
      : risk?.band === 'ELEVATED' ? 'warn'
        : risk?.band === 'MODERATE' ? 'caution'
          : 'ok'

  return (
    <>
      <PageHead
        title="Mission Simulation"
        actions={
          risk && (
            <Badge tone={riskTone}>
              MISSION RISK · {risk.band} · {fmt(risk.risk_pct, 1)}%
            </Badge>
          )
        }
      />

      <div className="grid" style={{ gridTemplateColumns: 'minmax(280px, 0.75fr) minmax(0, 2fr)', marginBottom: 16 }}>
        {/* ---- controls ---------------------------------------------------- */}
        <section className="panel">
          <header className="panel__head">
            <Settings2 size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Mission profile</h2>
          </header>
          <div className="panel__body">
            <div className="stack stack--sm" style={{ marginBottom: 14 }}>
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  className={`tile ${profileId === profile.id ? 'cyl--selected' : ''}`}
                  onClick={() => setProfileId(profile.id)}
                  style={{
                    textAlign: 'left',
                    borderColor: profileId === profile.id ? 'rgba(10,110,214,0.5)' : undefined,
                  }}
                >
                  <div className="row row--tight">
                    <span className="label" style={{ color: 'var(--ink-2)' }}>{profile.name}</span>
                    <span className="spacer" />
                    {profile.tags?.[0] && <Badge>{profile.tags[0]}</Badge>}
                  </div>
                </button>
              ))}
              <button
                className="tile"
                onClick={() => setProfileId(CUSTOM)}
                style={{
                  textAlign: 'left',
                  borderColor: profileId === CUSTOM ? 'rgba(10,110,214,0.5)' : undefined,
                }}
              >
                <span className="label" style={{ color: 'var(--ink-2)' }}>CUSTOM CONDITION</span>
                <p style={{ fontSize: 'var(--t-micro)', color: 'var(--ink-4)', marginTop: 4 }}>
                  Set altitude, ambient temperature, airspeed, throttle and duration directly.
                </p>
              </button>
            </div>

            {profileId === CUSTOM && (
              <div className="stack" style={{ marginBottom: 14 }}>
                <Slider label="Altitude" value={altitude} min={500} max={25000} step={100} unit="ft" onChange={setAltitude} />
                <Slider label="Outside air temp" value={oat} min={-40} max={50} step={1} unit="°C" onChange={setOat} />
                <Slider label="Indicated airspeed" value={ias} min={50} max={160} step={1} unit="kt" onChange={setIas} />
                <Slider label="Throttle" value={throttle} min={30} max={100} step={1} unit="%" onChange={setThrottle} />
                <Slider label="Mission duration" value={durationMin} min={20} max={900} step={10} unit="min" onChange={setDurationMin} />
              </div>
            )}

            <label className="row row--tight" style={{ marginBottom: 14, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={transients}
                onChange={(e) => setTransients(e.target.checked)}
              />
              <span style={{ fontSize: 'var(--t-small)', color: 'var(--ink-2)' }}>
                Inject throttle transients
              </span>
            </label>

            <button className="btn btn--primary btn--block" onClick={run} disabled={running}>
              {running ? <Rocket size={13} /> : <Play size={13} />}
              {running ? 'Running…' : 'Run mission simulation'}
            </button>

            {error && (
              <div style={{ marginTop: 12 }}>
                <Note tone="crit">{error}</Note>
              </div>
            )}
          </div>
        </section>

        {/* ---- result ------------------------------------------------------ */}
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Predicted engine response</h2>
            <span className="panel__spacer" />
            {summary && (
              <span className="mono" style={{ fontSize: 12, color: 'var(--ink-4)' }}>
                {summary.duration_hms} · {summary.samples} samples
              </span>
            )}
          </header>
          <div className="panel__body panel__body--tight">
            {!result && (
              <Empty
                label="NO RUN"
                detail="SELECT A CONDITION AND RUN"
              />
            )}
            {chartOption && <EChart option={chartOption} height={232} />}
            {healthOption && <EChart option={healthOption} height={172} />}
          </div>
        </section>
      </div>

      {result && (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', marginRight: 372 }}>
          <section className="panel">
            <header className="panel__head">
              <h2 className="panel__title">Mission risk</h2>
              <span className="panel__spacer" />
              <Badge tone={riskTone}>{risk?.band ?? '—'}</Badge>
            </header>
            <div className="panel__body">
              <Stat
                k="Probability of a propulsion-driven abort"
                v={fmt(risk?.risk_pct, 1)}
                unit="%"
                size="lg"
                tone={riskTone}
                note={`over ${fmt(risk?.mission_hours, 2)} h of exposure`}
              />
              <div style={{ margin: '10px 0 16px' }}>
                <Meter value={risk?.risk_pct ?? 0} tone={riskTone} tall />
              </div>
              {risk?.recommendation && (
                <div style={{ marginBottom: 16 }}>
                  <Note tone={riskTone === 'crit' ? 'crit' : riskTone === 'ok' ? undefined : 'warn'}>
                    {risk.recommendation}
                  </Note>
                </div>
              )}
              <div className="stack">
                <div>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                    <span className="micro">TIME IN CAUTION BAND</span>
                    <span className="mono" style={{ fontSize: 12.5 }}>{summary?.caution_minutes} min</span>
                  </div>
                  <Meter
                    value={summary?.caution_seconds ?? 0}
                    max={Math.max(1, summary?.duration_s ?? 1)}
                    tone="caution"
                  />
                </div>
                <div>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                    <span className="micro">TIME ABOVE REDLINE</span>
                    <span className="mono" style={{ fontSize: 12.5 }}>{summary?.redline_minutes} min</span>
                  </div>
                  <Meter
                    value={summary?.redline_seconds ?? 0}
                    max={Math.max(1, summary?.duration_s ?? 1)}
                    tone="crit"
                  />
                </div>
              </div>
              <div className="divider" />
              <Kv
                items={[
                  ['Profile', result.profile?.name ?? '—'],
                  ['Duration', summary?.duration_hms ?? '—'],
                  ['CHT redline', `${summary?.cht_redline_c} °C`],
                  ['Sample stride', `${summary?.stride_s} s`],
                  ['Risk provenance', risk?.provenance ?? '—'],
                ]}
              />
            </div>
          </section>

          <section className="panel">
            <header className="panel__head">
              <h2 className="panel__title">Warnings</h2>
              <span className="panel__spacer" />
              <Badge tone={warnings.length ? 'warn' : 'ok'}>{warnings.length}</Badge>
            </header>
            <div className="panel__body panel__body--tight">
              {!warnings.length && (
                <Empty label="NO EXCEEDANCE" detail="PROFILE INSIDE EVERY LIMIT" />
              )}
              <div className="stack stack--sm">
                {warnings.map((warning: any, i: number) => (
                  <div key={i} className={`alert alert--${warning.level === 'CRITICAL' ? 'high' : 'medium'}`}>
                    <span className="alert__rank">!</span>
                    <div>
                      <div className="alert__title">{warning.title}</div>
                      <div className="alert__sub" style={{ whiteSpace: 'normal' }}>{warning.detail}</div>
                    </div>
                    <Badge tone={warning.level === 'CRITICAL' ? 'crit' : 'warn'}>{warning.level}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
