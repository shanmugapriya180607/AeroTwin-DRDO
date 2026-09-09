/**
 * Reference data, live where there is a backend and from a snapshot where
 * there is not.
 *
 * Four screens read the ground station directly - Dataset, Data & Models,
 * Validation and Architecture. On a static host there is nobody to answer
 * them, and four screens reading BACKEND UNREACHABLE looks like a broken
 * build rather than the accurate statement it is.
 *
 * So the same payloads are also written to disk at build time by
 * `backend/tools/export_static_reports.py`, and this is the fallback. The
 * figures are identical - same functions, same files - and every consumer
 * renders a BUILD SNAPSHOT badge off the `snapshot` flag rather than passing
 * one off as a live reading.
 */

export type SnapshotName = 'dataset' | 'dictionary' | 'ml' | 'validation' | 'architecture'

/** True when this payload came from disk rather than from a running backend. */
export interface Snapshotted {
  snapshot?: boolean
  generated_at?: string
}

/**
 * Try the backend; fall back to the committed snapshot.
 *
 * Returns null only when both are unavailable, which the caller must still
 * render as an empty state - a bundle built without running the export script
 * has genuinely got nothing to show.
 */
export async function liveOrSnapshot<T extends Snapshotted>(
  live: () => Promise<T | null>,
  name: SnapshotName,
): Promise<T | null> {
  const answer = await live()
  if (answer) return answer
  return loadSnapshot<T>(name)
}

export async function loadSnapshot<T extends Snapshotted>(name: SnapshotName): Promise<T | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}reports/${name}.json`)
    if (!response.ok) return null
    // A single-page host rewrites unknown paths to index.html and answers 200
    // with HTML. Parsing that throws, which would look identical to "no
    // snapshot shipped" - so the content type is checked and a misconfigured
    // rewrite is reported rather than silently degrading every reference
    // screen to an empty state.
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('json')) {
      console.warn(
        `[aerotwin] reports/${name}.json was answered as ${type || 'an unknown type'} - ` +
        'the host is rewriting it to the app shell. Exclude /reports/ from the SPA rewrite.',
      )
      return null
    }
    return (await response.json()) as T
  } catch {
    return null
  }
}

/** "2026-08-27 06:41 UTC" from an ISO stamp, for the badge's title. */
export function snapshotAge(value?: string): string {
  if (!value) return 'build time'
  return String(value).replace('T', ' ').replace('+00:00', ' UTC').replace('Z', ' UTC')
}
