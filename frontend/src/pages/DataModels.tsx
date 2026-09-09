/**
 * Data & Models.
 *
 * What is mounted, what mapped, what the models are. All of it as status rows
 * and tags rather than prose: the page is read at a glance during a
 * demonstration, not studied.
 *
 * The corpus state is the honest one. With no operator corpus configured the
 * bundled demo flights mount and the page says DEMO everywhere - it never
 * reports a configuration error for a condition the product is designed to run
 * in, and it never calls synthetic data measured.
 */

import { useEffect, useState } from 'react'
import { Braces, Database, RefreshCw, Terminal } from 'lucide-react'
import { api } from '../services/api'
import { liveOrSnapshot, snapshotAge } from '../services/reports'
import {
  Badge,
  Empty,
  Loading,
  Metrics,
  PageHead,
  ProvenanceTag,
  StatusRows,
  fmt,
  pct,
} from '../components/ui/Primitives'

export default function DataModels() {
  const [dictionary, setDictionary] = useState<any>(null)
  const [prediction, setPrediction] = useState<any>(null)
  const [refreshing, setRefreshing] = useState(false)
  /* null means 'not fetched yet' as well as 'not available', and the two
     must not look the same on screen. */
  const [loaded, setLoaded] = useState(false)

  const load = async () => {
    // The dictionary falls back to the build-time snapshot where no ground
    // station answers. The live prediction does not: it is a reading of a
    // running twin, and a frozen copy of one would be a fiction.
    const [dict, predict] = await Promise.all([
      liveOrSnapshot(api.dataDictionary, 'dictionary'),
      api.predict(),
    ])
    if (dict) setDictionary(dict)
    if (predict) setPrediction(predict)
    setLoaded(true)
  }

  /** True when this page is reading a snapshot rather than a live backend. */
  const fromSnapshot = !!dictionary?.snapshot

  useEffect(() => {
    void load()
  }, [])

  const refresh = async () => {
    setRefreshing(true)
    await api.refreshDictionary()
    await load()
    setRefreshing(false)
  }

  const channels = dictionary?.channels ?? []
  const ingest = dictionary?.ingest

  /* Only a genuine failure is red. A demo corpus is a normal operating state. */
  const state: string = ingest?.state ?? 'ACTIVE'
  const failed = state === 'LOAD FAILED'
  const needsConfig = state === 'CONFIGURATION REQUIRED'
  const real = ingest?.mode === 'REAL'

  return (
    <>
      <PageHead
        title="Data & Models"
        actions={
          <div className="row row--tight">
            {fromSnapshot && (
              <Badge tone="caution" title={`Captured at build time, ${snapshotAge(dictionary?.generated_at)}`}>
                BUILD SNAPSHOT
              </Badge>
            )}
            <Badge tone={real ? 'real' : 'demo'}>{ingest?.mode ?? 'DEMO'}</Badge>
            <Badge tone={failed ? 'crit' : needsConfig ? 'caution' : 'ok'} dot live={!failed && !needsConfig}>
              {state}
            </Badge>
            <button
              className="btn btn--sm"
              onClick={refresh}
              disabled={refreshing || fromSnapshot}
              title={fromSnapshot
                ? 'Rescanning the corpus needs the ground-station backend'
                : 'Re-read the corpus from disk'}
            >
              <RefreshCw size={12} /> {refreshing ? 'SCANNING' : 'RESCAN'}
            </button>
          </div>
        }
      />

      {/* ---- corpus ------------------------------------------------------- */}
      <section className="panel panel--marked" style={{ marginBottom: 16 }}>
        <header className="panel__head">
          <Database size={13} color="var(--accent-ink)" />
          <h2 className="panel__title">Corpus</h2>
          <span className="panel__spacer" />
          <Badge tone={real ? 'real' : 'demo'}>{real ? 'REAL' : 'SIMULATED'}</Badge>
        </header>
        <div className="panel__body panel__body--tight">
          {!loaded ? (
            <Loading height={132} />
          ) : !ingest ? (
            <Empty
              label="NO INGEST REPORT"
              detail="No ground station answered and no build-time report shipped with this bundle."
            />
          ) : (
            <>
              <Metrics
                cells={[
                  { k: 'STATUS', v: state, tone: failed ? 'crit' : needsConfig ? 'warn' : 'ok' },
                  { k: 'FILES', v: String(ingest.files ?? 0) },
                  { k: 'ROWS', v: (ingest.rows ?? 0).toLocaleString() },
                  {
                    k: 'CHANNELS',
                    v: `${ingest.mapped_channels ?? 0}/${ingest.required_channels ?? 0}`,
                    tone: ingest.mapped_channels === ingest.required_channels ? 'ok' : 'warn',
                  },
                  { k: 'RATE', v: `${fmt(ingest.rate_hz ?? 1, 0)}`, unit: 'HZ' },
                  {
                    k: 'PARQUET',
                    v: ingest.parquet ?? 'OPTIONAL',
                    tone: ingest.parquet === 'REQUIRED' ? 'crit' : undefined,
                  },
                ]}
              />

              {/* Only shown when something actually went wrong. */}
              {(failed || needsConfig) && (ingest.messages ?? []).map((message: string, i: number) => (
                <div key={i} className="row row--tight" style={{ marginTop: 10 }}>
                  <Badge tone={failed ? 'crit' : 'caution'}>{message}</Badge>
                </div>
              ))}

              {ingest.columns?.some((c: any) => c.matched_column) && (
                <div className="scroll-y" style={{ maxHeight: 210, marginTop: 12 }}>
                  <table className="table table--compact">
                    <thead>
                      <tr>
                        <th>CHANNEL</th>
                        <th>COLUMN</th>
                        <th className="num">NULL %</th>
                        <th className="num">MIN</th>
                        <th className="num">MAX</th>
                        <th className="num">MEAN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ingest.columns.map((column: any) => (
                        <tr key={column.key}>
                          <td className="mono">{column.key}</td>
                          <td
                            className="mono"
                            style={{ color: column.matched_column ? undefined : 'var(--caution-ink)' }}
                          >
                            {column.matched_column ?? 'ABSENT'}
                          </td>
                          <td className="num">{fmt(column.null_pct, 1)}</td>
                          <td className="num">{column.min ?? '—'}</td>
                          <td className="num">{column.max ?? '—'}</td>
                          <td className="num">{column.mean ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ---- data dictionary ---------------------------------------------- */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <header className="panel__head">
          <Braces size={13} color="var(--accent-ink)" />
          <h2 className="panel__title">Data dictionary</h2>
          <span className="panel__spacer" />
          <Badge tone="info">{channels.length} CHANNELS</Badge>
        </header>
        <div className="panel__body panel__body--flush">
          <div className="scroll-y" style={{ maxHeight: 340 }}>
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>CHANNEL</th>
                  <th>UNIT</th>
                  <th>GROUP</th>
                  <th className="num">RANGE</th>
                  <th>SOURCE</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((channel: any) => (
                  <tr key={channel.key}>
                    <td className="mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>
                      {channel.key.toUpperCase()}
                    </td>
                    <td className="dimmer">{channel.unit}</td>
                    <td className="dimmer">{channel.group}</td>
                    <td className="num dimmer">
                      {channel.valid_range
                        ? `${channel.valid_range[0]} – ${channel.valid_range[1]}`
                        : '—'}
                    </td>
                    <td>
                      <ProvenanceTag
                        provenance={
                          channel.provenance === 'REAL' && !real ? 'DEMO' : channel.provenance
                        }
                        title={channel.note}
                      />
                    </td>
                  </tr>
                ))}
                {!channels.length && (
                  <tr>
                    <td colSpan={5}>
                      {loaded ? <Empty label="UNAVAILABLE OFFLINE" /> : <Loading height={180} />}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- prediction contract ------------------------------------------- */}
      <section className="panel" style={{ marginRight: 372 }}>
        <header className="panel__head">
          <Terminal size={13} color="var(--accent-ink)" />
          <h2 className="panel__title">Prediction API</h2>
          <span className="panel__sub">POST /api/predict</span>
          <span className="panel__spacer" />
          <button
            className="btn btn--sm"
            disabled={!prediction}
            title={prediction ? 'Call the endpoint again' : 'Needs a running ground station'}
            onClick={() => void api.predict().then((r) => r && setPrediction(r))}
          >
            RE-RUN
          </button>
        </header>
        <div className="panel__body panel__body--tight">
          {!loaded ? (
            <Loading height={150} />
          ) : !prediction ? (
            /* Not an error. Every other panel on this page describes a
               contract and can be answered from a build-time snapshot; this
               one is a reading of a twin that is running right now, and a
               frozen copy of one would be a fiction. */
            <Empty
              label="LIVE ENDPOINT"
              detail="This panel calls the running twin. Start the ground station to exercise it."
            />
          ) : (
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.15fr)' }}>
              <StatusRows
                rows={[
                  { k: 'HEALTH', v: prediction.health !== null ? fmt(prediction.health, 1) : '—' },
                  { k: 'STATUS', v: String(prediction.health_status) },
                  {
                    k: 'ANOMALY',
                    v: prediction.anomaly ? 'TRUE' : 'FALSE',
                    tone: prediction.anomaly ? 'warn' : 'ok',
                  },
                  {
                    k: 'SCORE',
                    v: prediction.anomaly_score !== null ? fmt(prediction.anomaly_score, 3) : '—',
                  },
                  {
                    k: 'CONFIDENCE',
                    v: prediction.confidence !== null ? pct(prediction.confidence, 1) : 'ABSTAINED',
                  },
                  { k: 'MODEL', v: `${prediction.model_id} v${prediction.model_version}` },
                  ...(prediction.fault
                    ? [{ k: 'FAULT', v: String(prediction.fault.label).toUpperCase(), tone: 'warn' }]
                    : []),
                ]}
              />

              <div>
                <span className="micro">FEATURE ATTRIBUTION</span>
                <table className="table table--compact" style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>FEATURE</th>
                      <th className="num">VALUE</th>
                      <th className="num">SHARE</th>
                      <th>SOURCE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(prediction.top_features ?? []).map((feature: any, i: number) => (
                      <tr key={`${feature.feature}-${i}`}>
                        <td style={{ whiteSpace: 'normal' }}>{feature.label}</td>
                        <td className="num">{fmt(feature.value, 2)} {feature.unit}</td>
                        <td className="num">{fmt(feature.share, 3)}</td>
                        <td>
                          <Badge tone={feature.source === 'ISOLATION FOREST' ? 'info' : 'residual'}>
                            {feature.source === 'ISOLATION FOREST' ? 'FOREST' : 'PHYSICS'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                    {!prediction.top_features?.length && (
                      <tr><td colSpan={4}><span className="dimmer">NO ATTRIBUTION</span></td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  )
}
