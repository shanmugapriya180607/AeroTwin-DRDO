/**
 * The decision the operator is being asked to make.
 *
 * AeroTwin does not fly the aircraft. It reads the engine, says how confident
 * it is and what it would do - and then a person decides. That separation is
 * the product, so it is modelled explicitly here rather than implied by which
 * buttons happen to be enabled.
 *
 * Everything below is derived from what the detector and the twin have already
 * published: the engine's own state, the health index, the severity of the
 * strongest finding it is standing behind. Nothing in this file invents a risk
 * level, and an abstention - the twin declining to call it - never raises one.
 */

import type { AlertFrame, EngineSummary } from '../types'

export type MissionRisk = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL'

/** What the console would do. The operator is free to disagree. */
export type Recommendation =
  | 'CONTINUE MISSION'
  | 'CONTINUE AND MONITOR'
  | 'CONSIDER RETURN TO BASE'
  | 'RETURN TO BASE'
  | 'RETURN TO BASE OR ABORT'

export type OperatorCommand = 'NONE' | 'CONTINUE' | 'RETURN_TO_BASE' | 'ABORT'

/**
 * Every command, always, while the sortie is live.
 *
 * The risk level decides what the console *recommends*; it does not decide
 * what the operator is allowed to do. Offering RETURN TO BASE only once the
 * engine looks bad enough - and ABORT only at CRITICAL - meant the console was
 * quietly making the decision it exists to hand over, and an operator who
 * wanted to recall a healthy aircraft had no control to do it with. Which one
 * is advised is carried separately, and the panel weights it.
 *
 * The mission phase still gates these: a settled sortie offers nothing, which
 * is the panel's job rather than the assessment's.
 */
const ALL_COMMANDS: Array<'CONTINUE' | 'RETURN_TO_BASE' | 'ABORT'> =
  ['CONTINUE', 'RETURN_TO_BASE', 'ABORT']

export interface Assessment {
  risk: MissionRisk
  recommendation: Recommendation
  /** Which commands to offer, in the order they should appear. */
  commands: Array<'CONTINUE' | 'RETURN_TO_BASE' | 'ABORT'>
  /** The one the console is recommending, so the UI can weight it. */
  advised: 'CONTINUE' | 'RETURN_TO_BASE' | 'ABORT'
  /** One line saying what drove the assessment. Shown, not hidden in a tooltip. */
  because: string
}

/**
 * Read the engine and say how much risk the sortie is carrying.
 *
 * Three inputs, in order of authority: the engine's own published state, the
 * severity of the strongest finding the detector has not abstained on, and the
 * health index. The state wins where they disagree - it is the twin's own
 * verdict, and second-guessing it here would mean two parts of the console
 * giving different answers about the same engine.
 */
export function assess(
  engine: EngineSummary | null | undefined,
  alerts: AlertFrame | null | undefined,
): Assessment {
  const state = (alerts?.engine_state ?? engine?.status ?? '').toUpperCase()
  const health = engine?.health_index
  const findings = (alerts?.anomalies ?? []).filter((a) => !a.abstained)
  const worst = findings[0] ?? null
  const highCount = findings.filter((a) => a.severity === 'HIGH').length

  const cylinder = worst?.cylinder ? `cylinder ${worst.cylinder}` : 'the engine'

  /* ---- critical ------------------------------------------------------- */
  if (state === 'CRITICAL' || (health !== null && health !== undefined && health < 60) || highCount >= 3) {
    return {
      risk: 'CRITICAL',
      recommendation: 'RETURN TO BASE OR ABORT',
      commands: ALL_COMMANDS,
      advised: 'RETURN_TO_BASE',
      because: highCount >= 3
        ? `${highCount} high-severity deviations open`
        : state === 'CRITICAL'
          ? 'Engine reported CRITICAL'
          : `Health index ${health?.toFixed(1)}`,
    }
  }

  /* ---- high ----------------------------------------------------------- */
  if (state === 'DEGRADED' || highCount >= 1 || (health !== undefined && health !== null && health < 80)) {
    return {
      risk: 'HIGH',
      recommendation: 'RETURN TO BASE',
      commands: ALL_COMMANDS,
      advised: 'RETURN_TO_BASE',
      because: highCount >= 1
        ? `High-severity deviation on ${cylinder}`
        : state === 'DEGRADED'
          ? 'Engine reported DEGRADED'
          : `Health index ${health?.toFixed(1)}`,
    }
  }

  /* ---- moderate -------------------------------------------------------- */
  if (findings.length > 0 || (health !== undefined && health !== null && health < 92)) {
    return {
      risk: 'MODERATE',
      recommendation: findings.length > 1 ? 'CONSIDER RETURN TO BASE' : 'CONTINUE AND MONITOR',
      commands: ALL_COMMANDS,
      advised: 'CONTINUE',
      because: findings.length
        ? `${findings.length} deviation${findings.length > 1 ? 's' : ''} tracked on ${cylinder}`
        : `Health index ${health?.toFixed(1)}`,
    }
  }

  /* ---- nominal --------------------------------------------------------- */
  return {
    risk: 'LOW',
    recommendation: 'CONTINUE MISSION',
    commands: ALL_COMMANDS,
    advised: 'CONTINUE',
    because: 'No deviation above the evidence threshold',
  }
}

export const RISK_TONE: Record<MissionRisk, string> = {
  LOW: 'ok',
  MODERATE: 'caution',
  HIGH: 'warn',
  CRITICAL: 'crit',
}

export const COMMAND_LABEL: Record<'CONTINUE' | 'RETURN_TO_BASE' | 'ABORT', string> = {
  CONTINUE: 'Continue to fly',
  RETURN_TO_BASE: 'Return to base',
  ABORT: 'Abort mission',
}
