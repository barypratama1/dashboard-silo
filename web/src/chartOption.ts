import type { EChartsOption } from 'echarts'
import type { Field } from './api'
import { fieldLabel, type Mark, type ShelfField, type VizSpec } from './store'

export interface QueryResult {
  rows: Record<string, unknown>[]
  labels: { columns: string[]; rows: string[]; color: string | null }
}

const PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#e11d48', '#7c3aed', '#0891b2', '#d97706', '#4f46e5']

export type ResolvedMark = Exclude<Mark, 'auto'>

const roleOf = (sf: ShelfField, fields: Field[]) => fields.find((f) => f.name === sf.field)?.role

/** Measure x measure is a scatter plot, a time dimension is a line, anything else is a bar chart. */
export function resolveMark(spec: VizSpec, fields: Field[]): ResolvedMark {
  if (spec.mark !== 'auto') return spec.mark
  const col = spec.columns[0]
  const row = spec.rows[0]
  if (col && row && roleOf(col, fields) === 'measure' && roleOf(row, fields) === 'measure') return 'scatter'
  const dim = [...spec.columns, ...spec.rows].find((f) => roleOf(f, fields) === 'dimension')
  if (dim && fields.find((f) => f.name === dim.field)?.kind === 'date') return 'line'
  return 'bar'
}

/** Scatter plots need raw (disaggregated) points, so measures are sent with agg 'none'. */
export function effectiveSpec(spec: VizSpec, fields: Field[]): VizSpec {
  if (resolveMark(spec, fields) !== 'scatter') return spec
  const raw = (sf: ShelfField): ShelfField => (roleOf(sf, fields) === 'measure' ? { ...sf, agg: 'none' } : sf)
  return { ...spec, columns: spec.columns.map(raw), rows: spec.rows.map(raw) }
}

const fmtCat = (v: unknown, trunc?: string) => {
  const s = String(v ?? '∅')
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s
  if (trunc === 'year') return s.slice(0, 4)
  if (trunc === 'month' || trunc === 'quarter') return s.slice(0, 7)
  return s.slice(0, 10)
}

const base = {
  color: PALETTE,
  backgroundColor: 'transparent',
  textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: '#1e293b' },
  animationDuration: 500,
  legend: { textStyle: { color: '#334155' }, top: 0 },
  tooltip: {
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderWidth: 1,
    textStyle: { color: '#0f172a' },
    extraCssText: 'box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.06); border-radius: 8px;',
  },
  grid: { left: 64, right: 28, top: 48, bottom: 56, containLabel: true },
}
const axisStyle = {
  axisLine: { lineStyle: { color: '#cbd5e1' } },
  axisLabel: { color: '#475569', fontWeight: 500 },
  splitLine: { lineStyle: { color: '#f1f5f9' } },
  nameTextStyle: { color: '#334155', fontWeight: 600 },
}

export function buildOption(
  spec: VizSpec,
  result: QueryResult,
  fields: Field[],
): { option: EChartsOption | null; message?: string } {
  const mark = resolveMark(spec, fields)
  const meta = (sf: ShelfField) => fields.find((f) => f.name === sf.field)
  const label = (sf: ShelfField) => fieldLabel(sf, meta(sf))
  const { rows } = result
  const color = spec.color

  if (mark === 'scatter') {
    const x = spec.columns.find((f) => roleOf(f, fields) === 'measure')
    const y = spec.rows.find((f) => roleOf(f, fields) === 'measure')
    if (!x || !y) return { option: null, message: 'Scatter membutuhkan satu measure di Columns dan satu di Rows' }
    const xl = label(x)
    const yl = label(y)
    const groups = new Map<string, number[][]>()
    for (const r of rows) {
      const g = color ? fmtCat(r[label(color)], color.trunc) : yl
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push([Number(r[xl]), Number(r[yl])])
    }
    return {
      option: {
        ...base,
        legend: { ...base.legend, show: !!color },
        tooltip: { ...base.tooltip, trigger: 'item' },
        xAxis: { type: 'value', name: x.field, nameLocation: 'middle', nameGap: 32, scale: true, ...axisStyle },
        yAxis: { type: 'value', name: y.field, scale: true, ...axisStyle },
        series: [...groups].map(([name, data]) => ({ type: 'scatter' as const, name, data, symbolSize: 10 })),
      } as EChartsOption,
    }
  }

  if (mark === 'pie' || mark === 'treemap' || mark === 'heatmap') {
    const all = [...spec.columns, ...spec.rows]
    const dimsRaw = all.filter((f) => roleOf(f, fields) === 'dimension')
    const dims = dimsRaw.filter((f, i) => dimsRaw.findIndex((g) => label(g) === label(f)) === i)
    const m = all.find((f) => roleOf(f, fields) === 'measure')
    const need = mark === 'heatmap' ? 2 : 1
    if (dims.length < need || !m) {
      return {
        option: null,
        message:
          mark === 'heatmap'
            ? 'Heatmap membutuhkan 2 dimension dan 1 measure'
            : `${mark === 'pie' ? 'Pie' : 'Treemap'} membutuhkan minimal 1 dimension dan 1 measure`,
      }
    }
    const ml = label(m)
    const key = (r: Record<string, unknown>, d: ShelfField) => fmtCat(r[label(d)], d.trunc)

    if (mark === 'pie') {
      const sums = new Map<string, number>()
      for (const r of rows) sums.set(key(r, dims[0]), (sums.get(key(r, dims[0])) ?? 0) + Number(r[ml] ?? 0))
      return {
        option: {
          ...base,
          legend: { ...base.legend, type: 'scroll' },
          tooltip: { ...base.tooltip, trigger: 'item', formatter: '{b}<br/>{c} ({d}%)' },
          series: [
            {
              type: 'pie',
              name: ml,
              radius: ['42%', '70%'],
              center: ['50%', '55%'],
              itemStyle: { borderRadius: 8, borderColor: '#ffffff', borderWidth: 2 },
              label: { color: '#1e293b', fontWeight: 500 },
              data: [...sums].map(([name, value]) => ({ name, value })),
            },
          ],
        } as EChartsOption,
      }
    }

    if (mark === 'treemap') {
      interface Node {
        name: string
        value?: number
        children?: Node[]
      }
      const root: Node[] = []
      for (const r of rows) {
        let level = root
        dims.forEach((d, i) => {
          const name = key(r, d)
          let node = level.find((n) => n.name === name)
          if (!node) level.push((node = { name }))
          if (i === dims.length - 1) node.value = (node.value ?? 0) + Number(r[ml] ?? 0)
          else level = node.children ??= []
        })
      }
      return {
        option: {
          ...base,
          legend: { show: false },
          tooltip: { ...base.tooltip, trigger: 'item', formatter: '{b}: {c}' },
          series: [
            {
              type: 'treemap',
              name: ml,
              roam: false,
              nodeClick: 'zoomToNode',
              breadcrumb: { itemStyle: { color: '#f1f5f9', textStyle: { color: '#1e293b' } } },
              label: { color: '#ffffff', fontWeight: 600 },
              upperLabel: { show: dims.length > 1, color: '#0f172a', height: 24, fontWeight: 600 },
              itemStyle: { borderColor: '#ffffff', borderWidth: 2, gapWidth: 2 },
              data: root,
            },
          ],
        } as EChartsOption,
      }
    }

    // heatmap
    const xd = dims[0]
    const yd = dims[1]
    const xs = [...new Set(rows.map((r) => key(r, xd)))]
    const ys = [...new Set(rows.map((r) => key(r, yd)))]
    const cell = new Map<string, number>()
    for (const r of rows) {
      const k = `${key(r, xd)}\u0000${key(r, yd)}`
      cell.set(k, (cell.get(k) ?? 0) + Number(r[ml] ?? 0))
    }
    const data = [...cell].map(([k, v]) => {
      const [x, y] = k.split('\u0000')
      return [xs.indexOf(x), ys.indexOf(y), v]
    })
    const vals = data.map((d) => d[2])
    return {
      option: {
        ...base,
        legend: { show: false },
        grid: { left: 64, right: 28, top: 24, bottom: 96, containLabel: true },
        tooltip: { ...base.tooltip, trigger: 'item' },
        xAxis: { type: 'category', data: xs, name: xd.field, nameLocation: 'middle', nameGap: 36, splitArea: { show: true }, ...axisStyle },
        yAxis: { type: 'category', data: ys, name: yd.field, splitArea: { show: true }, ...axisStyle },
        visualMap: {
          min: Math.min(...vals),
          max: Math.max(...vals),
          calculable: true,
          orient: 'horizontal',
          left: 'center',
          bottom: 8,
          textStyle: { color: '#475569', fontWeight: 500 },
          inRange: { color: ['#dbeafe', '#60a5fa', '#2563eb', '#1d4ed8'] },
        },
        series: [
          {
            type: 'heatmap',
            name: ml,
            data,
            label: { show: data.length <= 60, color: '#0f172a', fontWeight: 600 },
            emphasis: { itemStyle: { shadowBlur: 10, shadowColor: '#00000020' } },
          },
        ],
      } as EChartsOption,
    }
  }

  // Categorical charts: the first dimension is the category axis, measures on the opposite shelf are the values.
  const colDim = spec.columns.find((f) => roleOf(f, fields) === 'dimension')
  const rowDim = spec.rows.find((f) => roleOf(f, fields) === 'dimension')
  const horizontal = !colDim && !!rowDim && mark === 'bar'
  const dim = colDim ?? rowDim
  const measures = (horizontal ? spec.columns : spec.rows).filter((f) => roleOf(f, fields) === 'measure')
  const candidates = measures.length
    ? measures
    : [...spec.columns, ...spec.rows].filter((f) => roleOf(f, fields) === 'measure')
  // The same measure+aggregation placed twice must not be double counted.
  const valueShelf = candidates.filter((f, i) => candidates.findIndex((g) => label(g) === label(f)) === i)
  if (!valueShelf.length) return { option: null, message: 'Tambahkan minimal satu measure ke Rows atau Columns' }

  const catOf = (r: Record<string, unknown>) => (dim ? fmtCat(r[label(dim)], dim.trunc) : 'Total')
  const categories = [...new Set(rows.map(catOf))]
  const seriesMap = new Map<string, Map<string, number>>()
  for (const r of rows) {
    for (const m of valueShelf) {
      const cname = color ? fmtCat(r[label(color)], color.trunc) : ''
      const name = color ? (valueShelf.length > 1 ? `${cname} · ${label(m)}` : cname) : label(m)
      if (!seriesMap.has(name)) seriesMap.set(name, new Map())
      const bucket = seriesMap.get(name)!
      bucket.set(catOf(r), (bucket.get(catOf(r)) ?? 0) + Number(r[label(m)] ?? 0))
    }
  }
  const series = [...seriesMap].map(([name, m]) => ({
    name,
    type: (mark === 'area' ? 'line' : mark) as 'bar' | 'line',
    data: categories.map((c) => m.get(c) ?? null),
    ...(mark === 'area' ? { areaStyle: { opacity: 0.25 } } : {}),
    ...(mark !== 'bar' ? { smooth: true, symbolSize: 7 } : { barMaxWidth: 48, itemStyle: { borderRadius: horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0] } }),
    ...(mark === 'bar' && !color && valueShelf.length === 1 ? { colorBy: 'series' as const } : {}),
  }))

  const catAxis = {
    type: 'category' as const,
    data: categories,
    name: dim?.field,
    nameLocation: 'middle' as const,
    nameGap: 36,
    ...axisStyle,
  }
  const valAxis = { type: 'value' as const, name: horizontal ? undefined : label(valueShelf[0]), ...axisStyle }
  return {
    option: {
      ...base,
      legend: { ...base.legend, show: series.length > 1 },
      tooltip: { ...base.tooltip, trigger: 'axis' },
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      series,
    } as EChartsOption,
  }
}
