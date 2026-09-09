/**
 * The pipeline, as a moving thing.
 *
 * Sensor frames enter on the left and a maintenance advisory comes out on the
 * right; the packets between the stages are driven by the live feed, so they
 * stop when the datalink drops and they turn the residual colour once the
 * deviation is real. The stage that the narrated demonstration is currently
 * explaining is lit as it runs.
 *
 * The feedback arm is drawn explicitly, because that arm is what makes this a
 * twin of this engine rather than a simulation running beside it.
 */

import { useMemo } from 'react'
import { useTwin } from '../../store/useTwin'
import { fmt, signed } from '../ui/Primitives'
import type { CylinderHealth } from '../../types'

export interface PipelineNode {
  id: string
  label: string
  sub: string
}

export const PIPELINE_NODES: PipelineNode[] = [
  { id: 'OBSERVE', label: 'OBSERVE', sub: 'sensor stream' },
  { id: 'MODEL', label: 'MODEL', sub: 'physics twin' },
  { id: 'COMPARE', label: 'COMPARE', sub: 'expected vs actual' },
  { id: 'RESIDUAL', label: 'RESIDUAL', sub: 'actual − expected' },
  { id: 'ESTIMATE', label: 'ESTIMATE', sub: 'state feedback' },
  { id: 'DETECT', label: 'DETECT', sub: 'per cylinder' },
  { id: 'PREDICT', label: 'PREDICT', sub: 'health + mechanism' },
  { id: 'ACT', label: 'ACT', sub: 'advisory' },
]

/** Which node the narrated demonstration lights for each of its stages. */
const STORY_STAGE_NODE: Record<string, string> = {
  LINK: 'OBSERVE',
  OBSERVE: 'OBSERVE',
  MODEL: 'MODEL',
  COMPARE: 'COMPARE',
  DETECT: 'DETECT',
  ESTIMATE: 'ESTIMATE',
  PREDICT: 'PREDICT',
  ACT: 'ACT',
}

const NO_CYLINDERS: CylinderHealth[] = []

export function PipelineFlow({
  variant = 'strip',
  storyStage,
  orientation = 'row',
}: {
  variant?: 'strip' | 'full'
  storyStage?: string | null
  /** Eight stages will not fit across a half-width panel without squashing
   *  the labels, so a narrow column runs the pipeline downward instead. */
  orientation?: 'row' | 'stacked'
}) {
  const telemetry = useTwin((s) => s.telemetry)
  const residuals = useTwin((s) => s.residuals)
  const alerts = useTwin((s) => s.alerts)
  const cylinders = useTwin((s) => s.telemetry?.engine?.cylinders) ?? NO_CYLINDERS

  const connected = telemetry?.datalink?.connected !== false
  const engine = telemetry?.engine

  const worst = useMemo(
    () => cylinders.slice().sort((a, b) => Math.abs(b.cht_residual) - Math.abs(a.cht_residual))[0],
    [cylinders],
  )

  const anomalies = alerts?.anomalies?.filter((a) => !a.abstained) ?? []
  const severity = Math.abs(worst?.cht_residual ?? 0)
  /* Above this the deviation is what the detector is acting on rather than
     ordinary scatter, and the downstream half of the pipeline says so. */
  const faulted = severity > 6 || anomalies.length > 0
  const litNode = storyStage ? STORY_STAGE_NODE[storyStage] : null

  const values: Record<string, string> = {
    OBSERVE: telemetry ? `${Object.keys(telemetry.tick.channels).length} CH · 1 Hz` : 'AWAITING',
    MODEL: engine ? `SYNC ${fmt(engine.sync_pct, 1)} %` : '—',
    COMPARE: worst ? `CHT ${fmt(worst.cht_expected, 0)} → ${fmt(worst.cht_observed, 0)} °C` : '—',
    RESIDUAL: worst ? `${signed(worst.cht_residual, 1)} °C · CYL ${worst.index}` : '—',
    ESTIMATE: worst ? `TRIM ${signed(worst.trim_divergence_pct, 2)} %` : '—',
    DETECT: `${anomalies.length} ACTIVE`,
    PREDICT: engine ? `HEALTH ${fmt(engine.health_index, 1)}` : '—',
    ACT: `${engine?.advisory_count ?? 0} ADVISORY`,
  }

  return (
    <div
      className={`pipe ${variant === 'full' ? 'pipe--full' : ''} ${
        orientation === 'stacked' ? 'pipe--stacked' : ''
      } ${connected ? '' : 'pipe--held'}`}
    >
      {PIPELINE_NODES.map((node, i) => {
        const downstream = i >= 3
        const lit = litNode === node.id
        const alarmed = faulted && (node.id === 'RESIDUAL' || node.id === 'DETECT')
        return (
          <div key={node.id} className="pipe__cell">
            <div
              className={`pipe__node ${lit ? 'is-lit' : ''} ${alarmed ? 'is-alarmed' : ''} ${
                node.id === 'RESIDUAL' ? 'pipe__node--key' : ''
              }`}
            >
              <span className="pipe__index">{String(i + 1).padStart(2, '0')}</span>
              <span className="pipe__label">{node.label}</span>
              <span className="pipe__sub">{node.sub}</span>
              {variant === 'full' && <span className="pipe__value mono">{values[node.id]}</span>}
            </div>

            {i < PIPELINE_NODES.length - 1 && (
              <div className={`pipe__link ${faulted && downstream ? 'is-hot' : ''}`}>
                <span className="pipe__packet" />
                <span className="pipe__packet" style={{ animationDelay: '0.55s' }} />
                <span className="pipe__packet" style={{ animationDelay: '1.1s' }} />
              </div>
            )}
          </div>
        )
      })}

      {/* The estimator's correction going back into the model. */}
      <div className="pipe__feedback" aria-hidden>
        <span className="pipe__feedback-label">THE MODEL RE-TUNES ITSELF TO THIS ENGINE</span>
      </div>

      {!connected && <div className="pipe__hold">DATA LINK LOST · TWIN HOLDING, NOT GUESSING</div>}
      {!!residuals && variant === 'full' && (
        <div className="pipe__foot">
          <span className="micro">REGIME {residuals.regime}</span>
          <span className="micro">{residuals.steady ? 'STEADY STATE' : 'TRANSIENT — DETECTOR GATED'}</span>
          <span className="micro">CHT SPREAD {fmt(residuals.asymmetry?.cht, 1)} °C</span>
        </div>
      )}
    </div>
  )
}
