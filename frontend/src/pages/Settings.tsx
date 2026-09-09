/**
 * Settings.
 *
 * Only what the console can actually honour. There is no entry here for a
 * preference the product would quietly ignore - a switch that does nothing is
 * worse than no switch, because it teaches the operator that the settings
 * screen lies.
 *
 * Operating mode is shown but not chosen: whether the console is live or on
 * local data is a fact about the ground station, not a preference. Forcing
 * OFFLINE while a backend is answering would mean showing stale numbers next
 * to a live link, so the row reports and the datalink control - which the
 * backend really does implement - is offered instead.
 */

import { useEffect, useState } from 'react'
import {
  Bell, BellOff, Circle, Gauge, Monitor, Moon, PlayCircle, Radio, Repeat,
  RotateCcw, Sun, Volume2, VolumeX, Wifi, WifiOff, Zap,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../services/api'
import { useTwin } from '../store/useTwin'
import { useSettings, type Theme } from '../store/useSettings'
import {
  onVoiceStatus, speakTest, unlockVoice, voiceStatus, type VoiceStatus,
} from '../services/voice'
import { Badge, Note, PageHead, Panel } from '../components/ui/Primitives'

/** A labelled switch. The state is stated in words as well as position - a
 *  knob on its own is a guess in a screenshot or on a projector. */
function Toggle({
  on,
  onChange,
  onLabel,
  offLabel,
  disabled,
}: {
  on: boolean
  onChange: (v: boolean) => void
  onLabel: string
  offLabel: string
  disabled?: boolean
}) {
  return (
    <button
      className={`switch ${on ? 'switch--on' : ''}`}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="switch__track"><span className="switch__knob" /></span>
      <span className="switch__label">{on ? onLabel : offLabel}</span>
    </button>
  )
}

function Row({
  icon,
  title,
  detail,
  children,
}: {
  icon: React.ReactNode
  title: string
  detail: string
  children: React.ReactNode
}) {
  return (
    <div className="setting">
      <span className="setting__icon">{icon}</span>
      <div className="setting__text">
        <span className="setting__title">{title}</span>
        <span className="setting__detail">{detail}</span>
      </div>
      <div className="setting__control">{children}</div>
    </div>
  )
}

export default function Settings() {
  const navigate = useNavigate()
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const notifications = useSettings((s) => s.notifications)
  const alertSound = useSettings((s) => s.alertSound)
  const animation = useSettings((s) => s.animation)
  const voiceAlerts = useSettings((s) => s.voiceAlerts)
  const voiceVolume = useSettings((s) => s.voiceVolume)
  const voiceRepeat = useSettings((s) => s.voiceRepeat)
  const toggleVoice = useSettings((s) => s.toggleVoice)
  const setSetting = useSettings((s) => s.set)

  /* Whether the browser can speak at all, and whether it is allowed to yet. */
  const [voice, setVoice] = useState<VoiceStatus>(() => voiceStatus())
  const [tested, setTested] = useState<boolean | null>(null)
  useEffect(() => onVoiceStatus(() => setVoice(voiceStatus())), [])

  const mode = useTwin((s) => s.mode)
  const status = useTwin((s) => s.status)
  const telemetry = useTwin((s) => s.telemetry)
  const replayIntro = useTwin((s) => s.replayIntro)
  const refreshStatus = useTwin((s) => s.refreshStatus)

  const [linkBusy, setLinkBusy] = useState(false)
  const connected = telemetry?.datalink?.connected !== false
  const live = mode === 'LIVE'

  /* The OS reduced-motion setting is a floor the preference cannot lift, so
     the row has to say when it is the thing in charge. */
  const [osReduced, setOsReduced] = useState(false)
  useEffect(() => {
    try {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)')
      setOsReduced(query.matches)
      const onChange = () => setOsReduced(query.matches)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    } catch {
      return undefined
    }
  }, [])

  const toggleDatalink = async () => {
    setLinkBusy(true)
    try {
      await api.setDatalink(!connected)
      await refreshStatus()
    } finally {
      setLinkBusy(false)
    }
  }

  return (
    <>
      <PageHead
        title="Settings"
        sub="How this console looks and behaves. Every switch here changes something; nothing on this screen is decoration."
        actions={
          <Badge tone={live ? 'ok' : 'demo'} dot live>
            {live ? 'LIVE DATA' : 'LOCAL DATA'}
          </Badge>
        }
      />

      <div className="grid grid--2">
        <Panel title="Appearance" sub="THEME">
          <div className="stack">
            <Row
              icon={theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
              title="Theme"
              detail="Light for a lit room or a projector; dark for an operations desk."
            >
              <div className="btn-group">
                {(['light', 'dark'] as Theme[]).map((option) => (
                  <button
                    key={option}
                    className={`btn btn--sm ${theme === option ? 'btn--active' : ''}`}
                    onClick={() => setTheme(option)}
                    aria-pressed={theme === option}
                  >
                    {option === 'light' ? <Sun size={13} /> : <Moon size={13} />}
                    {option === 'light' ? 'Light' : 'Dark'}
                  </button>
                ))}
              </div>
            </Row>

            <div className="divider" />

            <Row
              icon={<Zap size={16} />}
              title="Animation"
              detail={
                osReduced
                  ? 'Held off: this machine is set to reduced motion, which overrides the choice here.'
                  : 'Route transitions, the aircraft in the corner, chart tweens.'
              }
            >
              <Toggle
                on={animation && !osReduced}
                disabled={osReduced}
                onChange={(v) => setSetting('animation', v)}
                onLabel="On"
                offLabel="Off"
              />
            </Row>
          </div>
        </Panel>

        <Panel title="Alerts" sub="NOTIFICATIONS">
          <div className="stack">
            <Row
              icon={notifications ? <Bell size={16} /> : <BellOff size={16} />}
              title="Notifications"
              detail="Raise a toast and a bell count when the detector flags a new deviation."
            >
              <Toggle
                on={notifications}
                onChange={(v) => setSetting('notifications', v)}
                onLabel="On"
                offLabel="Off"
              />
            </Row>

            <div className="divider" />

            <Row
              icon={alertSound ? <Volume2 size={16} /> : <VolumeX size={16} />}
              title="Alert sound"
              detail="A short tone with a critical alert only. Never on a warning, never on load."
            >
              <Toggle
                on={alertSound}
                disabled={!notifications}
                onChange={(v) => setSetting('alertSound', v)}
                onLabel="On"
                offLabel="Off"
              />
            </Row>

            {!notifications && (
              <Note tone="warn">
                Deviations are still detected and still listed under Diagnostics. Only the
                interruption is off.
              </Note>
            )}
          </div>
        </Panel>

        <Panel
          title="Voice alerts"
          sub="AI-ASSISTED ANNOUNCEMENT"
          actions={
            <Badge tone={voice === 'READY' ? 'ok' : voice === 'LOCKED' ? 'caution' : 'neutral'}>
              {voice === 'READY' ? 'AVAILABLE' : voice === 'LOCKED' ? 'AWAITING INTERACTION' : 'UNAVAILABLE'}
            </Badge>
          }
        >
          <div className="stack">
            <Row
              icon={voiceAlerts ? <Volume2 size={16} /> : <VolumeX size={16} />}
              title="Voice alerts"
              detail="Speak warning and critical findings aloud. Informational findings are recorded silently."
            >
              <Toggle
                on={voiceAlerts && voice !== 'UNAVAILABLE'}
                disabled={voice === 'UNAVAILABLE'}
                onChange={() => { unlockVoice(); toggleVoice() }}
                onLabel="On"
                offLabel="Off"
              />
            </Row>

            <div className="divider" />

            <Row
              icon={<Gauge size={16} />}
              title="Volume"
              detail="Applies to the announcement and the short tone before it."
            >
              <div className="row row--tight" style={{ minWidth: 168 }}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(voiceVolume * 100)}
                  disabled={!voiceAlerts || voice === 'UNAVAILABLE'}
                  onChange={(e) => setSetting('voiceVolume', Number(e.target.value) / 100)}
                  aria-label="Voice alert volume"
                />
                <span className="field__v" style={{ minWidth: '4ch', textAlign: 'right' }}>
                  {Math.round(voiceVolume * 100)}
                </span>
              </div>
            </Row>

            <div className="divider" />

            <Row
              icon={<Repeat size={16} />}
              title="Repeat critical alerts"
              detail="Say a critical finding once more after 45 seconds if nobody has acknowledged it."
            >
              <Toggle
                on={voiceRepeat}
                disabled={!voiceAlerts || voice === 'UNAVAILABLE'}
                onChange={(v) => setSetting('voiceRepeat', v)}
                onLabel="On"
                offLabel="Off"
              />
            </Row>

            <div className="divider" />

            <Row
              icon={<PlayCircle size={16} />}
              title="Test announcement"
              detail={
                voice === 'UNAVAILABLE'
                  ? 'This browser has no speech synthesis. Visual alerts are unaffected.'
                  : 'Play a sample so the voice and volume can be checked before a sortie.'
              }
            >
              <button
                className="btn"
                disabled={voice === 'UNAVAILABLE' || !voiceAlerts}
                onClick={() => { unlockVoice(); setTested(speakTest(voiceVolume)) }}
              >
                <Volume2 size={13} /> Test
              </button>
            </Row>

            {tested === false && (
              <Note tone="warn">
                Nothing was spoken. The browser blocks audio until the page has been clicked -
                click anywhere and try again.
              </Note>
            )}

            <Note>
              An engineering decision-support announcement, generated from the detected
              condition. It is not a certified aircraft warning system and issues no flight
              instruction. Works the same offline - the voice is the browser's own.
            </Note>
          </div>
        </Panel>

        <Panel title="Operating mode" sub="DATA SOURCE">
          <div className="stack">
            <Row
              icon={live ? <Wifi size={16} /> : <WifiOff size={16} />}
              title={live ? 'Online' : 'Offline'}
              detail={
                live
                  ? 'Connected to the ground station. Telemetry, residuals and alerts are streaming.'
                  : 'No ground station is answering. The console is running the local model, and every value it shows is labelled DEMO.'
              }
            >
              <Badge tone={live ? 'ok' : 'demo'} dot live>
                {live ? 'DATA LINK' : 'LOCAL MODE'}
              </Badge>
            </Row>

            <p className="setting__detail">
              {voice === 'UNAVAILABLE'
                ? 'Voice alerts unavailable on this browser. Visual alerts are unaffected.'
                : live
                  ? 'Voice alerts available. The voice is local to this browser and needs no connection.'
                  : 'Local voice alerts available. Speech does not depend on the ground station.'}
            </p>

            <div className="divider" />

            <Row
              icon={<Radio size={16} />}
              title="Datalink"
              detail="Drop the link to see how the console behaves when the aircraft stops answering."
            >
              <Toggle
                on={connected}
                disabled={!live || linkBusy}
                onChange={toggleDatalink}
                onLabel="Connected"
                offLabel="Dropped"
              />
            </Row>

            {!live && (
              <Note>
                The datalink control needs a ground station to talk to. Start the backend and
                the console reconnects on its own.
              </Note>
            )}

            <div className="kv">
              <span className="kv__k">System</span>
              <span className="kv__v">{status?.system ?? 'CONNECTING'}</span>
              <span className="kv__k">Twin</span>
              <span className="kv__v">{status?.twin?.state ?? '—'}</span>
              <span className="kv__k">Source</span>
              <span className="kv__v">{live ? 'GROUND STATION' : 'LOCAL MODEL'}</span>
            </div>
          </div>
        </Panel>

        <Panel title="Introduction" sub="ONBOARDING">
          <div className="stack">
            <Row
              icon={<PlayCircle size={16} />}
              title="Replay the introduction"
              detail="The full first-entry sequence: the film, how the twin works, and the aircraft."
            >
              <button
                className="btn btn--primary"
                onClick={() => { replayIntro(); navigate('/intro') }}
              >
                <RotateCcw size={13} />
                Replay
              </button>
            </Row>

            <div className="divider" />

            <Row
              icon={<Monitor size={16} />}
              title="Aircraft overview"
              detail="The interactive 3D airframe, on its own."
            >
              <button className="btn" onClick={() => navigate('/uav')}>
                <Circle size={13} />
                Open
              </button>
            </Row>
          </div>
        </Panel>
      </div>
    </>
  )
}
