/**
 * Error boundary for the rendered layers.
 *
 * Everything 3D in this product is an enhancement over a console that has to
 * keep working. Without a boundary a WebGL context that cannot be created - a
 * locked-down presentation machine, a remote desktop session, a driver that
 * dropped the context mid-flight - throws during render and React unmounts the
 * entire application, which is how a telemetry screen becomes a blank page.
 *
 * The fallback is rendered instead, the failure is logged once, and every
 * number on the page keeps updating.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  /** Named in the console so a real failure is still diagnosable. */
  label?: string
}

interface State {
  failed: boolean
}

export class RenderBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Once, not per frame.
    console.warn(
      `[aerotwin] ${this.props.label ?? 'render layer'} unavailable, falling back:`,
      error.message,
      info.componentStack?.split('\n')[1]?.trim(),
    )
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null
    return this.props.children
  }
}
