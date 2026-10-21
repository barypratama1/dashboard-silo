import { create } from 'zustand'
import type { Field } from './api'

export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none'
export type Trunc = 'year' | 'quarter' | 'month' | 'week' | 'day'
export type Mark = 'auto' | 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'heatmap' | 'treemap'
export type ShelfId = 'columns' | 'rows' | 'color' | 'filters'

export interface ShelfField {
  field: string
  agg?: Agg
  trunc?: Trunc
}

/** Mirrors FilterSpec on the server: dimensions use values, numbers use min/max, dates use from/to. */
export interface FilterSpec {
  field: string
  values?: string[]
  min?: number | null
  max?: number | null
  from?: string | null
  to?: string | null
}

export interface VizSpec {
  mark: Mark
  columns: ShelfField[]
  rows: ShelfField[]
  color: ShelfField | null
  filters: FilterSpec[]
}

export const emptySpec = (): VizSpec => ({ mark: 'auto', columns: [], rows: [], color: null, filters: [] })

/** Must mirror fieldLabel() in server/src/compiler.ts: it is the key of each result column. */
export function fieldLabel(f: ShelfField, meta?: Field): string {
  if (meta?.role === 'measure') {
    const agg = f.agg ?? 'sum'
    return agg === 'none' ? f.field : `${agg.toUpperCase()}(${f.field})`
  }
  if (meta?.kind === 'date' && f.trunc) return `${f.trunc.toUpperCase()}(${f.field})`
  return f.field
}

interface VizState {
  spec: VizSpec
  setMark: (m: Mark) => void
  add: (shelf: ShelfId, meta: Field) => void
  remove: (shelf: ShelfId, index: number) => void
  patch: (shelf: ShelfId, index: number, p: Partial<ShelfField>) => void
  setFilter: (index: number, f: FilterSpec) => void
  reset: () => void
}

export const useViz = create<VizState>((set) => ({
  spec: emptySpec(),
  setMark: (mark) => set((s) => ({ spec: { ...s.spec, mark } })),
  add: (shelf, meta) =>
    set((s) => {
      if (shelf === 'filters') {
        // One filter per field; adding again keeps the existing one.
        if (s.spec.filters.some((f) => f.field === meta.name)) return s
        return { spec: { ...s.spec, filters: [...s.spec.filters, { field: meta.name }] } }
      }
      const sf: ShelfField =
        meta.role === 'measure'
          ? { field: meta.name, agg: 'sum' }
          : meta.kind === 'date'
            ? { field: meta.name, trunc: 'month' }
            : { field: meta.name }
      if (shelf === 'color') {
        // Color takes a single dimension (measure-driven color scales come later).
        if (meta.role !== 'dimension') return s
        return { spec: { ...s.spec, color: sf } }
      }
      return { spec: { ...s.spec, [shelf]: [...s.spec[shelf], sf] } }
    }),
  remove: (shelf, index) =>
    set((s) => {
      if (shelf === 'color') return { spec: { ...s.spec, color: null } }
      if (shelf === 'filters') return { spec: { ...s.spec, filters: s.spec.filters.filter((_, i) => i !== index) } }
      return { spec: { ...s.spec, [shelf]: s.spec[shelf].filter((_, i) => i !== index) } }
    }),
  patch: (shelf, index, p) =>
    set((s) => {
      if (shelf === 'filters') return s
      if (shelf === 'color') return { spec: { ...s.spec, color: s.spec.color ? { ...s.spec.color, ...p } : null } }
      return { spec: { ...s.spec, [shelf]: s.spec[shelf].map((f, i) => (i === index ? { ...f, ...p } : f)) } }
    }),
  setFilter: (index, f) =>
    set((s) => ({ spec: { ...s.spec, filters: s.spec.filters.map((x, i) => (i === index ? f : x)) } })),
  reset: () => set({ spec: emptySpec() }),
}))
