/**
 * The chart vocabulary of the ground station.
 *
 * One rule runs through all of it: expected and actual are drawn in the same
 * frame, and the residual between them is drawn as its own signed series. A
 * chart of the sensor value alone is the reactive display this project exists
 * to replace.
 */

import { useMemo } from 'react'
import { AXIS, CHART_BASE, EChart, chartToken, monoGutter, useChartTheme } from './EChart'
import type { TrendPoint } from '../../store/useTwin'

/*
 * The series palette.
 *
 * Getters, not values. A plain object here would be evaluated once at import
 * and freeze whichever theme happened to be active when the chunk loaded; read
 * on access, each colour is whatever the stylesheet says at the moment an
 * option is built. Same reason CHART_BASE and AXIS are written this way.
 */
const C = {
  get expected() { return chartToken('--expected', '#7691b6') },
  get actual() { return chartToken('--actual', '#0b1a2e') },
  get residual() { return chartToken('--residual', '#7739e0') },
  get ok() { return chartToken('--ok', '#0aa06e') },
  get caution() { return chartToken('--caution', '#d99a00') },
  get warn() { return chartToken('--warn', '#ef7a1a') },
  get crit() { return chartToken('--crit', '#e13232') },
  get accent() { return chartToken('--accent', '#0a6ed6') },
  get grid() { return chartToken('--hairline', '#e3eaf4') },
}

/** One colour per cylinder, in bank order. A function for the same reason. */
export function cylColor(index: number): string {
  const tokens: Array<[string, string]> = [
    ['--accent', '#0a6ed6'],
    ['--info', '#1668e3'],
    ['--warn', '#ef7a1a'],
    ['--residual', '#7739e0'],
  ]
  const [name, fallback] = tokens[index % tokens.length]
  return chartToken(name, fallback)
}

/* --------------------------------------------------- Expected vs actual -- */

export function ExpectedActualChart({
  series,
  unit,
  height = 190,
}: {
  series: TrendPoint[]
  unit: string
  height?: number
}) {
  const theme = useChartTheme()
  const option = useMemo(() => {
    const x = series.map((p) => p.t.toFixed(0))
    /*
     * How many decimals the y-axis has to show to say anything.
     *
     * The axis was fixed at zero. On RPM, where the trace moves over hundreds,
     * that is right; on manifold pressure, which lives between 14 and 15 inHg,
     * every tick rounded to the same integer and the axis read "15 15 15 15".
     * The spread of the data decides instead.
     */
    const values = series.flatMap((p) => [p.expected, p.observed]).filter(Number.isFinite)
    const spread = values.length ? Math.max(...values) - Math.min(...values) : 0
    const decimals = spread >= 5 ? 0 : spread >= 0.5 ? 1 : spread >= 0.05 ? 2 : 3
    return {
      ...CHART_BASE,
      legend: {
        show: true,
        top: 0,
        right: 0,
        itemWidth: 14,
        itemHeight: 2,
        textStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
        data: ['EXPECTED (PHYSICS)', 'ACTUAL (SENSOR)'],
      },
      /* In a narrow card the legend wraps to two lines, and at 26 the plot
         started underneath the second one - the series names were printed
         across the gridlines. The plot clears both lines. */
      grid: { ...CHART_BASE.grid, top: 44 },
      xAxis: { type: 'category', data: x, ...AXIS, boundaryGap: false },
      yAxis: {
        type: 'value',
        scale: true,
        ...AXIS,
        axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => v.toFixed(decimals) },
        name: unit,
        nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11, align: 'right' },
      },
      series: [
        {
          name: 'EXPECTED (PHYSICS)',
          type: 'line',
          data: series.map((p) => p.expected),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: C.expected, width: 1.4, type: 'dashed' },
          z: 2,
        },
        {
          name: 'ACTUAL (SENSOR)',
          type: 'line',
          data: series.map((p) => p.observed),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: C.actual, width: 1.7 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(11,26,46,0.10)' },
                { offset: 1, color: 'rgba(11,26,46,0)' },
              ],
            },
          },
          z: 3,
        },
      ],
    }
  }, [series, unit, theme])

  return <EChart option={option} height={height} />
}

/* ------------------------------------------------------- Residual chart -- */

export function ResidualChart({
  series,
  unit,
  height = 150,
  threshold,
}: {
  series: TrendPoint[]
  unit: string
  height?: number
  threshold?: number
}) {
  const theme = useChartTheme()
  const option = useMemo(() => {
    const values = series.map((p) => p.residual)
    const peak = Math.max(4, ...values.map((v) => Math.abs(v)))
    return {
      ...CHART_BASE,
      grid: { ...CHART_BASE.grid, top: 14, bottom: 20 },
      xAxis: { type: 'category', data: series.map((p) => p.t.toFixed(0)), ...AXIS, boundaryGap: false },
      yAxis: {
        type: 'value',
        min: -peak * 1.15,
        max: peak * 1.15,
        ...AXIS,
        name: unit,
        nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
      },
      series: [
        {
          name: 'RESIDUAL',
          type: 'line',
          data: values,
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { color: C.residual, width: 1.6 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(119,57,224,0.28)' },
                { offset: 1, color: 'rgba(119,57,224,0.01)' },
              ],
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: false },
            data: [
              { yAxis: 0, lineStyle: { color: chartToken('--ink-5', '#b2c1d3'), width: 1 } },
              ...(threshold
                ? [
                  { yAxis: threshold, lineStyle: { color: 'rgba(239,122,26,0.5)', type: 'dashed', width: 1 } },
                  { yAxis: -threshold, lineStyle: { color: 'rgba(239,122,26,0.5)', type: 'dashed', width: 1 } },
                ]
                : []),
            ],
          },
        },
      ],
    }
  }, [series, unit, threshold, theme])

  return <EChart option={option} height={height} />
}

/* ------------------------------------------------- Per-cylinder overlay -- */

export function CylinderChart({
  histories,
  field = 'residual',
  unit,
  height = 200,
  highlight,
}: {
  histories: Record<string, TrendPoint[]>
  field?: 'residual' | 'observed' | 'expected'
  unit: string
  height?: number
  highlight?: number
}) {
  const theme = useChartTheme()
  const option = useMemo(() => {
    const keys = [1, 2, 3, 4]
    const base = histories.cht_1 ?? []
    return {
      ...CHART_BASE,
      legend: {
        show: true, top: 0, right: 0, itemWidth: 12, itemHeight: 2,
        textStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
      },
      grid: { ...CHART_BASE.grid, top: 26 },
      xAxis: { type: 'category', data: base.map((p) => p.t.toFixed(0)), ...AXIS, boundaryGap: false },
      yAxis: { type: 'value', scale: true, ...AXIS, name: unit, nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 } },
      series: keys.map((i) => ({
        name: `CYL ${i}`,
        type: 'line',
        data: (histories[`cht_${i}`] ?? []).map((p) => p[field]),
        showSymbol: false,
        smooth: 0.2,
        lineStyle: {
          color: cylColor(i - 1),
          width: highlight === i ? 2.2 : 1.2,
          opacity: highlight && highlight !== i ? 0.42 : 1,
        },
        z: highlight === i ? 5 : 2,
      })),
    }
  }, [histories, field, unit, highlight, theme])

  return <EChart option={option} height={height} />
}

/* --------------------------------------------------------- Health gauge -- */

/**
 * The engine health index.
 *
 * `value` may be null, and that is not the same as zero. The twin abstains
 * where its physics model does not apply to the connected source, and a gauge
 * reading 0.0 in that state would be a fabricated verdict on an engine nothing
 * has actually been concluded about. Abstention draws an empty arc and a dash.
 */
export function HealthGauge({ value, height = 200 }: { value: number | null; height?: number }) {
  const theme = useChartTheme()
  const option = useMemo(() => {
    const abstained = value === null || value === undefined || !Number.isFinite(value)
    const v = abstained ? 0 : (value as number)
    const color = abstained ? chartToken('--ink-5', '#b2c1d3')
      : v >= 90 ? C.ok : v >= 78 ? C.caution : v >= 62 ? C.warn : C.crit
    return {
      backgroundColor: 'transparent',
      series: [
        {
          type: 'gauge',
          startAngle: 210,
          endAngle: -30,
          min: 0,
          max: 100,
          radius: '96%',
          center: ['50%', '58%'],
          progress: { show: true, width: 9, itemStyle: { color } },
          axisLine: { lineStyle: { width: 9, color: [[1, chartToken('--panel-3', '#eef3fa')]] } },
          pointer: { show: false },
          axisTick: { distance: -16, splitNumber: 5, lineStyle: { color: chartToken('--hairline-strong', '#cddaea'), width: 1 } },
          splitLine: { distance: -19, length: 8, lineStyle: { color: chartToken('--ink-5', '#b2c1d3'), width: 1 } },
          axisLabel: { distance: -6, color: chartToken('--ink-4', '#566d8a'), fontSize: 10.5 },
          anchor: { show: false },
          title: {
            show: true,
            /* The caption sits on a chord of the dial, so it can only grow
               so far before the ring clips it. It gets its legibility from
               weight and ink rather than size, and drops far enough to clear
               the reading, which is now set larger. */
            offsetCenter: [0, '34%'],
            color: chartToken('--ink-3', '#3d5471'),
            fontSize: 11,
            fontWeight: 700,
            fontFamily: 'Inter, sans-serif',
          },
          detail: {
            valueAnimation: true,
            offsetCenter: [0, '2%'],
            fontSize: 36,
            fontWeight: 700,
            fontFamily: 'JetBrains Mono, monospace',
            color: abstained ? chartToken('--ink-4', '#566d8a') : chartToken('--ink', '#0b1a2e'),
            formatter: () => (abstained ? '—' : v.toFixed(1)),
          },
          data: [{
            value: v,
            name: abstained ? 'MODEL ABSTENTION' : 'ENGINE HEALTH INDEX',
          }],
        },
      ],
    }
  }, [value, theme])

  return <EChart option={option} height={height} />
}

/* --------------------------------------------------------- Health trend -- */

export function HealthTrend({
  points,
  height = 130,
}: {
  points: Array<{ label: string; health: number; live?: boolean }>
  height?: number
}) {
  const theme = useChartTheme()
  const option = useMemo(() => ({
    ...CHART_BASE,
    grid: { ...CHART_BASE.grid, left: 42, top: 14, bottom: 30 },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.label),
      ...AXIS,
      axisLabel: { ...AXIS.axisLabel, rotate: 0, interval: 0, fontSize: 10.5 },
    },
    yAxis: { type: 'value', min: 40, max: 100, ...AXIS },
    series: [
      {
        type: 'line',
        data: points.map((p) => ({
          value: p.health,
          itemStyle: { color: p.live ? C.accent : p.health >= 90 ? C.ok : p.health >= 78 ? C.caution : C.warn },
        })),
        smooth: 0.3,
        symbolSize: 6,
        lineStyle: { color: C.accent, width: 1.6 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(10,110,214,0.20)' },
              { offset: 1, color: 'rgba(10,110,214,0)' },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: 'none',
          /* 'insideEndTop' anchors this to the left terminus of the line,
             where it ran off the plot and printed "…UTION" across the axis
             labels. Pinned to the start of the span and nudged clear of the
             y-axis, it reads as the threshold caption it is. */
          label: {
            show: true,
            formatter: 'CAUTION',
            color: chartToken('--caution-ink', '#8a6200'),
            fontSize: 10.5,
            fontWeight: 700,
            position: 'insideStartTop',
            /* Clear of the y-axis numbers, which sit just outside the plot. */
            distance: [12, 2],
          },
          data: [{ yAxis: 78, lineStyle: { color: 'rgba(217,154,0,0.4)', type: 'dashed', width: 1 } }],
        },
      },
    ],
  }), [points, theme])

  return <EChart option={option} height={height} />
}

/* ------------------------------------------------------- Contributions --- */

export function ContributionBars({
  items,
  height = 150,
}: {
  items: Array<{ label: string; value: number }>
  height?: number
}) {
  const theme = useChartTheme()
  const option = useMemo(() => ({
    ...CHART_BASE,
    grid: { left: monoGutter(items.map((i) => i.label), 11), right: 46, top: 6, bottom: 8, containLabel: false },
    tooltip: { ...CHART_BASE.tooltip, trigger: 'item' },
    xAxis: { type: 'value', show: false, max: Math.max(...items.map((i) => i.value), 0.001) * 1.15 },
    yAxis: {
      type: 'category',
      data: items.map((i) => i.label).reverse(),
      ...AXIS,
      splitLine: { show: false },
      axisLabel: { ...AXIS.axisLabel, fontSize: 11, color: chartToken('--ink-3', '#3d5471') },
    },
    series: [
      {
        type: 'bar',
        data: items.map((i) => i.value).reverse(),
        barWidth: 9,
        itemStyle: { color: C.residual, borderRadius: [0, 2, 2, 0] },
        label: {
          show: true,
          position: 'right',
          color: chartToken('--ink-3', '#3d5471'),
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'JetBrains Mono, monospace',
          formatter: (p: any) => p.value.toFixed(3),
        },
      },
    ],
  }), [items, theme])

  return <EChart option={option} height={height} />
}

/* ----------------------------------------------------------- Sparkline --- */

export function Sparkline({
  values,
  color = C.accent,
  height = 34,
}: {
  values: number[]
  color?: string
  height?: number
}) {
  const theme = useChartTheme()
  const option = useMemo(() => ({
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 0, right: 0, top: 3, bottom: 3 },
    xAxis: { type: 'category', show: false, data: values.map((_, i) => i), boundaryGap: false },
    yAxis: { type: 'value', show: false, scale: true },
    series: [
      {
        type: 'line',
        data: values,
        showSymbol: false,
        smooth: 0.3,
        lineStyle: { color, width: 1.3 },
        areaStyle: { color: `${color}1f` },
      },
    ],
  }), [values, color, theme])

  return <EChart option={option} height={height} />
}

/* -------------------------------------------------- Mission plan profile - */

export function ProfileChart({
  points,
  height = 190,
}: {
  points: Array<{ t: number; altitude: number; residual: number; health: number }>
  height?: number
}) {
  const theme = useChartTheme()
  const option = useMemo(() => ({
    ...CHART_BASE,
    legend: {
      show: true, top: 0, right: 0, itemWidth: 13, itemHeight: 2,
      textStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
    },
    grid: { left: 48, right: 46, top: 26, bottom: 24 },
    xAxis: {
      type: 'category',
      data: points.map((p) => (p.t / 60).toFixed(0)),
      ...AXIS,
      name: 'MIN',
      nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 },
    },
    yAxis: [
      { type: 'value', ...AXIS, name: 'FT', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 } },
      { type: 'value', ...AXIS, name: '°C', nameTextStyle: { color: chartToken('--ink-3', '#3d5471'), fontSize: 11 }, splitLine: { show: false } },
    ],
    series: [
      {
        name: 'ALTITUDE',
        type: 'line',
        data: points.map((p) => p.altitude),
        showSymbol: false,
        smooth: 0.3,
        lineStyle: { color: C.expected, width: 1.4 },
        areaStyle: { color: 'rgba(118,145,182,0.10)' },
      },
      {
        name: 'PEAK RESIDUAL',
        type: 'line',
        yAxisIndex: 1,
        data: points.map((p) => p.residual),
        showSymbol: false,
        smooth: 0.3,
        lineStyle: { color: C.residual, width: 1.7 },
      },
    ],
  }), [points, theme])

  return <EChart option={option} height={height} />
}
