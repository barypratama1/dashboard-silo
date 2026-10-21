import { useEffect, useState } from 'react'
import { api, type Field } from './api'

const EXAMPLES = [
  { label: 'Aritmetika', code: '[penjualan] * [qty]' },
  { label: 'Kondisi', code: 'IF [penjualan] > 10000 THEN "Besar" ELSE "Kecil" END' },
  { label: 'Teks', code: 'UPPER([produk]) & " - " & YEAR([tanggal])' },
]

export default function CalcDialog({
  datasourceId,
  onCreated,
  onClose,
}: {
  datasourceId: number
  onCreated: (f: Field) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [expression, setExpression] = useState('')
  const [fns, setFns] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.functions().then(setFns).catch(() => {})
  }, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { field } = await api.addCalc(datasourceId, name, expression)
      onCreated(field)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" id="calc-dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Calculated Field</h2>
        <p className="sub">Ekspresi dihitung per baris. Rujuk field dengan [Nama Field].</p>
        <label>
          Nama
          <input id="calc-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Total" />
        </label>
        <label>
          Ekspresi
          <textarea
            id="calc-expression"
            rows={5}
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            placeholder='[penjualan] * [qty]'
            spellCheck={false}
          />
        </label>
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button type="button" key={ex.label} className="chip" onClick={() => setExpression(ex.code)}>
              {ex.label}
            </button>
          ))}
        </div>
        {fns.length > 0 && (
          <details>
            <summary>Fungsi yang tersedia ({fns.length})</summary>
            <p className="fn-list">{fns.join(', ')}, IF…THEN…ELSEIF…ELSE…END, AND, OR, NOT, &amp;</p>
          </details>
        )}
        {error && (
          <p className="error" id="calc-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Batal
          </button>
          <button id="calc-save" className="btn" disabled={busy || !name.trim() || !expression.trim()}>
            {busy ? 'Memeriksa…' : 'Simpan'}
          </button>
        </div>
      </form>
    </div>
  )
}
