import { useEffect, useMemo, useState } from 'react'
import { api, type DataSource, type FieldStats } from './api'
import { useViz, type FilterSpec } from './store'

/** Short human summary of what a filter currently restricts, shown on the pill. */
export function filterSummary(f: FilterSpec): string {
  if (f.values) return `${f.values.length} dipilih`
  if (f.min != null || f.max != null) return `${f.min ?? '−∞'} … ${f.max ?? '∞'}`
  if (f.from || f.to) return `${f.from ?? '…'} → ${f.to ?? '…'}`
  return 'semua'
}

export default function FilterEditor({
  ds,
  index,
  filter,
  onClose,
}: {
  ds: DataSource
  index: number
  filter: FilterSpec
  onClose: () => void
}) {
  const setFilter = useViz((s) => s.setFilter)
  const [stats, setStats] = useState<FieldStats | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    api.fieldStats(ds.id, filter.field).then(setStats).catch((e: Error) => setError(e.message))
  }, [ds.id, filter.field])

  const all = stats?.kind === 'values' ? stats.values : []
  const selected = useMemo(() => new Set(filter.values ?? all), [filter.values, all])
  const shown = all.filter((v) => v.toLowerCase().includes(search.toLowerCase()))

  const setValues = (next: Set<string>) =>
    // Selecting everything is the same as "no restriction", which keeps the query free of a needless IN list.
    setFilter(index, { field: filter.field, values: next.size === all.length ? undefined : [...next] })

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="popover" id={`filter-editor-${filter.field}`}>
        <div className="popover-head">
          <strong>{filter.field}</strong>
          <button className="pill-x light" onClick={onClose} title="Tutup">
            ×
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {!stats && !error && <p className="sub">Memuat…</p>}

        {stats?.kind === 'values' && (
          <>
            <input
              className="popover-input"
              placeholder="Cari nilai…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="popover-actions">
              <button className="link" onClick={() => setValues(new Set(all))}>
                Semua
              </button>
              <button className="link" onClick={() => setFilter(index, { field: filter.field, values: [] })}>
                Tidak ada
              </button>
              <span className="sub">
                {selected.size}/{all.length}
              </span>
            </div>
            <div className="checklist">
              {shown.map((v) => (
                <label key={v} className="check">
                  <input
                    type="checkbox"
                    checked={selected.has(v)}
                    onChange={() => {
                      const next = new Set(selected)
                      if (next.has(v)) next.delete(v)
                      else next.add(v)
                      setValues(next)
                    }}
                  />
                  <span>{v}</span>
                </label>
              ))}
              {shown.length === 0 && <span className="sub">Tidak ada hasil</span>}
            </div>
            {stats.truncated && <p className="sub">Hanya 500 nilai pertama yang ditampilkan.</p>}
          </>
        )}

        {stats?.kind === 'number' && (
          <div className="range">
            <label>
              Min
              <input
                type="number"
                className="popover-input"
                placeholder={String(stats.min)}
                value={filter.min ?? ''}
                onChange={(e) => setFilter(index, { ...filter, min: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </label>
            <label>
              Max
              <input
                type="number"
                className="popover-input"
                placeholder={String(stats.max)}
                value={filter.max ?? ''}
                onChange={(e) => setFilter(index, { ...filter, max: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </label>
            <p className="sub">Filter berlaku pada nilai tiap baris sebelum diagregasi.</p>
          </div>
        )}

        {stats?.kind === 'date' && (
          <div className="range">
            <label>
              Dari
              <input
                type="date"
                className="popover-input"
                min={stats.min ?? undefined}
                max={stats.max ?? undefined}
                value={filter.from ?? ''}
                onChange={(e) => setFilter(index, { ...filter, from: e.target.value || null })}
              />
            </label>
            <label>
              Sampai
              <input
                type="date"
                className="popover-input"
                min={stats.min ?? undefined}
                max={stats.max ?? undefined}
                value={filter.to ?? ''}
                onChange={(e) => setFilter(index, { ...filter, to: e.target.value || null })}
              />
            </label>
          </div>
        )}
      </div>
    </>
  )
}
