/**
 * The decision panel.
 *
 * The console's whole argument, in one place and in order: what the engine is
 * doing, what that means for the sortie, what AeroTwin would do about it, and
 * then three buttons that hand the decision to a person.
 *
 * The recommendation is a recommendation. It is weighted in the layout because
 * an operator scanning under pressure should be able to see what the system
 * thinks without reading - but every command the situation allows stays
 * available, including the one the console is arguing against. A panel that
 * only offers the answer it wants is not decision support.
 *
 * Each button commands the simulation. None of them only changes a label:
 * continue releases the aircraft back onto the plan, return builds a diversion
 * from wherever it actually is, and abort stops the integrator where it stands.
 */

import { useState } from 'react'
import { AlertTriangle, Ban, CornerUpLeft, Plane, ShieldCheck } from 'lucide-react'
import { useTwin } from '../../store/useTwin'
import { assess, COMMAND_LABEL, RISK_TONE } from '../../mission/decision'
import { Badge, StatusBadge, fmt, pct } from '../ui/Primitives'

const PHASE_LABEL: Record<string, string> = {
  READY: 'MISSION READY',
  ACTIVE: 'MISSION ACTIVE',
  RETURNING_TO_BASE: 'RETURNING TO BASE',
  ABORTED: 'MISSION ABORTED',
  COMPLETED: 'MISSION COMPLETED',
}

const PHASE_TONE: Record<string, 'neutral' | 'ok' | 'caution' | 'crit' | 'info'> = {
  READY: 'neutral',
  ACTIVE: 'ok',
  RETURNING_TO_BASE: 'caution',
  ABORTED: 'crit',
  COMPLETED: 'info',
}

const ICON = {
  CONTINUE: Plane,
  RETURN_TO_BASE: CornerUpLeft,
  ABORT: Ban,
}

function Row({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <div className="rows__row">
      <span className="rows__k">{k}</span>
      <span className="rows__dots" />
      <span className={`rows__v ${tone ? `rows__v--${tone}` : ''}`}>{v}</span>
    </div>
  )
}

export function OperatorCommand() {
  const telemetry = useTwin((s) => s.telemetry)
  const alerts = useTwin((s) => s.alerts)
  const phase = useTwin((s) => s.missionPhase)
  const issued = useTwin((s) => s.operatorCommand)
  const operatorLog = useTwin((s) => s.operatorLog)

  const commandContinue = useTwin((s) => s.commandContinue)
  const commandReturnToBase = useTwin((s) => s.commandReturnToBase)
  const commandAbort = useTwin((s) => s.commandAbort)

  const engine = telemetry?.engine
  const view = assess(engine, alerts)

  const worst = (alerts?.anomalies ?? []).find((a) => !a.abstained) ?? null
  const prognosis = engine?.prognosis as { p_serviceable_2d?: number | null } | undefined

  /* Once the sortie is over there is nothing left to decide. The assessment
     stays on screen - it is the record of why it ended - but the commands go. */
  const settled = phase === 'ABORTED' || phase === 'COMPLETED'

  /* Abort is the one command that cannot be taken back: it ends the sortie
     where it stands. Continue and return are both recoverable - either can be
     followed by the other - so only this one asks. */
  const [confirming, setConfirming] = useState(false)

  const run = (cmd: 'CONTINUE' | 'RETURN_TO_BASE' | 'ABORT') => {
    if (cmd === 'CONTINUE') commandContinue()
    else if (cmd === 'RETURN_TO_BASE') commandReturnToBase()
    else setConfirming(true)
  }

  return (
    <section className="panel">
      <header className="panel__head">
        <ShieldCheck size={13} color="var(--accent-ink)" />
        <h2 className="panel__title">Operator command</h2>
        <span className="panel__spacer" />
        <Badge tone={PHASE_TONE[phase]} dot live={phase === 'ACTIVE' || phase === 'RETURNING_TO_BASE'}>
          {PHASE_LABEL[phase]}
        </Badge>
      </header>

      <div className="panel__body">
        <div className="rows">
          <Row
            k="ENGINE STATUS"
            v={<StatusBadge status={alerts?.engine_state ?? engine?.status ?? 'UNKNOWN'} dot={false} />}
          />
          <Row k="MISSION RISK" v={view.risk} tone={RISK_TONE[view.risk]} />
          <Row
            k="FAULT DETECTED"
            v={worst
              ? `${worst.cylinder ? `CYL ${worst.cylinder}` : 'ENGINE'} · ${worst.severity}`
              : 'NONE'}
            tone={worst ? (worst.severity === 'HIGH' ? 'crit' : 'warn') : 'ok'}
          />
          <Row
            k="HEALTH INDEX"
            v={engine?.health_index !== null && engine?.health_index !== undefined
              ? fmt(engine.health_index, 1) : 'NOT PUBLISHED'}
            tone={engine?.health_index === null || engine?.health_index === undefined ? 'dim' : undefined}
          />
          <Row
            k="RUL · P(>2 DAYS)"
            v={prognosis?.p_serviceable_2d !== undefined && prognosis?.p_serviceable_2d !== null
              ? pct(prognosis.p_serviceable_2d, 1) : 'NOT PUBLISHED'}
            tone={prognosis?.p_serviceable_2d === undefined || prognosis?.p_serviceable_2d === null
              ? 'dim' : undefined}
          />
        </div>

        {/* The recommendation, and the reason for it. A recommendation with no
            stated basis is an instruction. */}
        <div className={`opcmd__advice opcmd__advice--${RISK_TONE[view.risk]}`}>
          <span className="opcmd__advice-k">AEROTWIN RECOMMENDATION</span>
          <strong className="opcmd__advice-v">{view.recommendation}</strong>
          <span className="opcmd__advice-why">{view.because}</span>
        </div>

        {settled ? (
          <p className="note note--info" style={{ marginTop: 12 }}>
            {phase === 'ABORTED'
              ? 'Mission aborted by the operator. The aircraft is holding its last position and every reading is preserved as it was.'
              : 'The aircraft is on the ground at base. The sortie is closed.'}
          </p>
        ) : (
          <>
            <span className="micro" style={{ display: 'block', margin: '14px 0 7px' }}>
              OPERATOR COMMAND · HUMAN IN THE LOOP
            </span>
            <div className="opcmd__buttons">
              {view.commands.map((cmd) => {
                const Icon = ICON[cmd]
                const advised = cmd === view.advised
                return (
                  <button
                    key={cmd}
                    className={`opcmd__btn ${advised ? 'opcmd__btn--advised' : ''} ${cmd === 'ABORT' ? 'opcmd__btn--abort' : ''}`}
                    onClick={() => run(cmd)}
                  >
                    <Icon size={14} strokeWidth={2} />
                    <span>{COMMAND_LABEL[cmd]}</span>
                    {advised && <em>ADVISED</em>}
                  </button>
                )
              })}
            </div>

            {confirming && (
              <div className="opcmd__confirm" role="alertdialog" aria-labelledby="opcmd-confirm-title">
                <strong id="opcmd-confirm-title" className="opcmd__confirm-title">
                  <AlertTriangle size={13} strokeWidth={2.4} />
                  Abort mission?
                </strong>
                <p className="opcmd__confirm-body">
                  Are you sure you want to abort the current mission? The aircraft stops where it
                  is and the sortie cannot be resumed. Every reading is preserved for review.
                </p>
                <div className="opcmd__confirm-actions">
                  <button className="btn btn--sm" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn btn--sm btn--danger"
                    autoFocus
                    onClick={() => {
                      setConfirming(false)
                      commandAbort()
                    }}
                  >
                    <Ban size={12} strokeWidth={2.4} /> Confirm abort
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {issued !== 'NONE' && (
          <div className="rows" style={{ marginTop: 12 }}>
            <Row
              k="OPERATOR ACTION"
              v={COMMAND_LABEL[issued as 'CONTINUE' | 'RETURN_TO_BASE' | 'ABORT'].toUpperCase()}
              tone={issued === 'ABORT' ? 'crit' : issued === 'RETURN_TO_BASE' ? 'warn' : 'ok'}
            />
          </div>
        )}

        {operatorLog.length > 0 && (
          <>
            <div className="divider" />
            <span className="micro">MISSION LOG</span>
            <ul className="opcmd__log">
              {operatorLog.slice(0, 7).map((e, i) => (
                <li key={`${e.t}-${i}`} className={`opcmd__log-${e.level.toLowerCase()}`}>
                  {e.level === 'CRIT' && <AlertTriangle size={10} strokeWidth={2.5} />}
                  {e.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
