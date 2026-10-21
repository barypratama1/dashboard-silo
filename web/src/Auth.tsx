import { useState } from 'react'
import { api, setToken } from './api'

export default function Auth({ onAuth }: { onAuth: (email: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const fn = mode === 'login' ? api.login : api.register
      const res = await fn(email, password)
      setToken(res.token)
      onAuth(res.user.email)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>Reverse Tableau</h1>
        <p>{mode === 'login' ? 'Masuk untuk melanjutkan' : 'Buat akun baru'}</p>
        <label>
          Email
          <input id="auth-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            id="auth-password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button id="auth-submit" className="btn" disabled={busy}>
          {mode === 'login' ? 'Masuk' : 'Daftar'}
        </button>
        <div className="switch">
          {mode === 'login' ? 'Belum punya akun? ' : 'Sudah punya akun? '}
          <a id="auth-switch" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Daftar' : 'Masuk'}
          </a>
        </div>
      </form>
    </main>
  )
}
