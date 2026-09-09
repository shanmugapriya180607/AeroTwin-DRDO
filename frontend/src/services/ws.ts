/**
 * WebSocket transport with reconnect and a demo fallback.
 *
 * Four topics mirror the four things a ground station must keep live:
 * telemetry, residuals, alerts and mission. If the socket cannot be
 * established the caller is told, and the store switches to the local
 * synthetic generator - which tags every frame DEMO.
 */

export type Topic = 'telemetry' | 'residuals' | 'alerts' | 'mission'

type Handler = (message: any) => void
type StateHandler = (state: SocketState) => void

export type SocketState = 'CONNECTING' | 'OPEN' | 'CLOSED' | 'FAILED'

const MAX_BACKOFF = 8000

export class TopicSocket {
  private socket: WebSocket | null = null
  private handlers = new Set<Handler>()
  private stateHandlers = new Set<StateHandler>()
  private attempts = 0
  private timer: number | null = null
  private closedByUser = false
  state: SocketState = 'CLOSED'

  constructor(private topic: Topic) {}

  connect() {
    this.closedByUser = false
    this.open()
  }

  private setState(state: SocketState) {
    this.state = state
    this.stateHandlers.forEach((fn) => fn(state))
  }

  private open() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return
    }
    // Follow the REST base when the backend is deployed apart from the
    // console, so the socket does not try to reach a static host that has no
    // WebSocket endpoint to answer with.
    const configured = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')
    const host = configured
      ? configured.replace(/^https?:/, '')
      : `//${location.host}`
    const secure = configured
      ? configured.startsWith('https:')
      : location.protocol === 'https:'
    const url = `${secure ? 'wss:' : 'ws:'}${host}/ws/${this.topic}`
    this.setState('CONNECTING')

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      this.setState('OPEN')
    }

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message?.type === 'heartbeat') return
        this.handlers.forEach((fn) => fn(message))
      } catch {
        /* a malformed frame is dropped, never allowed to break the stream */
      }
    }

    socket.onerror = () => {
      /* onclose always follows; retry is handled there */
    }

    socket.onclose = () => {
      this.socket = null
      if (this.closedByUser) {
        this.setState('CLOSED')
        return
      }
      this.scheduleRetry()
    }
  }

  private scheduleRetry() {
    this.attempts += 1
    this.setState(this.attempts > 3 ? 'FAILED' : 'CONNECTING')
    const delay = Math.min(MAX_BACKOFF, 500 * 2 ** Math.min(this.attempts, 4))
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.open(), delay)
  }

  subscribe(fn: Handler) {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  onState(fn: StateHandler) {
    this.stateHandlers.add(fn)
    fn(this.state)
    return () => this.stateHandlers.delete(fn)
  }

  close() {
    this.closedByUser = true
    if (this.timer) window.clearTimeout(this.timer)
    this.socket?.close()
    this.socket = null
    this.setState('CLOSED')
  }
}

const sockets: Partial<Record<Topic, TopicSocket>> = {}

export function topicSocket(topic: Topic): TopicSocket {
  if (!sockets[topic]) {
    sockets[topic] = new TopicSocket(topic)
  }
  return sockets[topic]!
}

export function connectAll(topics: Topic[] = ['telemetry', 'residuals', 'alerts', 'mission']) {
  topics.forEach((topic) => topicSocket(topic).connect())
}
