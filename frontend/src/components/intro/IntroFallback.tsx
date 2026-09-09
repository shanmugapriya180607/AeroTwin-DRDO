/**
 * The intro without a GPU.
 *
 * Same story, told on a 2D canvas: horizon, airframe, engine, the two halves
 * of the twin with data moving between them, then the pipeline. It exists so
 * that a machine with no WebGL - an older laptop, a locked-down presentation
 * PC, a remote session - still gets the explanation rather than a black box.
 */

import { useEffect, useRef } from 'react'
import type { IntroClock } from './IntroScene'
import { ACT } from './introTimeline'

const CYAN = '#0aa7c2'
const INK = '#5a7089'
const RESIDUAL = '#7739e0'

export function IntroFallback({ clock }: { clock: React.MutableRefObject<IntroClock> }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    /* -- pieces ------------------------------------------------------- */

    const sky = (w: number, h: number) => {
      const g = ctx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, '#3f83d6')
      g.addColorStop(0.42, '#8fbdec')
      g.addColorStop(0.68, '#dbe9f7')
      g.addColorStop(1, '#eef4fb')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)

      // Sun and its haze, low and to the right.
      const sun = ctx.createRadialGradient(w * 0.76, h * 0.6, 4, w * 0.76, h * 0.6, w * 0.34)
      sun.addColorStop(0, 'rgba(255,250,236,0.85)')
      sun.addColorStop(0.25, 'rgba(255,244,220,0.2)')
      sun.addColorStop(1, 'rgba(255,240,214,0)')
      ctx.fillStyle = sun
      ctx.fillRect(0, 0, w, h)
    }

    const ridges = (w: number, h: number, t: number) => {
      const layers = [
        { y: 0.66, amp: 26, colour: 'rgba(168,192,216,0.72)', speed: 2 },
        { y: 0.73, amp: 34, colour: 'rgba(150,166,150,0.82)', speed: 5 },
        { y: 0.83, amp: 44, colour: 'rgba(139,155,124,0.94)', speed: 9 },
      ]
      layers.forEach((layer, li) => {
        ctx.beginPath()
        ctx.moveTo(0, h)
        for (let x = 0; x <= w; x += 12) {
          const drift = t * layer.speed
          const y =
            h * layer.y -
            Math.sin((x + drift) * 0.004 + li) * layer.amp -
            Math.sin((x + drift) * 0.011 + li * 2) * layer.amp * 0.4
          ctx.lineTo(x, y)
        }
        ctx.lineTo(w, h)
        ctx.closePath()
        ctx.fillStyle = layer.colour
        ctx.fill()
      })
    }

    const aircraft = (x: number, y: number, scale: number, alpha: number) => {
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(scale, scale)
      ctx.globalAlpha = alpha
      ctx.fillStyle = '#aeb9c6'
      ctx.fillRect(-58, -1.6, 116, 3.2)              // wing
      ctx.beginPath()
      ctx.ellipse(0, 0, 8, 22, 0, 0, Math.PI * 2)     // fuselage
      ctx.fill()
      ctx.fillRect(-14, 15, 28, 2.4)                  // v-tail
      ctx.fillStyle = CYAN
      ctx.fillRect(-1.2, -26, 2.4, 8)                 // nose marker
      ctx.restore()
      ctx.globalAlpha = 1
    }

    const engine = (cx: number, cy: number, scale: number, t: number, opts: {
      wire?: boolean
      alpha?: number
      flag?: number
    } = {}) => {
      const { wire = false, alpha = 1, flag = 0 } = opts
      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(scale, scale)
      ctx.globalAlpha = alpha
      ctx.lineWidth = 1.4
      const stroke = wire ? CYAN : '#7b8794'
      const fill = wire ? 'rgba(10,110,214,0.07)' : 'rgba(126,138,152,0.20)'

      // crankcase
      ctx.beginPath()
      ctx.roundRect(-26, -34, 52, 68, 5)
      ctx.strokeStyle = stroke
      ctx.fillStyle = fill
      ctx.fill()
      ctx.stroke()

      // four cylinders, two a side, pistons on the crank
      const slots = [
        { i: 1, side: -1, y: -19 }, { i: 2, side: 1, y: -19 },
        { i: 3, side: -1, y: 19 }, { i: 4, side: 1, y: 19 },
      ]
      for (const slot of slots) {
        const phase = slot.i % 2 === 0 ? Math.PI : 0
        const travel = (Math.cos(t * 3.2 + phase) * 0.5 + 0.5) * 12
        const x0 = slot.side * 26
        const x1 = slot.side * 66
        ctx.beginPath()
        ctx.roundRect(Math.min(x0, x1), slot.y - 15, 40, 30, 3)
        ctx.strokeStyle = slot.i === flag ? '#e13232' : stroke
        ctx.fillStyle = slot.i === flag ? 'rgba(225,50,50,0.16)' : fill
        ctx.fill()
        ctx.stroke()

        // fins
        for (let f = 0; f < 4; f += 1) {
          const fx = x0 + slot.side * (9 + f * 8)
          ctx.beginPath()
          ctx.moveTo(fx, slot.y - 17)
          ctx.lineTo(fx, slot.y + 17)
          ctx.strokeStyle = slot.i === flag ? 'rgba(225,50,50,0.5)' : 'rgba(140,152,166,0.42)'
          ctx.stroke()
        }

        // piston
        ctx.beginPath()
        const px = x0 + slot.side * (10 + travel)
        ctx.roundRect(px - 4, slot.y - 11, 8, 22, 2)
        ctx.fillStyle = wire ? 'rgba(10,110,214,0.3)' : 'rgba(206,216,226,0.85)'
        ctx.fill()

        // combustion flash near the top of the stroke
        const burn = Math.pow(Math.max(0, Math.cos(t * 3.2 + phase)), 8)
        if (burn > 0.02 && !wire) {
          ctx.beginPath()
          ctx.arc(x1 - slot.side * 8, slot.y, 7 * burn + 2, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(255,176,87,${burn * 0.7})`
          ctx.fill()
        }
      }

      // crank
      ctx.beginPath()
      ctx.arc(0, 0, 9, 0, Math.PI * 2)
      ctx.strokeStyle = stroke
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(t * 3.2) * 9, Math.sin(t * 3.2) * 9)
      ctx.stroke()

      ctx.restore()
      ctx.globalAlpha = 1
    }

    const stream = (x0: number, y0: number, x1: number, y1: number, t: number, colour: string, back = false) => {
      for (let i = 0; i < 18; i += 1) {
        let p = ((t * 0.32 + i / 18) % 1)
        if (back) p = 1 - p
        const x = x0 + (x1 - x0) * p
        const y = y0 + (y1 - y0) * p - Math.sin(p * Math.PI) * (back ? -26 : 34)
        ctx.beginPath()
        ctx.arc(x, y, back ? 1.6 : 2.1, 0, Math.PI * 2)
        ctx.fillStyle = colour
        ctx.globalAlpha = 0.35 + 0.55 * Math.sin(p * Math.PI)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    /* -- frame -------------------------------------------------------- */

    const draw = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      const c = clock.current
      const t = c.t

      sky(w, h)
      ridges(w, h, t)

      const cx = w * 0.5
      const cy = h * 0.46

      if (c.act <= ACT.CONTACT) {
        // The range, then contact: the aircraft grows out of the distance.
        const u = c.act === ACT.HORIZON ? c.progress * 0.25 : 0.25 + c.progress * 0.75
        aircraft(w * (0.18 + u * 0.32), h * (0.34 + u * 0.1), 0.22 + u * 0.7, 0.3 + u * 0.6)
      } else if (c.act <= ACT.SYNC) {
        // Airframe, acquisition, then the two halves side by side.
        const split = c.act === ACT.SYNC ? Math.min(1, c.progress / 0.4) : 0
        aircraft(cx - 190 * split, cy, 1.5, 1)
        if (split > 0) {
          aircraft(cx + 190 * split, cy, 1.5, 0.42 * split)
          stream(cx - 120 * split, cy, cx + 120 * split, cy, t, CYAN)
        }
      } else if (c.act === ACT.ENGINE) {
        const reveal = Math.min(1, Math.max(0, (c.progress - 0.26) / 0.4))
        aircraft(cx, cy, 1.5 * (1 - reveal) + 0.2, 1 - reveal)
        if (reveal > 0) engine(cx, cy, 0.3 + reveal * 1.2, t)
      } else if (c.act <= ACT.SENSE) {
        engine(cx, cy, 1.5, t)
      } else if (c.act < ACT.BRAND) {
        const split = 1
        const drift = c.act === ACT.RESIDUAL
          ? c.progress * 0.25
          : c.act === ACT.ANOMALY ? 0.25 + c.progress * 0.75 : 1
        engine(cx - 200 * split, cy, 1.2, t, { flag: drift > 0.5 ? 3 : 0 })
        engine(cx + 200 * split, cy, 1.2, t, { wire: true, alpha: split })
        stream(cx - 130 * split, cy, cx + 130 * split, cy, t, CYAN)
        stream(cx - 130 * split, cy, cx + 130 * split, cy, t, RESIDUAL, true)
        if (drift > 0) {
          ctx.fillStyle = RESIDUAL
          ctx.globalAlpha = drift
          ctx.fillRect(cx - 200 * split - 66, cy + 40 - drift * 54, 4, drift * 54)
          ctx.globalAlpha = 1
        }
      } else {
        aircraft(cx + w * 0.12, cy - h * 0.06, 0.9, 0.9)
      }

      // A slow instrument sweep across the frame, the only decoration.
      const sweep = ((t * 0.14) % 1) * w
      const g = ctx.createLinearGradient(sweep - 120, 0, sweep + 120, 0)
      g.addColorStop(0, 'rgba(10,167,194,0)')
      g.addColorStop(0.5, 'rgba(10,167,194,0.05)')
      g.addColorStop(1, 'rgba(10,167,194,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)

      ctx.fillStyle = 'rgba(44,64,86,0.55)'
      ctx.font = '10px ui-monospace, monospace'
      ctx.fillText('2D PRESENTATION MODE · WEBGL UNAVAILABLE', 26, h - 26)
      void INK

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [clock])

  return <canvas ref={ref} className="intro__fallback-canvas" />
}
