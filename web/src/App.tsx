import { useState } from 'react'
import Auth from './Auth'
import Workspace from './Workspace'
import { getToken } from './api'

function emailFromToken(): string | null {
  const t = getToken()
  if (!t) return null
  try {
    return JSON.parse(atob(t.split('.')[1])).email
  } catch {
    return null
  }
}

export default function App() {
  const [email, setEmail] = useState<string | null>(emailFromToken)
  return email ? <Workspace email={email} onLogout={() => setEmail(null)} /> : <Auth onAuth={setEmail} />
}
