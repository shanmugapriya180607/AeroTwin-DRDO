/** Wire types. These mirror the backend's response shapes exactly. */

export type Provenance = 'REAL' | 'SIMULATED' | 'DERIVED' | 'DEMO'
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNCLASSIFIED' | 'NONE'
export type EngineState = 'NORMAL' | 'DEGRADED' | 'WARNING' | 'CRITICAL' | 'CAUTION'

export interface Channel {
  key: string
  label: string
  unit: string
  group: string
  provenance: Provenance
  per_cylinder: boolean
  note: string
  value?: number | null
  live?: boolean
}

export interface ResidualWire {
  r: number
  z: number
  e: number
  c: number
}

export interface ChannelResidual {
  key: string
  observed: number
  expected: number
  residual: number
  normalised: number
  ewma: number
  cusum: number
  scale: number
  unit: string
}

export interface Tick {
  t: number
  wall_clock: string
  flight_id: string
  phase: string
  regime: string
  channels: Record<string, number>
  expected: Record<string, number>
  residuals: Record<string, ResidualWire>
  inputs: Record<string, number>
  power_fraction: number
  power_hp: number
  tas_kt: number
  steady: boolean
  sync_pct: number
}

export interface CylinderHealth {
  index: number
  health: number
  status: string
  cht_observed: number
  cht_expected: number
  cht_residual: number
  cht_drift: number
  egt_observed: number
  egt_expected: number
  egt_residual: number
  egt_drift: number
  trim_divergence_pct: number
  asymmetry_c: number
  margin_to_redline_c: number
}

export interface Prognosis {
  [key: string]: any
}

export interface EngineSummary {
  engine_id: string
  /** Null when the twin has abstained: the model does not apply to the
   *  connected source, so there is no health verdict to report. */
  health_index: number | null
  health_valid?: boolean
  envelope?: {
    state: string
    diagnosis_permitted: boolean
    localisation_permitted: boolean
    health_valid: boolean
    reasons: string[]
    summary: string
    coverage: { present: number; total: number; pct: number; missing: string[]; cylinder_channels: number }
    limits: Array<{ quantity: string; value: number; min: number; max: number; within: boolean }>
    model: Record<string, unknown>
  }
  status: EngineState
  reason: string
  confidence: number | null
  model_state: string
  model_gated: boolean
  sync_pct: number
  cylinders: CylinderHealth[]
  anomaly_count: number
  advisory_count: number
  threshold_count: number
  prognosis: Prognosis | null
  health_history: Array<{
    flight_id: string
    label: string
    health: number
    profile_id: string
    status: string
    peak_residual_c: number
    notes: string
    live?: boolean
  }>
  phase: string
  regime: string
  power_pct: number
  power_hp: number
}

export interface TelemetryFrame {
  tick: Tick
  engine: EngineSummary
  provenance: { real: number; simulated: number; demo?: number; mode?: string }
  datalink: DatalinkState
  source: SourceDescriptor
}

export interface DatalinkState {
  connected: boolean
  status: string
  last_valid: string
  lost_at: string | null
  rate_hz: number
  twin_state: string
  diagnostics_state: string
}

export interface SourceDescriptor {
  id: string
  label: string
  kind: string
  provenance: Provenance
  detail: string
  rate_hz: number
  available?: boolean
}

export interface ResidualFrame {
  t: number
  sync_pct: number
  channels: Record<string, ChannelResidual>
  estimator: EstimatorSnapshot
  asymmetry: { cht: number; egt: number }
  steady: boolean
  regime: string
}

export interface EstimatorSnapshot {
  [key: string]: any
}

export interface FeatureContribution {
  feature: string
  label: string
  value: number
  unit: string
  contribution: number
}

export interface LearnedVerdict {
  available: boolean
  trained: boolean
  score: number
  raw: number
  verdict: string
  reason: string
  contributions: Array<{ feature: string; label: string; unit: string; share: number; delta: number }>
  baseline_score?: number
  fused_score?: number
  provenance?: string
  agreement?: string
}

export interface Anomaly {
  id: string
  rank: number
  title: string
  subsystem: string
  cylinder: number | null
  severity: Severity
  score: number
  confidence: number
  confidence_raw: number
  calibrated: boolean
  abstained: boolean
  abstain_reason: string | null
  mechanism: string | null
  mechanism_label: string | null
  mechanism_qualifier: string
  summary: string
  residual: number
  residual_unit: string
  trend: string
  regimes: string[]
  regime_count: number
  flights: number
  samples: number
  first_seen_t: number
  last_seen_t: number
  contributions: FeatureContribution[]
  supporting: Record<string, any>
  learned: LearnedVerdict | Record<string, never>
}

export interface Advisory {
  [key: string]: any
}

export interface AlertFrame {
  anomalies: Anomaly[]
  advisories: Advisory[]
  threshold: Array<{ level: string; channel: string; message: string; [k: string]: any }>
  engine_state: string
  engine_reason: string
  log?: EventEntry[]
}

export interface EventEntry {
  t: string
  level: string
  source: string
  message: string
}

export interface Waypoint {
  id: string
  label: string
  x: number
  y: number
  kind: string
  note: string
  grid: string
}

export interface Sector {
  name: string
  classification: string
  extent_km: [number, number, number, number]
  note: string
  waypoints: Waypoint[]
  route: Array<{ x: number; y: number; id: string }>
  orbit: Array<{ x: number; y: number }>
  orbit_radius_km: number
}

export interface MissionPosition {
  x: number
  y: number
  heading: number
  leg: string
  grid: string
  distance_to_base_km: number
}

export interface MissionFrame {
  mission: {
    id: string
    name: string
    uav_id: string
    engine_id: string
    airframe: string
    profile_id: string
    flight_id: string
    started_at: string
    status: string
    phase: string
    elapsed_s: number
    duration_s: number
    progress: number
    sector: string
    position: MissionPosition
  }
  altitude_ft: number
  ias_kt: number
  rpm: number
  oat_c: number
  power_pct: number
  demo_active: boolean
  time_scale: number
}

export interface SystemStatus {
  product: string
  subtitle: string
  programme: string
  build_status: string
  airworthiness_notice: string
  boot: {
    status: string
    progress: number
    message: string
    steps: Array<{ key: string; label: string; status: string; detail: string }>
  }
  system: string
  datalink: DatalinkState
  twin: { state: string; sync_pct: number; samples: number; buffer: number }
  model: Record<string, any>
  mission_status: string
  running: boolean
  paused: boolean
  demo_active: boolean
  time_scale: number
  uptime_s: number
  deployment: Record<string, any>
  engine: Record<string, any>
  model_id: string
  model_version: string
  dataset: string
}

export interface Prediction {
  health: number | null
  health_status: string
  anomaly: boolean
  anomaly_score: number | null
  fault: {
    mechanism: string
    label: string
    qualifier: string
    cylinder: number | null
    statement: string
  } | null
  confidence: number | null
  top_features: Array<{
    feature: string
    label: string
    unit: string
    value: number
    share: number
    source: string
  }>
  model_version: string
  model_id: string
  abstained: boolean
  abstain_reason: string | null
  detail: Record<string, any>
}

export interface MlStatus {
  learned_model: Record<string, any>
  baseline_model: Record<string, any>
  features: Array<Record<string, any>>
  fusion: Record<string, any>
  fault_classification: Record<string, any>
  environment: Record<string, any>
}

export interface SeriesPoint {
  t: number
  observed: number
  expected: number
  residual: number
  drift: number
  phase: string
}

export type CameraMode = 'FOLLOW' | 'CINEMATIC' | 'SIDE' | 'GROUND CONTROL' | 'INSPECTION'
