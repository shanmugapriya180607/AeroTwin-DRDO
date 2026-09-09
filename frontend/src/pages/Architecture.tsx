/**
 * System architecture.
 *
 * Four lanes, left to right, with the state-feedback arm drawn explicitly
 * because it is the difference between a twin and a simulation running next to
 * a sensor feed. The data-source lane is the other thing worth reading
 * carefully: all three inputs present the same interface, which is what makes
 * the corpus swappable.
 */

import { useEffect, useState } from 'react'
import { ArrowRight, Boxes, Repeat, Server } from 'lucide-react'
import { api } from '../services/api'
import { liveOrSnapshot, snapshotAge } from '../services/reports'
import { Badge, Empty, Kv, Loading, PageHead } from '../components/ui/Primitives'

export default function Architecture() {
  const [data, setData] = useState<any>(null)
  /* Distinguish 'not fetched yet' from 'not available'. */
  const [loaded, setLoaded] = useState(false)
  const [pulse, setPulse] = useState(0)

  useEffect(() => {
    void liveOrSnapshot(api.architecture, 'architecture').then((result) => {
      if (result) setData(result)
      setLoaded(true)
    })
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setPulse((p) => p + 1), 700)
    return () => window.clearInterval(timer)
  }, [])

  const lanes = data?.lanes ?? []
  const totalNodes = lanes.reduce((sum: number, lane: any) => sum + lane.nodes.length, 0)
  let cursor = 0

  return (
    <>
      <PageHead
        title="System Architecture"
        actions={
          <div className="row row--tight">
            {data?.snapshot && (
              <Badge tone="caution" title={`Captured at build time, ${snapshotAge(data.generated_at)}`}>
                BUILD SNAPSHOT
              </Badge>
            )}
            <Badge tone="info">ISO 23247 ALIGNED · ON-PREMISE</Badge>
          </div>
        }
      />

      {!loaded ? (
        <Loading height={320} />
      ) : !lanes.length ? (
        <Empty
          label="Architecture unavailable"
          detail="RUNNING ON DEMO FEED"
        />
      ) : (
        <>
          <section className="panel" style={{ marginBottom: 16 }}>
            <header className="panel__head">
              <Boxes size={13} color="var(--accent-ink)" />
              <h2 className="panel__title">Data flow</h2>
              <span className="panel__spacer" />
              <Badge tone="residual">RESIDUAL-DRIVEN</Badge>
            </header>
            <div className="panel__body">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))`,
                  gap: 14,
                  alignItems: 'start',
                }}
              >
                {lanes.map((lane: any, laneIndex: number) => (
                  <div key={lane.id}>
                    <div className="row" style={{ marginBottom: 10 }}>
                      <span className="label" style={{ color: 'var(--accent-ink)' }}>{lane.title}</span>
                      {laneIndex < lanes.length - 1 && (
                        <>
                          <span className="spacer" />
                          <ArrowRight size={13} color="var(--ink-4)" />
                        </>
                      )}
                    </div>
                    <div className="stack stack--sm">
                      {lane.nodes.map((node: any) => {
                        const index = cursor
                        cursor += 1
                        const lit = totalNodes > 0 && pulse % totalNodes === index
                        return (
                          <div
                            key={node.id}
                            className={`tile ${lit ? 'flow__node--active' : ''}`}
                            style={{
                              borderColor: lit ? 'rgba(10,110,214,0.5)' : undefined,
                              transition: 'border-color 320ms, background 320ms',
                              background: lit ? 'rgba(10,110,214,0.07)' : undefined,
                            }}
                          >
                            <div className="row row--tight">
                              <span
                                className="label"
                                style={{ color: lit ? 'var(--accent-ink)' : 'var(--ink-2)' }}
                              >
                                {node.label}
                              </span>
                            </div>
                            <div className="micro" style={{ marginTop: 3 }}>{node.sub}</div>
                            <div
                              className="mono"
                              style={{
                                fontSize: 11,
                                marginTop: 5,
                                color:
                                  node.state?.includes('NOT') ? 'var(--caution-ink)'
                                    : node.state === 'DOCUMENTED' ? 'var(--ink-4)' : 'var(--ok-ink)',
                                letterSpacing: '0.1em',
                              }}
                            >
                              {node.state}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* feedback arm */}
              {data?.feedback && (
                <div
                  className="row"
                  style={{
                    marginTop: 16,
                    padding: '11px 14px',
                    border: '1px dashed rgba(225,50,50,0.36)',
                    borderRadius: 'var(--r)',
                    background: 'rgba(225,50,50,0.045)',
                    alignItems: 'flex-start',
                  }}
                >
                  <Repeat size={15} color="var(--crit-ink)" style={{ marginTop: 2 }} />
                  <div>
                    <div className="row row--tight" style={{ marginBottom: 4 }}>
                      <span className="label" style={{ color: 'var(--crit-ink)' }}>{data.feedback.label}</span>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-4)' }}>
                        {data.feedback.from} → {data.feedback.to}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', marginRight: 372 }}>
            <section className="panel">
              <header className="panel__head">
                <Server size={13} color="var(--accent-ink)" />
                <h2 className="panel__title">Deployment chain</h2>
                <span className="panel__spacer" />
                <Badge tone="ok">ON-PREMISE · AIR-GAPPED READY</Badge>
              </header>
              <div className="panel__body">
                <div className="flow">
                  {(data?.deployment_chain ?? []).map((node: any, i: number, arr: any[]) => (
                    <div key={node.id} style={{ display: 'contents' }}>
                      <div className="flow__node" style={{ minWidth: 104 }}>
                        <div className="flow__label">{node.label}</div>
                        <div className="flow__state">{node.sub}</div>
                      </div>
                      {i < arr.length - 1 && (
                        <div className="flow__arrow"><ArrowRight size={12} /></div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="row row--tight row--wrap" style={{ marginTop: 14 }}>
                  {(data?.deployment_tags ?? []).map((tag: string) => (
                    <Badge key={tag} tone="info">{tag}</Badge>
                  ))}
                </div>
              </div>
            </section>

            <section className="panel">
              <header className="panel__head">
                <h2 className="panel__title">Source adapters</h2>
                <span className="panel__spacer" />
                <Badge tone="info">SWAPPABLE SOURCE</Badge>
              </header>
              <div className="panel__body">
                <div className="stack stack--sm">
                  {[
                    { from: 'OPEN PISTON-ENGINE CORPUS', to: 'DATA ADAPTER', state: 'VALIDATED HERE' },
                    { from: 'LIVE CAN TELEMETRY', to: 'DATA ADAPTER', state: 'INTERFACE READY' },
                    { from: 'AUTHORISED TEST-RIG EXPORT', to: 'DATA ADAPTER', state: 'FUTURE' },
                  ].map((row) => (
                    <div className="tile" key={row.from}>
                      <div className="row row--tight">
                        <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{row.from}</span>
                        <ArrowRight size={11} color="var(--ink-4)" />
                        <span className="mono" style={{ fontSize: 12, color: 'var(--accent-ink)' }}>{row.to}</span>
                        <span className="spacer" />
                        <Badge tone={row.state === 'FUTURE' ? 'neutral' : 'ok'}>{row.state}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="divider" />
                <Kv
                  items={[
                    ['Interface', 'DataSource'],
                    ['Contract', '1 Hz frame: channels + inputs + phase'],
                    ['Downstream change required', 'NONE'],
                  ]}
                />
              </div>
            </section>
          </div>
        </>
      )}
    </>
  )
}
