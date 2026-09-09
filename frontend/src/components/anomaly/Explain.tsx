/**
 * Why was this alert generated?
 *
 * The operator has to be able to audit a maintenance recommendation before
 * acting on it, so the chain is laid out end to end: signal, expected value,
 * actual value, residual, trend, persistence, regime breadth, model evidence,
 * calibrated confidence, recommendation.
 *
 * The language is deliberate. The system reports a LIKELY CONTRIBUTING
 * MECHANISM, never a confirmed physical failure - inspection is what confirms.
 * Where the evidence is thin it abstains and says so.
 */

import { AlertTriangle, HelpCircle, ShieldQuestion } from 'lucide-react'
import type { Anomaly } from '../../types'
import { ContributionBars } from '../charts/Charts'
import { Badge, Meter, Note, fmt, pct, signed } from '../ui/Primitives'

export function AbstentionCard({ anomaly }: { anomaly: Anomaly }) {
  return (
    <div className="tile" style={{ borderColor: 'var(--hairline-strong)' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <ShieldQuestion size={15} color="var(--ink-3)" />
        <span className="label" style={{ color: 'var(--ink-2)' }}>Model abstention</span>
        <span className="spacer" />
        <Badge>INSUFFICIENT EVIDENCE</Badge>
      </div>
      <Note>
        {anomaly.abstain_reason ??
          'The evidence does not support a diagnosis at the required confidence.'}
      </Note>
      <div className="row row--tight row--wrap" style={{ marginTop: 10 }}>
        <Badge tone="ok">STILL TRACKED</Badge>
        <Badge tone="caution">NO ACTION RAISED</Badge>
      </div>
    </div>
  )
}

export function ExplainPanel({ anomaly }: { anomaly: Anomaly | null }) {
  if (!anomaly) {
    return (
      <div style={{ padding: 22, textAlign: 'center' }}>
        <HelpCircle size={20} color="var(--ink-4)" />
        <p className="label" style={{ marginTop: 8 }}>No anomaly selected</p>
      </div>
    )
  }

  const learned = anomaly.learned && 'trained' in anomaly.learned ? anomaly.learned : null
  const contributions = anomaly.contributions.slice(0, 6).map((c) => ({
    label: c.label,
    value: Math.abs(c.contribution),
  }))

  return (
    <div className="stack stack--lg">
      {/* headline ------------------------------------------------------- */}
      <div>
        <div className="row" style={{ marginBottom: 6 }}>
          <AlertTriangle
            size={15}
            color={anomaly.severity === 'HIGH' ? 'var(--crit-ink)' : 'var(--warn-ink)'}
          />
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '0.06em' }}>{anomaly.title}</span>
          <span className="spacer" />
          <Badge tone={anomaly.severity === 'HIGH' ? 'crit' : anomaly.severity === 'MEDIUM' ? 'warn' : 'caution'}>
            {anomaly.severity}
          </Badge>
        </div>
        <p style={{ fontSize: 'var(--t-small)', color: 'var(--ink-3)', lineHeight: 1.6 }}>
          {anomaly.summary}
        </p>
      </div>

      {/* the evidence chain --------------------------------------------- */}
      <div className="trail">
        {[
          { k: 'PRIMARY SIGNAL', v: anomaly.cylinder ? `CHT ${anomaly.cylinder}` : anomaly.subsystem, dot: '1' },
          {
            k: 'EXPECTED (PHYSICS)',
            v: `${fmt(anomaly.supporting?.cht_expected ?? anomaly.supporting?.expected, 1)} ${anomaly.residual_unit}`,
            dot: '2',
          },
          {
            k: 'ACTUAL (SENSOR)',
            v: `${fmt(anomaly.supporting?.cht_observed ?? anomaly.supporting?.observed, 1)} ${anomaly.residual_unit}`,
            dot: '3',
          },
          {
            k: 'RESIDUAL',
            v: `${signed(anomaly.residual, 1)} ${anomaly.residual_unit}`,
            dot: '4',
            accent: true,
          },
          { k: 'TREND', v: anomaly.trend, dot: '5' },
          {
            k: 'PERSISTENCE',
            v: `${anomaly.flights} flight${anomaly.flights === 1 ? '' : 's'} · ${anomaly.samples.toLocaleString()} samples`,
            dot: '6',
          },
          {
            k: 'OPERATING REGIMES',
            v: `${anomaly.regime_count} · ${anomaly.regimes.slice(0, 3).join(', ')}${anomaly.regime_count > 3 ? ' …' : ''}`,
            dot: '7',
          },
          {
            k: 'MODEL EVIDENCE',
            v: learned?.trained
              ? `${learned.provenance ?? 'BASELINE + ISOLATION FOREST'} · ${learned.agreement}`
              : 'PHYSICS BASELINE ONLY — learned model abstained',
            dot: '8',
          },
          {
            k: 'CONFIDENCE',
            v: anomaly.abstained ? 'ABSTAINED' : `${pct(anomaly.confidence)}${anomaly.calibrated ? ' (calibrated)' : ' (uncalibrated)'}`,
            dot: '9',
            crit: anomaly.abstained,
          },
        ].map((step) => (
          <div className="trail__step" key={step.k}>
            <span
              className={`trail__dot ${step.accent ? 'trail__dot--accent' : ''} ${step.crit ? 'trail__dot--crit' : ''}`}
            >
              {step.dot}
            </span>
            <div>
              <div className="trail__k">{step.k}</div>
              <div className="trail__v mono">{step.v}</div>
            </div>
          </div>
        ))}
      </div>

      {/* mechanism ------------------------------------------------------- */}
      <div className="tile">
        <span className="micro">LIKELY MECHANISM</span>
        <div
          style={{
            fontSize: 16,
            fontWeight: 600,
            marginTop: 5,
            color: anomaly.abstained ? 'var(--ink-3)' : 'var(--ink)',
          }}
        >
          {anomaly.abstained ? 'NOT DIAGNOSED' : anomaly.mechanism_label ?? '—'}
        </div>
        <div className="row row--tight" style={{ marginTop: 7 }}>
          <Badge tone={anomaly.mechanism_qualifier === 'LIKELY' ? 'warn' : 'neutral'}>
            {anomaly.mechanism_qualifier}
          </Badge>
          <Badge tone="neutral">INSPECTION CONFIRMS</Badge>
        </div>
      </div>

      {/* confidence ------------------------------------------------------ */}
      {!anomaly.abstained && (
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="label">CONFIDENCE</span>
            <span className="spacer" />
            <span className="mono" style={{ fontSize: 14 }}>{pct(anomaly.confidence, 1)}</span>
          </div>
          <Meter
            value={(anomaly.confidence ?? 0) * 100}
            tone={anomaly.confidence > 0.75 ? 'ok' : anomaly.confidence > 0.5 ? 'caution' : 'warn'}
            tall
          />
          <div className="row row--tight row--wrap" style={{ marginTop: 8 }}>
            {/* What the number is made of, as its three inputs. */}
            <Badge tone="neutral">EVIDENCE BREADTH</Badge>
            <Badge tone="neutral">REGIME COVERAGE</Badge>
            <Badge tone="neutral">CHANNEL AGREEMENT</Badge>
          </div>
        </div>
      )}

      {anomaly.abstained && <AbstentionCard anomaly={anomaly} />}

      {/* attribution ----------------------------------------------------- */}
      {contributions.length > 0 && (
        <div>
          <div className="row" style={{ marginBottom: 4 }}>
            <span className="label">FEATURE ATTRIBUTION</span>
            <span className="spacer" />
            <Badge tone="residual">RESIDUAL FEATURES</Badge>
          </div>
          <ContributionBars items={contributions} height={Math.max(110, contributions.length * 26)} />
        </div>
      )}

      {/* learned model --------------------------------------------------- */}
      {learned && (
        <div className="tile">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="label">LEARNED MODEL</span>
            <span className="spacer" />
            <Badge tone={learned.trained ? 'info' : 'neutral'}>
              {learned.trained ? learned.verdict : 'UNTRAINED'}
            </Badge>
          </div>
          <div className="kv">
            <span className="kv__k">Isolation score</span>
            <span className="kv__v">{learned.trained ? fmt(learned.score, 3) : '—'}</span>
            <span className="kv__k">Physics baseline</span>
            <span className="kv__v">{fmt(learned.baseline_score, 3)}</span>
            <span className="kv__k">Fused</span>
            <span className="kv__v">{fmt(learned.fused_score, 3)}</span>
            <span className="kv__k">Agreement</span>
            <span className="kv__v">{learned.agreement ?? '—'}</span>
          </div>
          <p style={{ fontSize: 'var(--t-micro)', color: 'var(--ink-4)', marginTop: 8, lineHeight: 1.6 }}>
            {learned.reason}
          </p>
        </div>
      )}
    </div>
  )
}
