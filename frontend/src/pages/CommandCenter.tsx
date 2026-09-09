/**
 * Command Center.
 *
 * The one screen an operator watches. It answers, top to bottom: is the engine
 * well, does the twin agree with the engine, what has deviated, and what
 * should be done about it. The 3D aircraft stays live in the corner throughout.
 */

import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity, ArrowRight, Cpu, FileSearch, Gauge, Maximize2, Radio, ShieldAlert,
  TrendingDown, Wrench,
} from 'lucide-react'
import { useTwin } from '../store/useTwin'
import { HeroBackdrop } from '../components/brand/HeroBackdrop'
import { PipelineFlow } from '../components/twin/PipelineFlow'
import { STORY_BEATS } from '../components/demo/DemoStory'
import { CylinderBank } from '../components/engine/CylinderBank'
import { ExpectedActualChart, HealthGauge, HealthTrend, ResidualChart } from '../components/charts/Charts'
import {
  Badge, Empty, Kv, Meter, PageHead, ProvenanceTag, Stat, StatusBadge,
  fmt, pct, signed,
} from '../components/ui/Primitives'

/**
 * What the product claims to do, and where each claim is answered.
 *
 * Four verbs rather than a paragraph: a reader who has just arrived should be
 * able to take in the scope of the system in one glance and then go straight
 * to whichever part of it they came for.
 */
const CAPABILITIES = [
  { verb: 'Detect', what: 'Abnormal residual patterns', to: '/anomalies', icon: ShieldAlert },
  { verb: 'Locate', what: 'The affected cylinder', to: '/engine', icon: Cpu },
  { verb: 'Predict', what: 'Degradation and RUL', to: '/prognostics', icon: TrendingDown },
  { verb: 'Explain', what: 'The evidence behind it', to: '/maintenance', icon: FileSearch },
] as const

export default function CommandCenter() {
  const telemetry = useTwin((s) => s.telemetry)
  const residuals = useTwin((s) => s.residuals)
  const alerts = useTwin((s) => s.alerts)
  const mission = useTwin((s) => s.mission)
  const history = useTwin((s) => s.history)
  const mode = useTwin((s) => s.mode)
  const selected = useTwin((s) => s.selectedCylinder)
  const setDock = useTwin((s) => s.setDock)
  const enterMission = useTwin((s) => s.enterMission)
  const storyStep = useTwin((s) => s.storyStep)

  /* The shared 3D stage docks into this screen and returns to the corner on
     the way out. It is the same canvas either way - never remounted. */
  useEffect(() => {
    setDock('HERO')
    return () => setDock('CORNER')
  }, [setDock])

  const engine = telemetry?.engine
  const top = alerts?.anomalies?.[0] ?? null
  const advisory = alerts?.advisories?.[0] ?? null

  const chtKey = `cht_${selected}`
  const chtSeries = history[chtKey] ?? []

  const trend = useMemo(() => {
    const rows = engine?.health_history ?? []
    if (rows.length) {
      return rows.slice(-8).map((r) => ({
        label: r.live ? 'LIVE' : `#${r.flight_id}`,
        health: r.health,
        live: r.live,
      }))
    }
    return []
  }, [engine])

  return (
    <>
      <PageHead
        title="AeroTwin"
        sub="Residual-driven digital twin for MALE UAV piston engines."
        actions={
          <div className="row row--tight">
            {mode === 'DEMO' && <Badge tone="demo" dot live>LOCAL DEMO FEED</Badge>}
            <ProvenanceTag
              provenance="REAL"
              title="Measured channels replayed at 1 Hz against the data contract"
            />
            <ProvenanceTag
              provenance="SIMULATED"
              title="Vibration and injection timing have no counterpart in the corpus"
            />
          </div>
        }
      />

      {/* ---- hero: the aircraft, and what this system is for -------------- */}
      <section className="hero">
        {/* The environment this aircraft actually operates in, behind the
            copy. Drawn, themed, and covered by a scrim so the headline's
            contrast never depends on the picture. */}
        <HeroBackdrop />
        <div className="hero__scrim" aria-hidden />

        <div className="hero__left">
          <span className="hero__eyebrow">
            <i className="dot dot--live" style={{ background: 'var(--accent)' }} />
            AERO-01 &middot; {telemetry?.tick?.phase ?? 'STANDBY'} &middot;{' '}
            {mission?.mission?.id ?? 'ISR-047'}
          </span>
          <h2 className="hero__title">
            Propulsion intelligence<br />for <b>autonomous flight</b>
          </h2>
          <p className="hero__line">Expected against actual. The difference is the diagnosis.</p>
          <div className="hero__cta">
            <button className="hero__primary" onClick={enterMission}>
              <Maximize2 size={13} strokeWidth={2} />
              ENTER MISSION
            </button>
            <Link className="hero__secondary" to="/telemetry">
              LIVE MONITORING
              <ArrowRight size={13} />
            </Link>
          </div>

          <ul className="caps">
            {CAPABILITIES.map((cap) => (
              <li key={cap.verb}>
                <Link to={cap.to} className="caps__item">
                  <cap.icon size={15} strokeWidth={1.9} />
                  <span className="caps__verb">{cap.verb}</span>
                  <span className="caps__what">{cap.what}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="hero__right">
          {/* The persistent 3D stage flies into this slot. */}
          <div className="hero__slot" id="uav-dock" />
          <div className="hero__strip">
            <div className="hero__stat">
              <span className="hero__stat-k">Altitude</span>
              <span className="hero__stat-v">
                {(mission?.altitude_ft ?? 0).toLocaleString()}<small>ft</small>
              </span>
            </div>
            <div className="hero__stat">
              <span className="hero__stat-k">IAS</span>
              <span className="hero__stat-v">{fmt(mission?.ias_kt, 0)}<small>kt</small></span>
            </div>
            <div className="hero__stat">
              <span className="hero__stat-k">RPM</span>
              <span className="hero__stat-v">{(mission?.rpm ?? 0).toLocaleString()}</span>
            </div>
            <div className="hero__stat">
              <span className="hero__stat-k">Twin sync</span>
              <span className="hero__stat-v" style={{ color: 'var(--accent-ink)' }}>
                {fmt(engine?.sync_pct, 1)}<small>%</small>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ---- the pipeline, moving ---------------------------------------- */}
      <section className="panel panel--marked" style={{ marginBottom: 16 }}>
        <div className="panel__body panel__body--tight">
          <PipelineFlow
            variant="full"
            storyStage={storyStep >= 0 ? STORY_BEATS[storyStep]?.stage : null}
          />
        </div>
      </section>

      {/* ---- top row ------------------------------------------------------ */}
      <div className="grid grid--4" style={{ marginBottom: 16 }}>
        {/* engine health */}
        <section className="panel panel--glow">
          <header className="panel__head">
            <Gauge size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Engine health</h2>
            <span className="panel__spacer" />
            <StatusBadge status={engine?.status} />
          </header>
          <div className="panel__body panel__body--tight">
            <HealthGauge value={engine?.health_index ?? null} height={158} />
            <p style={{ fontSize: 'var(--t-small)', color: 'var(--ink-3)', textAlign: 'center', marginTop: -6 }}>
              {engine?.reason ?? 'Awaiting telemetry'}
            </p>
            <div className="divider" />
            <Kv
              items={[
                ['Confidence', engine?.confidence ? pct(engine.confidence, 1) : 'ABSTAINED'],
                ['Anomalies', String(engine?.anomaly_count ?? 0)],
                ['Advisories', String(engine?.advisory_count ?? 0)],
              ]}
            />
          </div>
          <footer className="panel__foot">
            <span className="micro">PROTOTYPE BANDS · NOT CERTIFIED LIMITS</span>
          </footer>
        </section>

        {/* digital twin */}
        <section className="panel">
          <header className="panel__head">
            <Cpu size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Digital twin</h2>
            <span className="panel__spacer" />
            <Badge tone={(engine?.sync_pct ?? 0) > 90 ? 'info' : 'caution'} dot live>
              SYNCHRONISED
            </Badge>
          </header>
          <div className="panel__body">
            <Stat
              k="Twin synchronisation"
              v={fmt(engine?.sync_pct ?? residuals?.sync_pct, 2)}
              unit="%"
              size="lg"
              tone="ok"
              note="TRACKING ERROR"
            />
            <div style={{ marginTop: 10 }}>
              <Meter value={engine?.sync_pct ?? 0} tone="ok" tall />
            </div>
            <div className="divider" />
            <Kv
              items={[
                ['Regime', telemetry?.tick?.regime ?? '—'],
                ['Steady state', residuals?.steady ? 'YES' : 'NO — transient'],
                ['State estimator', engine?.model_state ?? '—'],
                ['Power', `${fmt(engine?.power_pct, 0)}% · ${fmt(engine?.power_hp, 0)} hp`],
              ]}
            />
          </div>
          <footer className="panel__foot">
            <Link to="/twin" className="row row--tight" style={{ color: 'var(--accent-ink)', fontSize: 'var(--t-small)' }}>
              Open digital twin <ArrowRight size={12} />
            </Link>
          </footer>
        </section>

        {/* active anomalies */}
        <section className={`panel ${top && !top.abstained && top.severity === 'HIGH' ? 'panel--crit' : ''}`}>
          <header className="panel__head">
            <ShieldAlert size={13} color={top && !top.abstained ? 'var(--crit-ink)' : 'var(--ink-4)'} />
            <h2 className="panel__title">Active anomalies</h2>
            <span className="panel__spacer" />
            <Badge tone={engine?.anomaly_count ? 'crit' : 'ok'}>{engine?.anomaly_count ?? 0}</Badge>
          </header>
          <div className="panel__body panel__body--tight">
            {!alerts?.anomalies?.length && (
              <Empty label="NO DEVIATION" detail="FOUR CYLINDERS ON EXPECTATION" />
            )}
            <div className="stack stack--sm">
              {(alerts?.anomalies ?? []).slice(0, 3).map((anomaly) => (
                <Link
                  key={anomaly.id}
                  to="/anomalies"
                  className={`alert ${anomaly.abstained ? 'alert--abstain' : `alert--${anomaly.severity.toLowerCase()}`}`}
                >
                  <span className="alert__rank">{String(anomaly.rank).padStart(2, '0')}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="alert__title">{anomaly.title}</div>
                    <div className="alert__sub">
                      {signed(anomaly.residual, 1)} {anomaly.residual_unit} · {anomaly.trend} ·{' '}
                      {anomaly.regime_count} regime{anomaly.regime_count === 1 ? '' : 's'}
                    </div>
                  </div>
                  <Badge tone={anomaly.abstained ? 'neutral' : anomaly.severity === 'HIGH' ? 'crit' : 'warn'}>
                    {anomaly.abstained ? 'ABSTAIN' : pct(anomaly.confidence)}
                  </Badge>
                </Link>
              ))}
            </div>
          </div>
          <footer className="panel__foot">
            <Link to="/anomalies" className="row row--tight" style={{ color: 'var(--accent-ink)', fontSize: 'var(--t-small)' }}>
              Why was this generated? <ArrowRight size={12} />
            </Link>
          </footer>
        </section>

        {/* mission status */}
        <section className="panel">
          <header className="panel__head">
            <Radio size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Mission status</h2>
            <span className="panel__spacer" />
            <Badge tone="info">{mission?.mission?.status ?? '—'}</Badge>
          </header>
          <div className="panel__body">
            <div className="stat-row" style={{ marginBottom: 12 }}>
              <Stat k="Altitude" v={(mission?.altitude_ft ?? 0).toLocaleString()} unit="ft" size="sm" />
              <Stat k="IAS" v={fmt(mission?.ias_kt, 0)} unit="kt" size="sm" />
            </div>
            <div className="stat-row" style={{ marginBottom: 12 }}>
              <Stat k="RPM" v={(mission?.rpm ?? 0).toLocaleString()} size="sm" />
              <Stat k="OAT" v={fmt(mission?.oat_c, 1)} unit="°C" size="sm" />
            </div>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
              <span className="micro">MISSION PROGRESS</span>
              <span className="mono" style={{ fontSize: 12.5 }}>
                {pct(mission?.mission?.progress ?? 0, 1)}
              </span>
            </div>
            <Meter value={(mission?.mission?.progress ?? 0) * 100} />
            <div className="divider" />
            <Kv
              items={[
                ['Next waypoint', mission?.mission?.position?.leg ?? '—'],
                ['Grid', mission?.mission?.position?.grid ?? '—'],
                ['Phase', mission?.mission?.phase ?? '—'],
              ]}
            />
          </div>
          <footer className="panel__foot">
            <span className="micro">FICTIONAL SECTOR · NO OPERATIONAL LOCATION</span>
          </footer>
        </section>
      </div>

      {/* ---- expected vs actual ------------------------------------------ */}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)', marginBottom: 16 }}>
        <section className="panel">
          <header className="panel__head">
            <Activity size={13} color="var(--accent-ink)" />
            <h2 className="panel__title">Expected vs actual · CHT {selected}</h2>
                        <span className="panel__spacer" />
            <Badge tone="residual">RESIDUAL = ACTUAL − EXPECTED</Badge>
          </header>
          <div className="panel__body panel__body--tight">
            {chtSeries.length > 3 ? (
              <>
                <ExpectedActualChart series={chtSeries} unit="°C" height={186} />
                <div className="row" style={{ margin: '4px 0 2px' }}>
                  <span className="micro">RESIDUAL</span>
                  <span className="spacer" />
                  <span className="mono" style={{ fontSize: 12.5, color: 'var(--residual-ink)' }}>
                    {signed(residuals?.channels?.[chtKey]?.residual, 2)} °C · drift{' '}
                    {signed(residuals?.channels?.[chtKey]?.ewma, 2)} °C
                  </span>
                </div>
                <ResidualChart series={chtSeries} unit="°C" height={116} threshold={6} />
              </>
            ) : (
              <div className="skeleton" style={{ height: 300 }} />
            )}
          </div>
        </section>

        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">Health trend</h2>
                      </header>
          <div className="panel__body panel__body--tight">
            {trend.length ? <HealthTrend points={trend} height={150} /> : <Empty label="Collecting flight history" />}
            <div className="divider" />
            <div className="stack stack--sm">
              {advisory ? (
                <>
                  <div className="row row--tight">
                    <Wrench size={13} color="var(--warn-ink)" />
                    <span className="label" style={{ color: 'var(--ink-2)' }}>{advisory.priority_label}</span>
                    <span className="spacer" />
                    <Badge tone={advisory.severity === 'HIGH' ? 'crit' : 'warn'}>{advisory.severity}</Badge>
                  </div>
                  <div style={{ fontSize: 'var(--t-body)', fontWeight: 600 }}>{advisory.action}</div>
                  <div style={{ fontSize: 'var(--t-small)', color: 'var(--ink-3)' }}>{advisory.reason}</div>
                  <Badge tone="warn">{advisory.despatch_impact}</Badge>
                </>
              ) : (
                <Empty label="NO ADVISORY" detail="NO ADVISORY AT THE EVIDENCE BAR" />
              )}
            </div>
          </div>
          <footer className="panel__foot">
            <Link to="/maintenance" className="row row--tight" style={{ color: 'var(--accent-ink)', fontSize: 'var(--t-small)' }}>
              Maintenance intelligence <ArrowRight size={12} />
            </Link>
          </footer>
        </section>
      </div>

      {/* ---- cylinder bank ------------------------------------------------ */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <header className="panel__head">
          <h2 className="panel__title">Per-cylinder state</h2>
                    <span className="panel__spacer" />
          <Badge tone="info">
            CHT SPREAD {fmt(residuals?.asymmetry?.cht, 1)} °C
          </Badge>
        </header>
        <div className="panel__body panel__body--tight">
          <CylinderBank />
        </div>
      </section>

    </>
  )
}
