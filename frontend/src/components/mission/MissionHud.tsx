/**
 * Fullscreen mission control overlay.
 *
 * Drawn above the persistent 3D stage. Every figure here is the twin's own -
 * flight state from the flight model that is actually moving the aircraft,
 * engine state from the same telemetry the health pages read.
 */

import { useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Camera, Cpu, Gauge } from 'lucide-react'
import { useTwin } from '../../store/useTwin'
import { flightDynamics } from '../uav/flight'
import { Badge, Meter, StatusBadge, clock, fmt } from '../ui/Primitives'

const CAMERA_MODES = ['FOLLOW', 'CINEMATIC', 'SIDE', 'GROUND CONTROL', 'INSPECTION'] as const

function LiveNumber({
  read,
  digits = 0,
  style,
}: {
  read: () => number
  digits?: number
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (ref.current) {
        const v = read()
        ref.current.textContent = digits ? v.toFixed(digits) : Math.round(v).toLocaleString()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [read, digits])
  return <span ref={ref} className="num" style={style}>0</span>
}

export function MissionHud() {
  const exitMission = useTwin((s) => s.exitMission)
  const cameraMode = useTwin((s) => s.cameraMode)
  const setCameraMode = useTwin((s) => s.setCameraMode)
  const mission = useTwin((s) => s.mission)
  const telemetry = useTwin((s) => s.telemetry)
  const alerts = useTwin((s) => s.alerts)
  const mode = useTwin((s) => s.mode)

  const engine = telemetry?.engine
  const top = alerts?.anomalies?.find((a) => !a.abstained) ?? null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitMission()
      const index = Number(e.key)
      if (index >= 1 && index <= CAMERA_MODES.length) setCameraMode(CAMERA_MODES[index - 1])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exitMission, setCameraMode])

  return (
    <motion.div
      className="mission-hud"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, delay: 0.35 }}
    >
      {/* --- HUD frame corners ------------------------------------------- */}
      <div className="hud-corner" style={{ left: 14, top: 14, borderRight: 'none', borderBottom: 'none' }} />
      <div className="hud-corner" style={{ right: 14, top: 14, borderLeft: 'none', borderBottom: 'none' }} />
      <div className="hud-corner" style={{ left: 14, bottom: 14, borderRight: 'none', borderTop: 'none' }} />
      <div className="hud-corner" style={{ right: 14, bottom: 14, borderLeft: 'none', borderTop: 'none' }} />

      {/* --- top bar ------------------------------------------------------ */}
      <div className="hud-bar">
        <button className="btn btn--ghost btn--sm" onClick={exitMission}>
          <ArrowLeft size={13} /> Return to command
        </button>
        <div style={{ width: 1, height: 22, background: 'var(--hairline-strong)' }} />
        <div className="stat stat--sm">
          <span className="stat__k">Mission</span>
          <span className="stat__v" style={{ fontSize: 14 }}>{mission?.mission?.id ?? 'ISR-047'}</span>
        </div>
        <div className="stat stat--sm">
          <span className="stat__k">UAV</span>
          <span className="stat__v" style={{ fontSize: 14 }}>{mission?.mission?.uav_id ?? 'UAV-01'}</span>
        </div>
        <div className="stat stat--sm">
          <span className="stat__k">Phase</span>
          <span className="stat__v" style={{ fontSize: 14 }}>{telemetry?.tick?.phase ?? '—'}</span>
        </div>
        <div className="stat stat--sm">
          <span className="stat__k">Sector</span>
          <span className="stat__v" style={{ fontSize: 14 }}>{mission?.mission?.sector ?? 'TRAINING SECTOR ALPHA'}</span>
        </div>
        <span className="spacer" />
        {mode === 'DEMO' && <Badge tone="demo" dot live>DEMO FEED</Badge>}
        <Badge tone="info">UNCLASSIFIED / TRAINING</Badge>
      </div>

      <span className="spacer" />

      {/* --- bottom row --------------------------------------------------- */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
        {/* flight state */}
        <div className="hud-panel" style={{ minWidth: 268 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Gauge size={13} color="var(--accent-ink)" />
            <span className="label" style={{ color: 'var(--ink-3)' }}>Flight state</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px' }}>
            <div className="stat stat--sm">
              <span className="stat__k">Altitude</span>
              <span className="stat__v" style={{ fontSize: 18 }}>
                <LiveNumber read={() => flightDynamics.state.altitudeFt} />
                <span className="stat__u">ft</span>
              </span>
            </div>
            <div className="stat stat--sm">
              <span className="stat__k">IAS</span>
              <span className="stat__v" style={{ fontSize: 18 }}>
                <LiveNumber read={() => flightDynamics.state.speedKt} />
                <span className="stat__u">kt</span>
              </span>
            </div>
            <div className="stat stat--sm">
              <span className="stat__k">Heading</span>
              <span className="stat__v" style={{ fontSize: 18 }}>
                <LiveNumber read={() => ((flightDynamics.state.heading * 180) / Math.PI + 360) % 360} />
                <span className="stat__u">°</span>
              </span>
            </div>
            <div className="stat stat--sm">
              <span className="stat__k">Bank</span>
              <span className="stat__v" style={{ fontSize: 18 }}>
                <LiveNumber read={() => (flightDynamics.state.bank * 180) / Math.PI} digits={1} />
                <span className="stat__u">°</span>
              </span>
            </div>
          </div>
        </div>

        {/* engine state */}
        <div className="hud-panel" style={{ minWidth: 250 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Cpu size={13} color="var(--accent-ink)" />
            <span className="label" style={{ color: 'var(--ink-3)' }}>Propulsion</span>
            <span className="spacer" />
            <StatusBadge status={engine?.status} />
          </div>
          <div className="stat" style={{ marginBottom: 9 }}>
            <span className="stat__k">Engine health index</span>
            <span
              className="stat__v"
              style={{
                fontSize: 28,
                color:
                  (engine?.health_index ?? 100) >= 90 ? 'var(--ok-ink)'
                    : (engine?.health_index ?? 100) >= 78 ? 'var(--caution-ink)'
                      : 'var(--warn-ink)',
              }}
            >
              {fmt(engine?.health_index, 1)}
            </span>
          </div>
          <Meter
            value={engine?.health_index ?? 0}
            tone={
              (engine?.health_index ?? 100) >= 90 ? 'ok'
                : (engine?.health_index ?? 100) >= 78 ? 'caution' : 'warn'
            }
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px 16px', marginTop: 11 }}>
            <div className="stat stat--sm">
              <span className="stat__k">RPM</span>
              <span className="stat__v" style={{ fontSize: 16 }}>
                {Math.round(telemetry?.tick?.channels?.rpm ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="stat stat--sm">
              <span className="stat__k">Power</span>
              <span className="stat__v" style={{ fontSize: 16 }}>
                {fmt(engine?.power_pct, 0)}<span className="stat__u">%</span>
              </span>
            </div>
          </div>
        </div>

        {/* mission progress */}
        <div className="hud-panel" style={{ flex: 1, minWidth: 240 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="label" style={{ color: 'var(--ink-3)' }}>Mission progress</span>
            <span className="spacer" />
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
              NEXT · {flightDynamics.activeLeg?.id ?? '—'}
            </span>
          </div>
          <Meter value={(mission?.mission?.progress ?? 0) * 100} tall />
          <div className="row" style={{ marginTop: 9, justifyContent: 'space-between' }}>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
              T+ {clock(mission?.mission?.elapsed_s)}
            </span>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>
              {((mission?.mission?.progress ?? 0) * 100).toFixed(1)}% · {mission?.mission?.position?.grid ?? '—'}
            </span>
          </div>
          {top && (
            <div
              style={{
                marginTop: 11,
                paddingTop: 10,
                borderTop: '1px solid var(--hairline)',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
              }}
            >
              <Badge tone={top.severity === 'HIGH' ? 'crit' : 'warn'} dot live>
                {top.title}
              </Badge>
              <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>{top.summary}</span>
            </div>
          )}
        </div>

        {/* camera modes */}
        <div className="hud-panel">
          <div className="row" style={{ marginBottom: 8 }}>
            <Camera size={13} color="var(--accent-ink)" />
            <span className="label" style={{ color: 'var(--ink-3)' }}>Camera</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {CAMERA_MODES.map((m, i) => (
              <button
                key={m}
                className={`btn btn--sm ${cameraMode === m ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setCameraMode(m)}
                style={{ justifyContent: 'flex-start' }}
              >
                <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>{i + 1}</span>
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
