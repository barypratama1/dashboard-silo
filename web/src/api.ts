import type { QueryResult } from './chartOption'
import type { VizSpec } from './store'

export interface Field {
  name: string
  type: string
  role: 'dimension' | 'measure'
  kind: 'number' | 'date' | 'string' | 'boolean'
  calc?: boolean
  expression?: string
}
export interface DataSource {
  id: number
  name: string
  createdAt?: string
  fields: Field[]
}
export type FieldStats =
  | { kind: 'values'; values: string[]; truncated: boolean }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'date'; min: string | null; max: string | null }

const TOKEN_KEY = 'rt_token'
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string | null) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json')
  const res = await fetch(url, { ...init, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null)
      location.reload()
    }
    throw new Error(data.error ?? `Request gagal (${res.status})`)
  }
  return data as T
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: { email: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string) =>
    request<{ token: string; user: { email: string } }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  datasources: () => request<DataSource[]>('/api/datasources'),
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return request<DataSource & { rows: number }>('/api/datasources/upload', { method: 'POST', body: fd })
  },
  preview: (id: number) => request<Record<string, unknown>[]>(`/api/datasources/${id}/preview`),
  query: (datasourceId: number, spec: VizSpec) =>
    request<QueryResult>('/api/query', { method: 'POST', body: JSON.stringify({ datasourceId, spec }) }),
  fieldStats: (id: number, field: string) =>
    request<FieldStats>(`/api/datasources/${id}/field-stats?field=${encodeURIComponent(field)}`),
  addCalc: (id: number, name: string, expression: string) =>
    request<{ field: Field }>(`/api/datasources/${id}/calcs`, { method: 'POST', body: JSON.stringify({ name, expression }) }),
  deleteCalc: (id: number, name: string) =>
    request<{ ok: true }>(`/api/datasources/${id}/calcs/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  functions: () => request<string[]>('/api/expression-functions'),
}
