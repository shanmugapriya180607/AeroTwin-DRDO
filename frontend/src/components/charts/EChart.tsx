/**
 * Thin ECharts wrapper.
 *
 * Only the modules the ground station actually draws are registered, which
 * keeps the chart bundle to a fraction of the full library - this has to run
 * alongside a live WebGL scene on a normal laptop.
 */

import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts/core'
import { LineChart, BarChart, GaugeChart, ScatterChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, MarkLineComponent,
  MarkAreaComponent, DataZoomComponent, TitleComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart, BarChart, GaugeChart, ScatterChart,
  GridComponent, TooltipComponent, LegendComponent, MarkLineComponent,
  MarkAreaComponent, DataZoomComponent, TitleComponent,
  CanvasRenderer,
])

/* --------------------------------------------------------------- theme --- */

/**
 * Chart colour, resolved from the stylesheet rather than written twice.
 *
 * A canvas cannot inherit a CSS custom property, so every colour ECharts draws
 * has to be handed to it as a literal. Reading the token off the document at
 * option-build time is what keeps the charts and the surfaces around them the
 * same two palettes - and it means the dark theme needs no second chart
 * config, only the tokens it already defines.
 *
 * Cached per theme: this runs for every axis of every chart on every rebuild,
 * and getComputedStyle is a layout read.
 */
const tokenCache = new Map<string, string>()

export function chartToken(name: string, fallback = '#0b1a2e'): string {
  const theme = document.documentElement.dataset.theme ?? 'light'
  const key = `${theme}:${name}`
  const hit = tokenCache.get(key)
  if (hit !== undefined) return hit
  let value = fallback
  try {
    const read = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (read) value = read
  } catch {
    /* no document styles yet - the fallback is the light-theme value */
  }
  tokenCache.set(key, value)
  return value
}

/**
 * The current theme, as a value a `useMemo` can depend on.
 *
 * Chart options are memoised against their data. Without this in the
 * dependency list a theme change would repaint every surface on the page and
 * leave the plots drawn in the palette of the theme that just left.
 */
export function useChartTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light')
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      setTheme(root.dataset.theme ?? 'light')
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/*
 * Both of these are spread into option objects (`...CHART_BASE`), and a spread
 * invokes getters. That is the whole trick: the values are read at the moment
 * an option is built, so they are always the live theme's.
 */
export const CHART_BASE = {
  backgroundColor: 'transparent',
  animationDuration: 260,
  animationEasing: 'cubicOut' as const,
  textStyle: { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11.5 },
  /* The gutters grow with the labels - the axis text got a tier larger, and
     containLabel is off, so the room for it has to be made explicitly. */
  grid: { left: 58, right: 16, top: 20, bottom: 28, containLabel: false },
  get tooltip() {
    return {
      trigger: 'axis' as const,
      backgroundColor: chartToken('--panel', '#ffffff'),
      borderColor: chartToken('--hairline-strong', '#cddaea'),
      borderWidth: 1,
      padding: [7, 10],
      textStyle: {
        color: chartToken('--ink', '#0b1a2e'),
        fontSize: 12.5,
        fontFamily: 'JetBrains Mono, monospace',
      },
      axisPointer: {
        type: 'line' as const,
        lineStyle: { color: chartToken('--hairline-strong', '#cddaea'), width: 1 },
      },
    }
  },
}

export const AXIS = {
  get axisLine() {
    return { lineStyle: { color: chartToken('--hairline', '#e3eaf4') } }
  },
  axisTick: { show: false },
  /* Axis labels are read, not glanced at: --ink-3 rather than the old
     #8496ac, which sat at 3.0:1 against the panel behind the plot. */
  get axisLabel() {
    return { color: chartToken('--ink-3', '#3d5471'), fontSize: 11, fontWeight: 500 }
  },
  get splitLine() {
    return { lineStyle: { color: chartToken('--hairline', '#e3eaf4'), type: 'dashed' as const } }
  },
}

/*
 * Gutter for a category axis of monospace labels.
 *
 * ECharts' `containLabel` measures the label text to reserve its gutter, but
 * that measurement runs before the web font has swapped in, so it sizes
 * against a fallback and comes up short - visibly so now that these labels are
 * set a tier larger, which was clipping the leading character off the longest
 * channel names. JetBrains Mono advances at 0.6em and the labels are known, so
 * the room can simply be worked out rather than measured.
 */
export function monoGutter(labels: Array<string | number>, size: number, max = 168) {
  const longest = labels.reduce<number>((m, l) => Math.max(m, String(l).length), 0)
  return Math.min(max, Math.ceil(longest * size * 0.6) + 14)
}

export function EChart({
  option,
  height = 180,
  className = '',
  onClick,
}: {
  option: Record<string, any>
  height?: number | string
  className?: string
  onClick?: (params: any) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    chart.current = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    const observer = new ResizeObserver(() => chart.current?.resize())
    observer.observe(ref.current)
    return () => {
      observer.disconnect()
      chart.current?.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    if (!chart.current) return
    chart.current.setOption(option, { notMerge: true, lazyUpdate: true })
  }, [option])

  useEffect(() => {
    if (!chart.current || !onClick) return
    chart.current.on('click', onClick)
    return () => {
      chart.current?.off('click', onClick)
    }
  }, [onClick])

  return <div ref={ref} className={className} style={{ width: '100%', height }} />
}
