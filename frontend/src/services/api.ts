/**
 * REST client.
 *
 * Every call is failure-tolerant on purpose. If the backend is not running the
 * interface must stay demonstrable rather than collapse into an error page, so
 * a failed call resolves to null and the caller falls back to the local demo
 * generator - which labels itself DEMO wherever it appears.
 */

/**
 * Where the backend is.
 *
 * Empty by default: the dev server proxies /api to the local backend, and in
 * production the backend serves the built frontend itself, so same-origin is
 * correct in both. Set VITE_API_BASE when the two are deployed apart - a static
 * host such as Vercel serving the console against a backend hosted elsewhere.
 *
 * With no backend reachable at all, every call resolves to null and the store
 * falls back to the local demo generator, which labels itself DEMO throughout.
 */
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

let online = true
const listeners = new Set<(v: boolean) => void>()

export function onConnectivity(fn: (v: boolean) => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function setOnline(value: boolean) {
  if (value === online) return
  online = value
  listeners.forEach((fn) => fn(value))
}

export function isOnline() {
  return online
}

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
    if (!response.ok) {
      if (response.status >= 500) setOnline(false)
      return null
    }
    setOnline(true)
    return (await response.json()) as T
  } catch {
    setOnline(false)
    return null
  }
}

export const api = {
  systemStatus: () => request<any>('/api/system/status'),
  systemLog: (limit = 120) => request<any>(`/api/system/log?limit=${limit}`),
  architecture: () => request<any>('/api/system/architecture'),
  setDatalink: (connected: boolean) =>
    request<any>('/api/system/datalink', { method: 'POST', body: JSON.stringify({ connected }) }),

  mission: () => request<any>('/api/mission/current'),
  sector: () => request<any>('/api/mission/sector'),
  profiles: () => request<any>('/api/mission/profiles'),

  engineStatus: () => request<any>('/api/engine/status'),
  cylinders: () => request<any>('/api/engine/cylinders'),
  comparison: () => request<any>('/api/engine/comparison'),

  telemetry: () => request<any>('/api/telemetry/latest'),
  channels: () => request<any>('/api/telemetry/channels'),
  series: (channel: string, limit = 600) =>
    request<any>(`/api/telemetry/series?channel=${encodeURIComponent(channel)}&limit=${limit}`),

  residuals: () => request<any>('/api/residuals'),
  twinState: () => request<any>('/api/twin/state'),

  anomalies: () => request<any>('/api/anomalies'),
  prediction: () => request<any>('/api/prediction'),
  maintenance: () => request<any>('/api/maintenance'),
  validation: () => request<any>('/api/validation'),
  sources: () => request<any>('/api/sources'),

  flights: () => request<any>('/api/flights'),
  flight: (id: string) => request<any>(`/api/flights/${encodeURIComponent(id)}`),

  mlStatus: () => request<any>('/api/ml/status'),

  datasetStatus: () => request<any>('/api/dataset/status'),
  datasetValidate: () => request<any>('/api/dataset/validate'),
  datasetActivate: (file?: string) =>
    request<any>('/api/dataset/activate', { method: 'POST', body: JSON.stringify({ file: file ?? null }) }),
  datasetRestore: () => request<any>('/api/dataset/restore', { method: 'POST' }),

  dataDictionary: () => request<any>('/api/data/dictionary'),
  refreshDictionary: () => request<any>('/api/data/dictionary/refresh', { method: 'POST' }),
  predict: (body?: { channels?: Record<string, number>; inputs?: Record<string, number> }) =>
    request<any>('/api/predict', { method: 'POST', body: JSON.stringify(body ?? {}) }),

  runSimulation: (body: Record<string, unknown>) =>
    request<any>('/api/simulation/start', { method: 'POST', body: JSON.stringify(body) }),
  simulation: (id: string) => request<any>(`/api/simulation/${encodeURIComponent(id)}`),

  setSpeed: (time_scale: number) =>
    request<any>('/api/replay/speed', { method: 'POST', body: JSON.stringify({ time_scale }) }),
  pause: () => request<any>('/api/replay/pause', { method: 'POST' }),
  resume: () => request<any>('/api/replay/resume', { method: 'POST' }),
  step: (samples = 1) =>
    request<any>('/api/replay/step', { method: 'POST', body: JSON.stringify({ samples }) }),
  stopReplay: () => request<any>('/api/replay/stop', { method: 'POST' }),
  resetReplay: () => request<any>('/api/replay/reset', { method: 'POST' }),
  seek: (t: number) => request<any>('/api/replay/seek', { method: 'POST', body: JSON.stringify({ t }) }),

  startDemo: () => request<any>('/api/demo/start', { method: 'POST' }),
  stopDemo: () => request<any>('/api/demo/stop', { method: 'POST' }),
}
