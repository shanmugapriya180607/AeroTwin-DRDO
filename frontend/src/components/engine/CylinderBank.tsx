/**
 * Four-cylinder view.
 *
 * Laid out the way the engine is: a horizontally-opposed bank, odd cylinders
 * on one side and even on the other. Each tile carries the pair that matters -
 * what physics expected and what the sensor read - because a failing cylinder
 * shows up as asymmetry between the four channels, not as a change in the
 * average.
 */

import { useTwin } from '../../store/useTwin'
import { BipolarBar, Meter, fmt, signed } from '../ui/Primitives'
import type { CylinderHealth } from '../../types'

const NO_CYLINDERS: CylinderHealth[] = []

function toneFor(status: string) {
  switch (status) {
    case 'CRITICAL': return 'crit'
    case 'WARNING': return 'warn'
    case 'DEGRADING': return 'degrading'
    default: return ''
  }
}

export function CylinderTile({
  cylinder,
  selected,
  onSelect,
  compact,
}: {
  cylinder: CylinderHealth
  selected: boolean
  onSelect: (i: number) => void
  compact?: boolean
}) {
  const tone = toneFor(cylinder.status)
  const markBottom = Math.max(2, Math.min(96, ((cylinder.cht_observed - 120) / 150) * 100))

  return (
    <button
      className={`cyl ${selected ? 'cyl--selected' : ''} ${tone ? `cyl--${tone}` : ''}`}
      onClick={() => onSelect(cylinder.index)}
      style={{ textAlign: 'left' }}
      aria-pressed={selected}
    >
      <div className="cyl__thermo" />
      <div className="cyl__thermo-mark" style={{ bottom: `${markBottom}%` }} />

      <div className="row row--tight" style={{ marginBottom: 8 }}>
        <span className="cyl__id">CYL {cylinder.index}</span>
        <span className="spacer" />
        <span
          className="micro"
          style={{
            color:
              cylinder.status === 'NORMAL' ? 'var(--ok-ink)'
                : cylinder.status === 'DEGRADING' ? 'var(--caution-ink)'
                  : cylinder.status === 'WARNING' ? 'var(--warn-ink)' : 'var(--crit-ink)',
          }}
        >
          {cylinder.status}
        </span>
      </div>

      <div className="stat stat--sm" style={{ marginBottom: 7 }}>
        <span className="stat__k">CHT actual</span>
        <span className="stat__v" style={{ fontSize: 19 }}>
          {fmt(cylinder.cht_observed, 1)}<span className="stat__u">°C</span>
        </span>
      </div>

      <div style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
        <div className="row row--tight" style={{ justifyContent: 'space-between' }}>
          <span className="micro">EXPECTED</span>
          <span className="mono" style={{ fontSize: 12.5, color: 'var(--expected-ink)' }}>
            {fmt(cylinder.cht_expected, 1)} °C
          </span>
        </div>
        <div className="row row--tight" style={{ justifyContent: 'space-between' }}>
          <span className="micro">RESIDUAL</span>
          <span className="mono" style={{ fontSize: 12.5, color: 'var(--residual-ink)' }}>
            {signed(cylinder.cht_residual, 1)} °C
          </span>
        </div>
        {!compact && (
          <div className="row row--tight" style={{ justifyContent: 'space-between' }}>
            <span className="micro">ASYMMETRY</span>
            <span
              className="mono"
              style={{
                fontSize: 12.5,
                color: Math.abs(cylinder.asymmetry_c) > 5 ? 'var(--crit-ink)' : 'var(--ink-2)',
              }}
            >
              {signed(cylinder.asymmetry_c, 1)} °C
            </span>
          </div>
        )}
      </div>

      <BipolarBar value={cylinder.asymmetry_c} range={14} />

      {!compact && (
        <div style={{ marginTop: 9 }}>
          <div className="row row--tight" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <span className="micro">HEALTH</span>
            <span className="mono" style={{ fontSize: 12.5 }}>{fmt(cylinder.health, 1)}</span>
          </div>
          <Meter
            value={cylinder.health}
            tone={
              cylinder.health >= 92 ? 'ok'
                : cylinder.health >= 78 ? 'caution'
                  : cylinder.health >= 60 ? 'warn' : 'crit'
            }
          />
        </div>
      )}
    </button>
  )
}

export function CylinderBank({ compact }: { compact?: boolean }) {
  // Zustand v5 snapshots must be referentially stable, so the selector returns
  // the array itself and the empty case falls back to a shared constant.
  const cylinders = useTwin((s) => s.telemetry?.engine?.cylinders) ?? NO_CYLINDERS
  const selected = useTwin((s) => s.selectedCylinder)
  const setCylinder = useTwin((s) => s.setCylinder)

  if (!cylinders.length) {
    return (
      <div className="cyl-bank">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" style={{ height: compact ? 150 : 210 }} />
        ))}
      </div>
    )
  }

  return (
    <div className="cyl-bank">
      {cylinders.map((cylinder) => (
        <CylinderTile
          key={cylinder.index}
          cylinder={cylinder}
          selected={selected === cylinder.index}
          onSelect={setCylinder}
          compact={compact}
        />
      ))}
    </div>
  )
}
