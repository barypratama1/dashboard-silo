import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { api, setToken, type DataSource, type Field } from './api'
import CalcDialog from './CalcDialog'
import Worksheet from './Worksheet'
import { useViz, type ShelfId } from './store'

function FieldItem({ f, onDelete }: { f: Field; onDelete?: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `field:${f.name}`, data: { field: f } })
  const add = useViz((s) => s.add)
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      id={`field-${f.name}`}
      title={f.calc ? `= ${f.expression}` : 'Seret ke shelf, atau klik dua kali untuk menambahkan'}
      onDoubleClick={() => add(f.role === 'measure' ? 'rows' : 'columns', f)}
      className={`field ${f.role === 'measure' ? 'measure' : ''} ${isDragging ? 'dragging' : ''}`}
    >
      {f.calc && <span className="fx">ƒ</span>}
      {f.name}
      <span className="tag">{f.role === 'measure' ? f.type : f.kind}</span>
      {onDelete && (
        <button
          className="field-x"
          title="Hapus calculated field"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={onDelete}
        >
          ×
        </button>
      )}
    </div>
  )
}

export default function Workspace({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [sources, setSources] = useState<DataSource[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [uploading, setUploading] = useState(false)
  const [over, setOver] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'worksheet' | 'data'>('worksheet')
  const [dragging, setDragging] = useState<Field | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const addToShelf = useViz((s) => s.add)
  const resetViz = useViz((s) => s.reset)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const active = sources.find((s) => s.id === activeId) ?? null

  useEffect(() => {
    api
      .datasources()
      .then((list) => {
        setSources(list)
        if (list[0]) setActiveId(list[0].id)
      })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    if (activeId == null) return
    resetViz() // field names differ between datasources
    api.preview(activeId).then(setRows).catch((e) => setError(e.message))
  }, [activeId, resetViz])

  const upload = useCallback(async (file: File) => {
    setUploading(true)
    setError('')
    try {
      const ds = await api.upload(file)
      setSources((s) => [{ id: ds.id, name: ds.name, fields: ds.fields }, ...s])
      setActiveId(ds.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }, [])

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    const field = e.active.data.current?.field as Field | undefined
    if (field && e.over) addToShelf(e.over.id as ShelfId, field)
  }
  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current?.field as Field) ?? null)

  const patchFields = (id: number, fn: (fields: Field[]) => Field[]) =>
    setSources((list) => list.map((s) => (s.id === id ? { ...s, fields: fn(s.fields) } : s)))

  const onCalcCreated = (field: Field) => {
    if (activeId == null) return
    patchFields(activeId, (fs) => [...fs, field])
    setCalcOpen(false)
    api.preview(activeId).then(setRows).catch((e) => setError(e.message))
  }

  const onCalcDelete = async (name: string) => {
    if (activeId == null) return
    try {
      await api.deleteCalc(activeId, name)
      patchFields(activeId, (fs) => fs.filter((f) => f.name !== name))
      resetViz() // the removed field may be used on a shelf or in a filter
      api.preview(activeId).then(setRows).catch((e) => setError(e.message))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const dims = active?.fields.filter((f) => f.role === 'dimension') ?? []
  const measures = active?.fields.filter((f) => f.role === 'measure') ?? []

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            dashboard-<span>silo</span>
          </div>
          <div className="right">
            {email}
            <button
              id="logout"
              className="btn ghost"
              onClick={() => {
                setToken(null)
                onLogout()
              }}
            >
              Keluar
            </button>
          </div>
        </header>

        <aside className="sidebar">
          <button
            id="upload-btn"
            className="btn"
            style={{ width: '100%' }}
            disabled={uploading}
            onClick={() => input.current?.click()}
          >
            {uploading ? 'Mengunggah…' : '+ Unggah CSV'}
          </button>
          <input
            ref={input}
            id="file-input"
            type="file"
            accept=".csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) upload(f)
              e.target.value = ''
            }}
          />

          <h3>Data Sources</h3>
          {sources.length === 0 && <div className="sub">Belum ada data</div>}
          {sources.map((s) => (
            <div key={s.id} className={`ds-item ${s.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(s.id)}>
              {s.name}
            </div>
          ))}

          {active && (
            <>
              <button id="calc-btn" className="btn ghost" style={{ width: '100%', marginTop: 14 }} onClick={() => setCalcOpen(true)}>
                ƒ Calculated Field
              </button>
              <h3>Dimensions</h3>
              {dims.map((f) => (
                <FieldItem key={f.name} f={f} onDelete={f.calc ? () => onCalcDelete(f.name) : undefined} />
              ))}
              <h3>Measures</h3>
              {measures.map((f) => (
                <FieldItem key={f.name} f={f} onDelete={f.calc ? () => onCalcDelete(f.name) : undefined} />
              ))}
            </>
          )}
        </aside>

        <main
          className="main"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              setOver(true)
            }
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files?.length) return
            e.preventDefault()
            setOver(false)
            upload(e.dataTransfer.files[0])
          }}
        >
          {error && <p className="error">{error}</p>}
          {!active ? (
            <div className="empty">
              <div id="dropzone" className={`dropzone ${over ? 'over' : ''}`} onClick={() => input.current?.click()}>
                <strong>Seret file CSV ke sini</strong>
                atau klik untuk memilih file
              </div>
            </div>
          ) : (
            <>
              <div className="main-head">
                <div>
                  <h2>{active.name}</h2>
                  <p className="sub">{active.fields.length} kolom</p>
                </div>
                <div className="tabs">
                  <button id="tab-worksheet" className={`chip ${view === 'worksheet' ? 'on' : ''}`} onClick={() => setView('worksheet')}>
                    Worksheet
                  </button>
                  <button id="tab-data" className={`chip ${view === 'data' ? 'on' : ''}`} onClick={() => setView('data')}>
                    Data
                  </button>
                </div>
              </div>
              {view === 'worksheet' ? (
                <Worksheet ds={active} />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {active.fields.map((f) => (
                          <th key={f.name} className={f.role}>
                            {f.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          {active.fields.map((f) => (
                            <td key={f.name}>{String(r[f.name] ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {calcOpen && active && <CalcDialog datasourceId={active.id} onCreated={onCalcCreated} onClose={() => setCalcOpen(false)} />}
      <DragOverlay>
        {dragging && (
          <div className={`field overlay ${dragging.role === 'measure' ? 'measure' : ''}`}>{dragging.name}</div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
