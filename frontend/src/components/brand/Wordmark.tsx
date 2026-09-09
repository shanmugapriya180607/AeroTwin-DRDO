/**
 * The AEROTWIN mark.
 *
 * One symbol, read two ways on purpose: a swept planform seen from above, and
 * the same planform mirrored below it as its digital counterpart. The two are
 * separated by the sync line - the axis the whole product is about. The orbit
 * ring around them is the telemetry loop closing back on the aircraft.
 *
 * Deliberately not an emblem: no crest, no ribbon, no motto. Two strokes and
 * an arc, so it survives being 16 px tall in a top bar.
 */

export function Mark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* the telemetry loop */}
      <circle cx="16" cy="16" r="13.2" stroke="currentColor" strokeWidth="1" opacity="0.28" />
      <path
        d="M16 2.8A13.2 13.2 0 0 1 29.2 16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.85"
      />

      {/* physical: the swept planform, solid */}
      <path
        d="M16 6.6 L25 15.1 L17.6 13.6 L16 17.4 L14.4 13.6 L7 15.1 Z"
        fill="currentColor"
        opacity="0.95"
      />

      {/* the sync axis */}
      <path d="M4.6 18.4 H27.4" stroke="currentColor" strokeWidth="0.9" opacity="0.34" />

      {/* digital: the same planform mirrored, drawn as edges */}
      <path
        d="M16 25.4 L23.6 19.9 L17.4 21.1 L16 18.9 L14.6 21.1 L8.4 19.9 Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        opacity="0.62"
        fill="none"
      />
    </svg>
  )
}

/**
 * The lockup. `stacked` centres it for a title card; the default is the
 * horizontal form used in the top bar and the page corners.
 */
export function Wordmark({
  size = 18,
  stacked = false,
  sub = 'PROPULSION INTELLIGENCE',
}: {
  size?: number
  stacked?: boolean
  sub?: string | null
}) {
  return (
    <div className={`wordmark ${stacked ? 'wordmark--stacked' : ''}`}>
      <Mark size={stacked ? size * 1.05 : size * 1.5} className="wordmark__mark" />
      <div className="wordmark__text">
        <div className="wordmark__name" style={{ fontSize: size }}>
          AEROTWIN
        </div>
        {sub && (
          <div className="wordmark__sub" style={{ fontSize: Math.max(8.5, size * 0.24) }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  )
}
