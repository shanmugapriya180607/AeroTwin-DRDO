import type { ReactNode } from 'react'
import type { Provenance } from '../../types'
import { selectSourceIsReal, useTwin } from '../../store/useTwin'

/* ---------------------------------------------------------------- Panel -- */

export function Panel({
  title,
  sub,
  actions,
  children,
  footer,
  tone,
  bodyClass = '',
  className = '',
  style,
}: {
  title?: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  tone?: 'crit' | 'warn'
  bodyClass?: string
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <section className={`panel ${tone ? `panel--${tone}` : ''} ${className}`} style={style}>
      {(title || actions) && (
        <header className="panel__head">
          {title && <h2 className="panel__title">{title}</h2>}
          {sub && <span className="panel__sub">{sub}</span>}
          <span className="panel__spacer" />
          {actions}
        </header>
      )}
      <div className={`panel__body ${bodyClass}`}>{children}</div>
      {footer && <footer className="panel__foot">{footer}</footer>}
    </section>
  )
}

/* ---------------------------------------------------------------- Badge -- */

type BadgeTone = 'ok' | 'caution' | 'warn' | 'crit' | 'info' | 'real' | 'sim' | 'demo' | 'residual' | 'neutral'

export function Badge({
  children,
  tone = 'neutral',
  dot,
  live,
  title,
}: {
  children: ReactNode
  tone?: BadgeTone
  dot?: boolean
  live?: boolean
  /** Hover detail. Used where the badge is a summary of something with a
   *  precise value behind it - when a build snapshot was captured, say. */
  title?: string
}) {
  return (
    <span className={`badge ${tone !== 'neutral' ? `badge--${tone}` : ''}`} title={title}>
      {dot && <i className={`dot ${live ? 'dot--live' : ''}`} />}
      {children}
    </span>
  )
}

const STATUS_TONE: Record<string, BadgeTone> = {
  NORMAL: 'ok',
  HEALTHY: 'ok',
  NOMINAL: 'ok',
  OK: 'ok',
  CAUTION: 'caution',
  DEGRADING: 'caution',
  DEGRADED: 'caution',
  WARNING: 'warn',
  CRITICAL: 'crit',
  HIGH: 'crit',
  MEDIUM: 'warn',
  LOW: 'caution',
  ABSTAIN: 'neutral',
  UNCLASSIFIED: 'neutral',
}

export function statusTone(status?: string | null): BadgeTone {
  if (!status) return 'neutral'
  return STATUS_TONE[status.toUpperCase()] ?? 'neutral'
}

export function StatusBadge({ status, dot = true }: { status?: string | null; dot?: boolean }) {
  return (
    <Badge tone={statusTone(status)} dot={dot} live={statusTone(status) !== 'ok'}>
      {status ?? '—'}
    </Badge>
  )
}

/* ----------------------------------------------------------- Provenance -- */

const PROV_TONE: Record<Provenance, BadgeTone> = {
  REAL: 'real',
  SIMULATED: 'sim',
  DERIVED: 'info',
  DEMO: 'demo',
}

/**
 * Provenance is a product feature, not a disclaimer. Any value that did not
 * come off a sensor says so, everywhere it appears.
 *
 * REAL is downgraded to DEMO whenever the live source is not a measured one.
 * The registry marks a channel REAL because the contract says it is
 * measurable; that is not the same as it having been measured, and the badge
 * has to answer the second question. Doing it here rather than at each call
 * site is what stops one screen disagreeing with another.
 */
export function ProvenanceTag({ provenance, title }: { provenance: Provenance; title?: string }) {
  const sourceIsReal = useTwin(selectSourceIsReal)
  const shown: Provenance = provenance === 'REAL' && !sourceIsReal ? 'DEMO' : provenance
  return (
    <span title={title} style={{ display: 'inline-flex' }}>
      <Badge tone={PROV_TONE[shown] ?? 'neutral'}>{shown}</Badge>
    </span>
  )
}

/* ----------------------------------------------------------------- Stat -- */

export function Stat({
  k,
  v,
  unit,
  note,
  size = 'md',
  tone,
  mono = true,
}: {
  k: ReactNode
  v: ReactNode
  unit?: ReactNode
  note?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  tone?: string
  mono?: boolean
}) {
  const color =
    tone === 'ok' ? 'var(--ok-ink)'
      : tone === 'caution' ? 'var(--caution-ink)'
        : tone === 'warn' ? 'var(--warn-ink)'
          : tone === 'crit' ? 'var(--crit-ink)'
            : tone === 'residual' ? 'var(--residual-ink)'
              : tone === 'expected' ? 'var(--expected-ink)'
                : undefined

  return (
    <div className={`stat ${size === 'lg' ? 'stat--lg' : size === 'sm' ? 'stat--sm' : ''}`}>
      <span className="stat__k">{k}</span>
      <span className="stat__v" style={{ color, fontFamily: mono ? undefined : 'var(--sans)' }}>
        {v}
        {unit && <span className="stat__u">{unit}</span>}
      </span>
      {note && <span className="stat__note">{note}</span>}
    </div>
  )
}

/* ---------------------------------------------------------------- Meter -- */

export function Meter({ value, max = 100, tone = 'accent', tall }: { value: number; max?: number; tone?: string; tall?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  const color =
    tone === 'ok' ? 'var(--ok)'
      : tone === 'caution' ? 'var(--caution)'
        : tone === 'warn' ? 'var(--warn)'
          : tone === 'crit' ? 'var(--crit)'
            : tone === 'residual' ? 'var(--residual)'
              : 'var(--accent)'
  return (
    <div className={`meter ${tall ? 'meter--tall' : ''}`}>
      <div className="meter__fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

/** A residual is signed; a one-sided bar would hide a cold cylinder. */
export function BipolarBar({ value, range = 20 }: { value: number; range?: number }) {
  const clamped = Math.max(-range, Math.min(range, value))
  const half = Math.abs(clamped) / range * 50
  const positive = clamped >= 0
  return (
    <div className="bipolar" title={`${value.toFixed(2)}`}>
      <div className="bipolar__zero" />
      <div
        className="bipolar__fill"
        style={{
          left: positive ? '50%' : `${50 - half}%`,
          width: `${half}%`,
          background: Math.abs(clamped) > range * 0.5 ? 'var(--crit)' : 'var(--residual)',
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ Kv --- */

/**
 * A compact technical read-out: label on the left, value on the right, one row
 * per fact. This is what replaces a paragraph - a judge reads six rows faster
 * than one sentence, and the rows carry the same information.
 */
export function StatusRows({
  rows,
}: {
  rows: Array<{ k: string; v: ReactNode; tone?: string }>
}) {
  return (
    <div className="rows">
      {rows.map((row, i) => (
        <div className="rows__row" key={`${row.k}-${i}`}>
          <span className="rows__k">{row.k}</span>
          <span className="rows__dots" />
          <span
            className={`rows__v ${row.tone ? `rows__v--${row.tone}` : ''}`}
          >
            {row.v}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * A strip of headline numbers. Used where a page previously opened with a
 * paragraph explaining what it was about: the numbers say it faster.
 */
export function Metrics({
  cells,
}: {
  cells: Array<{ k: string; v: ReactNode; unit?: string; tone?: string }>
}) {
  return (
    <div className="metrics">
      {cells.map((cell) => (
        <div className="metrics__cell" key={cell.k}>
          <span className="metrics__k">{cell.k}</span>
          <span className={`metrics__v ${cell.tone ? `metrics__v--${cell.tone}` : ''}`}>
            {cell.v}
            {cell.unit && <small>{cell.unit}</small>}
          </span>
        </div>
      ))}
    </div>
  )
}

/** A word and its state. Datasets, limitations, capabilities - all read alike. */
export function TagRow({
  label,
  state,
  tone = 'neutral',
  meta,
}: {
  label: string
  /**
   * The badge on the right. Optional on purpose.
   *
   * A list whose every row carried the same state word read as one run-on
   * string - "THERMODYNAMICS TRANSFERS", "COOLING TRANSFERS" - because the
   * word was a property of the list, not of the row. Where the heading above
   * already says what the list is, the rows leave it off.
   */
  state?: string
  tone?: BadgeTone
  meta?: string
}) {
  return (
    <div className="tagrow">
      <span className="tagrow__label">{label}</span>
      {meta && <span className="tagrow__meta">{meta}</span>}
      <span className="tagrow__spacer" />
      {state && <Badge tone={tone}>{state}</Badge>}
    </div>
  )
}

export function Kv({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <div className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <span className="kv__k">{k}</span>
          <span className="kv__v">{v}</span>
        </div>
      ))}
    </div>
  )
}

/* ----------------------------------------------------------------- Note -- */

export function Note({ children, tone }: { children: ReactNode; tone?: 'warn' | 'crit' | 'info' }) {
  return <p className={`note ${tone ? `note--${tone}` : ''}`}>{children}</p>
}

/* ----------------------------------------------------------- Empty state - */

export function Empty({ label, detail }: { label: string; detail?: string }) {
  return (
    <div style={{ padding: '26px 12px', textAlign: 'center' }}>
      <div className="label" style={{ color: 'var(--ink-3)' }}>{label}</div>
      {detail && (
        <p style={{ fontSize: 'var(--t-small)', color: 'var(--ink-4)', marginTop: 6, maxWidth: '46ch', marginInline: 'auto' }}>
          {detail}
        </p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- Loading -- */

export function Loading({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} />
}

/* ---------------------------------------------------------------- Field -- */

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="field">
      <div className="field__row">
        <span className="stat__k">{label}</span>
        <span className="field__v">
          {value.toLocaleString()} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  )
}

/* ------------------------------------------------------------ Page head -- */

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string
  sub?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="page-head__title">{title}</h1>
        {sub && <p className="page-head__sub">{sub}</p>}
      </div>
      <span className="page-head__spacer" />
      {actions}
    </header>
  )
}

/* --------------------------------------------------------------- Format -- */

export function fmt(value: number | null | undefined, digits = 1, fallback = '—') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback
  return value.toFixed(digits)
}

export function signed(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

export function pct(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function clock(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '--:--:--'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
