/**
 * The stage without a renderer.
 *
 * A 2D horizon with the aircraft on it, drawn from the same flight model that
 * drives the 3D scene, so the attitude, altitude and speed shown here are the
 * same numbers - just rendered with a context every machine has.
 */

import { useEffect, useRef } from 'react'
import { flightDynamics } from './flight'

export function StageFallback({ fullscreen }: { fullscreen: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const draw = () => {
      const parent = canvas.parentElement
      const w = parent?.clientWidth ?? 340
      const h = parent?.clientHeight ?? 224
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const s = flightDynamics.state
      ctx.clearRect(0, 0, w, h)

      // Sky and ground, rolled with the aircraft: an attitude indicator, not
      // a decoration.
      const horizon = h * 0.56 + s.pitch * h * 0.9
      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.rotate(-s.bank * 0.6)
      ctx.translate(-w / 2, -h / 2)

      const sky = ctx.createLinearGradient(0, 0, 0, horizon)
      sky.addColorStop(0, '#071019')
      sky.addColorStop(1, '#16293b')
      ctx.fillStyle = sky
      ctx.fillRect(-w, -h, w * 3, horizon + h)

      const ground = ctx.createLinearGradient(0, horizon, 0, h * 2)
      ground.addColorStop(0, '#1d2a33')
      ground.addColorStop(1, '#0a1016')
      ctx.fillStyle = ground
      ctx.fillRect(-w, horizon, w * 3, h * 2)

      ctx.strokeStyle = 'rgba(160,180,200,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(-w, horizon)
      ctx.lineTo(w * 2, horizon)
      ctx.stroke()
      ctx.restore()

      // Aircraft silhouette, centred.
      const scale = fullscreen ? 2.1 : 1
      ctx.save()
      ctx.translate(w / 2, h * 0.5)
      ctx.scale(scale, scale)
      ctx.rotate(-s.bank * 0.35)
      ctx.fillStyle = '#c3ccd8'
      ctx.fillRect(-34, -1.2, 68, 2.4)
      ctx.beginPath()
      ctx.ellipse(0, 0, 4.5, 13, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillRect(-8, 9, 16, 1.8)
      ctx.restore()

      ctx.fillStyle = 'rgba(139,152,168,0.6)'
      ctx.font = '9px ui-monospace, monospace'
      ctx.fillText('2D ATTITUDE VIEW - WEBGL UNAVAILABLE', 10, h - 10)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [fullscreen])

  return <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
}
