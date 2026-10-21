import { useEffect, useMemo, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { api, type DataSource } from './api'
import FilterEditor, { filterSummary } from './FilterEditor'
import Chart from './Chart'
import { buildOption, effectiveSpec, resolveMark, type QueryResult } from './chartOption'
import { fieldLabel, useViz, type Agg, type Mark, type ShelfId, type Trunc, type VizSpec } from './store'

const AGGS: Agg[] = ['sum', 'avg', 'count', 'min', 'max']
const TRUNCS: Trunc[] = ['year', 'quarter', 'month', 'week', 'day']
const MARKS: { id: Mark; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'bar', label: 'Bar' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'scatter', label: 'Scatter' },
  { id: 'pie', label: 'Pie' },
  { id: 'heatmap', label: 'Heatmap' },
  { id: 'treemap', label: 'Treemap' },
]

function Shelf({ id, title, ds }: { id: Exclude<ShelfId, 'filters'>; title: string; ds: DataSource }) {
  const { isOver, setNodeRef } = useDroppable({ id })
  const spec = useViz((s) => s.spec)
  const remove = useViz((s) => s.remove)
  const patch = useViz((s) => s.patch)
  const items = id === 'color' ? (spec.color ? [spec.color] : []) : spec[id]
  const isScatter = resolveMark(spec, ds.fields) === 'scatter'

  return (
    <div className="shelf-row">
      <div className="shelf-title">{title}</div>
      <div id={`shelf-${id}`} ref={setNodeRef} className={`shelf ${isOver ? 'over' : ''}`}>
        {items.length === 0 && <span className="shelf-hint">Seret field ke sini</span>}
        {items.map((sf, i) => {
          const meta = ds.fields.find((f) => f.name === sf.field)
          const isMeasure = meta?.role === 'measure'
          return (
            <span key={`${sf.field}-${i}`} className={`pill ${isMeasure ? 'measure' : 'dimension'}`}>
              {isMeasure ? (
                isScatter ? (
                  <span>{sf.field}</span>
                ) : (
                  <>
                    <select value={sf.agg ?? 'sum'} onChange={(e) => patch(id, i, { agg: e.target.value as Agg })}>
                      {AGGS.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                    <span>({sf.field})</span>
                  </>
                )
              ) : meta?.kind === 'date' ? (
                <>
                  <select value={sf.trunc ?? 'month'} onChange={(e) => patch(id, i, { trunc: e.target.value as Trunc })}>
                    {TRUNCS.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                  <span>({sf.field})</span>
                </>
              ) : (
                <span>{fieldLabel(sf, meta)}</span>
              )}
              <button className="pill-x" title="Hapus" onClick={() => remove(id, i)}>
                ×
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}

function FilterShelf({ ds }: { ds: DataSource }) {
  const { isOver, setNodeRef } = useDroppable({ id: 'filters' })
  const filters = useViz((s) => s.spec.filters)
  const remove = useViz((s) => s.remove)
  const [editing, setEditing] = useState<number | null>(null)

  return (
    <div className="shelf-row">
      <div className="shelf-title">Filters</div>
      <div id="shelf-filters" ref={setNodeRef} className={`shelf ${isOver ? 'over' : ''}`}>
        {filters.length === 0 && <span className="shelf-hint">Seret field ke sini untuk memfilter</span>}
        {filters.map((f, i) => {
          const isMeasure = ds.fields.find((x) => x.name === f.field)?.role === 'measure'
          const active = filterSummary(f) !== 'semua'
          return (
            <span key={f.field} className="pill-wrap">
              <span className={`pill filter ${isMeasure ? 'measure' : 'dimension'} ${active ? 'active' : ''}`}>
                <button className="pill-btn" id={`filter-pill-${f.field}`} onClick={() => setEditing(editing === i ? null : i)}>
                  {f.field} <em>{filterSummary(f)}</em> ▾
                </button>
                <button className="pill-x" title="Hapus" onClick={() => remove('filters', i)}>
                  ×
                </button>
              </span>
              {editing === i && <FilterEditor ds={ds} index={i} filter={f} onClose={() => setEditing(null)} />}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export default function Worksheet({ ds }: { ds: DataSource }) {
  const spec = useViz((s) => s.spec)
  const setMark = useViz((s) => s.setMark)
  const reset = useViz((s) => s.reset)
  const [result, setResult] = useState<{ spec: VizSpec; data: QueryResult } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const sendSpec = useMemo(() => effectiveSpec(spec, ds.fields), [spec, ds.fields])
  const hasShelf = spec.columns.length + spec.rows.length > 0

  useEffect(() => {
    if (!hasShelf) {
      setResult(null)
      setError('')
      return
    }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      api
        .query(ds.id, sendSpec)
        .then((r) => {
          if (cancelled) return
          setResult({ spec: sendSpec, data: r })
          setError('')
        })
        .catch((e: Error) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setLoading(false))
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [ds.id, sendSpec, hasShelf])

  const built = useMemo(
    () => (result ? buildOption(result.spec, result.data, ds.fields) : null),
    [result, ds.fields],
  )

  return (
    <div className="worksheet">
      <div className="shelves">
        <Shelf id="columns" title="Columns" ds={ds} />
        <Shelf id="rows" title="Rows" ds={ds} />
        <Shelf id="color" title="Color" ds={ds} />
        <FilterShelf ds={ds} />
        <div className="marks">
          {MARKS.map((m) => (
            <button
              key={m.id}
              id={`mark-${m.id}`}
              className={`chip ${spec.mark === m.id ? 'on' : ''}`}
              onClick={() => setMark(m.id)}
            >
              {m.label}
            </button>
          ))}
          <button id="reset-viz" className="chip" onClick={reset}>
            Reset
          </button>
        </div>
      </div>

      <div className="canvas">
        {loading && <div className="canvas-loading" />}
        {error ? (
          <div className="empty error">{error}</div>
        ) : built?.option ? (
          <Chart option={built.option} />
        ) : (
          <div className="empty">
            {built?.message ?? 'Seret dimension dan measure dari panel kiri ke Columns / Rows untuk membuat visualisasi'}
          </div>
        )}
      </div>
    </div>
  )
}
