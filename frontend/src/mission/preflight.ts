/**
 * Pre-flight checks.
 *
 * Every check here interrogates something the console actually has. That is
 * the whole point of the panel: a checklist that always says READY is a
 * decoration, and a decoration in the place a reader expects a safety check is
 * worse than no panel at all.
 *
 * So each item is a predicate over live store state - is there a position, is
 * the datalink up, has a telemetry frame arrived with the channels this engine
 * is supposed to publish, has the twin produced an expectation to compare
 * against. If one cannot be satisfied the item says so, and a failed critical
 * item stops the launch rather than being waved through.
 *
 * None of it starts anything. The checks read; the sequencer decides.
 */

import type { AlertFrame, MissionFrame, SystemStatus, TelemetryFrame } from '../types'
import { assess } from './decision'

export type CheckState = 'PENDING' | 'CHECKING' | 'READY' | 'WARNING' | 'FAILED'

export interface CheckContext {
  telemetry: TelemetryFrame | null
  mission: MissionFrame | null
  alerts: AlertFrame | null
  status: SystemStatus | null
  mode: string
}

export interface CheckResult {
  state: 'READY' | 'WARNING' | 'FAILED'
  /** What the check actually found. Shown, so READY is never unexplained. */
  detail: string
}

export interface CheckSpec {
  id: string
  label: string
  /** A failed critical item stops the launch. A failed advisory one does not:
   *  it is reported and the sortie proceeds, which is what a real dispatch
   *  would do with, say, a degraded secondary. */
  critical: boolean
  /** Spoken on completion, if the operator has voice on. Null stays silent -
   *  eight callouts in a row is not a checklist, it is a monologue. */
  say: string | null
  run: (ctx: CheckContext) => CheckResult
}

/** How many channels a healthy engine frame is expected to carry. */
const MIN_CHANNELS = 8

export const CHECKS: CheckSpec[] = [
  {
    id: 'NAV',
    label: 'Navigation / GPS',
    critical: true,
    say: 'Navigation system ready.',
    run: ({ mission }) => {
      const p = mission?.mission?.position
      if (!p) return { state: 'FAILED', detail: 'No position solution' }
      return { state: 'READY', detail: `Grid ${p.grid ?? '—'}` }
    },
  },
  {
    id: 'COMMS',
    label: 'Communication',
    critical: true,
    say: null,
    run: ({ telemetry, mode }) => {
      const link = telemetry?.datalink
      if (link?.connected === false) return { state: 'FAILED', detail: 'Data link down' }
      if (!telemetry) return { state: 'FAILED', detail: 'No telemetry stream' }
      return {
        state: 'READY',
        detail: mode === 'LIVE' ? 'Ground station linked' : 'Local feed linked',
      }
    },
  },
  {
    id: 'ENGINE',
    label: 'Engine system',
    critical: true,
    say: 'Engine system ready.',
    run: ({ telemetry }) => {
      const engine = telemetry?.engine
      if (!engine) return { state: 'FAILED', detail: 'No engine summary' }
      const state = (engine.status ?? '').toUpperCase()
      if (state === 'CRITICAL') return { state: 'FAILED', detail: 'Engine reported CRITICAL' }
      if (state === 'DEGRADED') return { state: 'WARNING', detail: 'Engine reported DEGRADED' }
      return { state: 'READY', detail: engine.engine_id ?? 'Nominal' }
    },
  },
  {
    id: 'SENSORS',
    label: 'Engine sensors',
    critical: true,
    say: null,
    run: ({ telemetry }) => {
      const channels = telemetry?.tick?.channels ?? {}
      const count = Object.keys(channels).length
      if (count === 0) return { state: 'FAILED', detail: 'No channels reporting' }
      if (count < MIN_CHANNELS) {
        return { state: 'WARNING', detail: `${count} channels - partial coverage` }
      }
      return { state: 'READY', detail: `${count} channels at 1 Hz` }
    },
  },
  {
    id: 'FUEL',
    label: 'Fuel system',
    critical: false,
    say: null,
    run: ({ telemetry }) => {
      const flow = telemetry?.tick?.channels?.fuel_flow_gph
      if (flow === undefined || flow === null) {
        return { state: 'WARNING', detail: 'Fuel flow not reporting' }
      }
      return { state: 'READY', detail: `${flow.toFixed(2)} gph` }
    },
  },
  {
    id: 'TWIN',
    label: 'Digital twin',
    critical: true,
    say: 'Digital twin ready.',
    run: ({ telemetry }) => {
      const expected = telemetry?.tick?.expected
      if (!expected || Object.keys(expected).length === 0) {
        return { state: 'FAILED', detail: 'No physics expectation' }
      }
      const sync = telemetry?.engine?.sync_pct
      return {
        state: 'READY',
        detail: sync !== undefined && sync !== null ? `Sync ${sync.toFixed(1)}%` : 'Model online',
      }
    },
  },
  {
    id: 'AI',
    label: 'AI monitoring',
    critical: false,
    say: null,
    run: ({ alerts }) => {
      if (!alerts) return { state: 'WARNING', detail: 'Detector not yet reporting' }
      const tracked = alerts.anomalies?.length ?? 0
      return { state: 'READY', detail: tracked ? `${tracked} deviations tracked` : 'Armed' }
    },
  },
  {
    id: 'RISK',
    label: 'Mission risk',
    critical: false,
    say: null,
    run: ({ telemetry, alerts }) => {
      // The existing risk engine, not a second opinion invented here.
      const view = assess(telemetry?.engine, alerts)
      if (view.risk === 'CRITICAL') return { state: 'FAILED', detail: `${view.risk} - ${view.because}` }
      if (view.risk === 'HIGH' || view.risk === 'MODERATE') {
        return { state: 'WARNING', detail: `${view.risk} - ${view.because}` }
      }
      return { state: 'READY', detail: `${view.risk} - ${view.because}` }
    },
  },
]

/** Did anything critical fail? A launch is refused on this, not on a count. */
export function blocked(results: Record<string, CheckResult | undefined>): CheckSpec | null {
  return CHECKS.find((c) => c.critical && results[c.id]?.state === 'FAILED') ?? null
}
