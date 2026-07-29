import { useState, type FormEvent } from 'react'
import { Activity, CircleAlert, LoaderCircle, LockKeyhole } from 'lucide-react'
import { api } from '../api'
import type { AuthStatus } from '../types'
import { errorMessage } from '../lib/format'

export function AuthScreen({ status, onAuthenticated }: { status: AuthStatus; onAuthenticated: () => void }) {
  const setup = !status.configured
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (setup && password !== confirmation) { setError('两次输入的密码不一致'); return }
    setSubmitting(true); setError('')
    try {
      if (setup) await api.setupPassword(password)
      else await api.login(password)
      onAuthenticated()
    } catch (err) { setError(errorMessage(err)) }
    finally { setSubmitting(false) }
  }

  return <main className="auth-page">
    <section className="auth-panel">
      <div className="auth-brand"><div className="logo-mark"><Activity size={21} /></div><div><strong>AIMon</strong><span>AI RELAY MONITOR</span></div></div>
      <div className="auth-icon"><LockKeyhole size={26} /></div>
      <h1>{setup ? '设置管理密码' : '登录监控台'}</h1>
      <p>{setup ? '首次使用需要设置管理密码，之后访问监控数据都必须登录。' : '输入管理密码后继续。'}</p>
      <form onSubmit={submit} className="auth-form">
        <label>
          <span>{setup ? '管理密码' : '密码'}</span>
          <input required minLength={setup ? 8 : 1} maxLength={200} type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        </label>
        {setup && <label>
          <span>确认管理密码</span>
          <input required minLength={8} maxLength={200} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </label>}
        {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
        <button className="button primary" disabled={submitting}>{submitting && <LoaderCircle size={16} className="spin" />}{setup ? '完成设置' : '登录'}</button>
      </form>
    </section>
  </main>
}
