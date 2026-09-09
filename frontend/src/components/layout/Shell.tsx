import { NavLink, useLocation } from 'react-router-dom'
import {
  Activity, AlertTriangle, Cpu, Database, FileText, GaugeCircle, History,
  LayoutGrid, FolderSearch, LineChart, Map, Moon, PlayCircle, ShieldCheck,
  SlidersHorizontal, Sun, Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTwin } from '../../store/useTwin'
import { useSettings } from '../../store/useSettings'
import { AlertBell, VoiceToggle } from '../alerts/AlertCenter'
import { Badge } from '../ui/Primitives'
import { Wordmark } from '../brand/Wordmark'

interface NavLinkItem {
  to: string
  label: string
  icon: typeof LayoutGrid
  end?: boolean
  badge?: boolean
}

interface NavGroup {
  group: string
}

interface NavSeparator {
  sep: true
}

type NavEntry = NavLinkItem | NavGroup | NavSeparator

/**
 * The sidebar.
 *
 * The first nine are the operator's working set, in the order an engineer
 * moves through a fault: where am I, what is the engine doing, how well is it,
 * what has deviated, what did the flight look like, what would happen if,
 * what should be done, what do I hand over, how do I want this to behave.
 *
 * The rest are second-tier screens - the twin's own internals, the corpus, the
 * validation harness. They sit below a divider rather than being gone, because
 * demoting a screen and deleting it are not the same thing.
 *
 * System Architecture is deliberately absent. The route still resolves and the
 * page still renders - it is linked from Data & Models - but it documents how
 * the product is built rather than telling an operator anything about this
 * aircraft, so it does not earn a permanent seat in the navigation.
 */
export const NAV: NavEntry[] = [
  { to: '/dashboard', label: 'Home', icon: LayoutGrid, end: true },
  { to: '/telemetry', label: 'Live Monitoring', icon: Activity },
  { to: '/engine', label: 'Engine Health', icon: GaugeCircle },
  { to: '/anomalies', label: 'Diagnostics', icon: AlertTriangle, badge: true },
  { to: '/replay', label: 'Flight Replay', icon: History },
  { to: '/simulation', label: 'Mission Simulation', icon: PlayCircle },
  { to: '/maintenance', label: 'Maintenance Advisor', icon: Wrench },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal },

  /* A rule, not a heading. The screens below it are the twin's own internals,
     the corpus and the validation harness - a second tier, which the divider
     already says. The word "Reference" over them read as a section of a
     research tool rather than part of a ground station. */
  { sep: true },
  { to: '/twin', label: 'Digital Twin', icon: Cpu },
  { to: '/prognostics', label: 'Prognostics · RUL', icon: LineChart },
  { to: '/mission', label: 'Mission Control', icon: Map },
  { to: '/data', label: 'Data & Models', icon: Database },
  { to: '/dataset', label: 'Dataset', icon: FolderSearch },
  { to: '/validation', label: 'Validation', icon: ShieldCheck },
]

export function NavRail() {
  const alerts = useTwin((s) => s.alerts)
  const count = alerts?.anomalies?.filter((a) => !a.abstained && a.score >= 0.3).length ?? 0
  const location = useLocation()

  return (
    <nav className="rail shell__rail" aria-label="Primary">
      {NAV.map((item, i) => {
        if ('sep' in item) return <div key={`sep-${i}`} className="rail__sep" />
        if ('group' in item) {
          return (
            <div key={`group-${i}`} className="rail__group">
              <span className="rail__sep" aria-hidden />
              {item.group}
            </div>
          )
        }
        const Icon = item.icon
        const active = item.end
          ? location.pathname === item.to
          : location.pathname.startsWith(item.to)
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={`rail__item ${active ? 'rail__item--active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={17} strokeWidth={1.7} aria-hidden />
            <span className="rail__label">{item.label}</span>
            {item.badge && count > 0 && (
              <span className="rail__badge" aria-label={`${count} active`}>{count}</span>
            )}
            <span className="rail__tip">{item.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}

/**
 * The top bar.
 *
 * It answers four questions and stops: is the link up, does the twin agree
 * with the engine, is the engine well, and is anything asking for me. The two
 * shortcut buttons that used to sit here - replay the film, open the airframe -
 * moved to Settings, where somebody looking for them will actually think to
 * look, and where they are not competing for width with the status of a
 * running aircraft.
 */
export function TopBar({ actions }: { actions?: ReactNode }) {
  const status = useTwin((s) => s.status)
  const telemetry = useTwin((s) => s.telemetry)
  const alerts = useTwin((s) => s.alerts)
  const mission = useTwin((s) => s.mission)
  const mode = useTwin((s) => s.mode)
  const theme = useSettings((s) => s.theme)
  const toggleTheme = useSettings((s) => s.toggleTheme)

  const datalink = telemetry?.datalink
  const twinState = status?.twin?.state ?? datalink?.twin_state ?? '—'
  const syncPct = telemetry?.engine?.sync_pct ?? status?.twin?.sync_pct
  const engineState = alerts?.engine_state ?? null

  /* CONNECTING is a third state and has to look like one. Calling it OFFLINE
     while the sockets are still opening would put the console into local mode
     in the operator's head a second before it actually gets there. */
  const link =
    mode === 'CONNECTING' ? { tone: 'info' as const, label: 'CONNECTING' }
      : mode === 'LIVE' ? { tone: 'ok' as const, label: 'ONLINE' }
        : { tone: 'demo' as const, label: 'OFFLINE · LOCAL MODE' }

  const engineTone =
    engineState === null ? 'neutral'
      : /CRIT|FAULT/i.test(engineState) ? 'crit'
        : /DEGRAD|WARN/i.test(engineState) ? 'warn'
          : /CAUTION|WATCH/i.test(engineState) ? 'caution' : 'ok'

  return (
    <header className="topbar shell__topbar">
      <div className="brand">
        <Wordmark size={14} />
      </div>

      <div className="topbar__ident">
        <div className="ident">
          <span className="ident__k">UAV</span>
          <span className="ident__v">{mission?.mission?.uav_id ?? 'UAV-01'}</span>
        </div>
        <div className="ident">
          <span className="ident__k">Mission</span>
          <span className="ident__v">{mission?.mission?.id ?? 'ISR-047'}</span>
        </div>
        <div className="ident">
          <span className="ident__k">Engine</span>
          <span className="ident__v">{telemetry?.engine?.engine_id ?? 'AERO-01'}</span>
        </div>
        <div className="ident">
          <span className="ident__k">Phase</span>
          <span className="ident__v">{telemetry?.tick?.phase ?? '—'}</span>
        </div>
      </div>

      <span className="topbar__spacer" />

      <div className="topbar__status">
        <Badge tone={link.tone} dot live={mode !== 'DEMO'}>
          {link.label}
        </Badge>

        <Badge tone={datalink?.connected === false ? 'crit' : 'ok'} dot live={datalink?.connected !== false}>
          {datalink?.connected === false ? 'DATA LINK LOST' : 'DATA LINK'}
        </Badge>

        <Badge tone={twinState.startsWith('SYNCHRON') ? 'info' : 'caution'} dot>
          TWIN {twinState}
          {syncPct !== undefined && syncPct !== null ? ` · ${syncPct.toFixed(1)}%` : ''}
        </Badge>

        {engineState && (
          <Badge tone={engineTone as never} dot>
            ENGINE {engineState}
          </Badge>
        )}

        <AlertBell />
        <VoiceToggle />

        <button
          className="btn btn--icon"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      {actions && <div className="topbar__actions">{actions}</div>}
    </header>
  )
}
