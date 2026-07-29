import { useState, type FormEvent } from 'react'
import { CircleAlert, KeyRound, LoaderCircle, LockKeyhole, Timer } from 'lucide-react'
import { api } from '../api'
import type { Settings } from '../types'
import { errorMessage } from '../lib/format'
import { Modal } from './primitives'

export function SettingsModal({ current, onClose, onSaved }: {
  current: Settings
  onClose: () => void
  onSaved: () => void
}) {
  const [username, setUsername] = useState(current.username)
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [minutes, setMinutes] = useState(current.autoCheckMinutes)
  const [healthAttempts, setHealthAttempts] = useState(current.healthAttempts)
  const [timeoutSeconds, setTimeoutSeconds] = useState(Math.round(current.healthTimeoutMs / 1000))
  const [currentAdminPassword, setCurrentAdminPassword] = useState('')
  const [newAdminPassword, setNewAdminPassword] = useState('')
  const [confirmAdminPassword, setConfirmAdminPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    let passwordChanged = false
    try {
      if (newAdminPassword) {
        if (newAdminPassword !== confirmAdminPassword) throw new Error('两次输入的新管理密码不一致')
        await api.changePassword(currentAdminPassword, newAdminPassword)
        passwordChanged = true
      }
      await api.saveSettings({
        username,
        autoCheckMinutes: minutes,
        healthAttempts,
        healthTimeoutMs: Math.round(Math.max(10, Math.min(1_800, timeoutSeconds || 0)) * 1000),
        ...(clearPassword ? { password: '' } : password ? { password } : {}),
      })
      onSaved(); onClose()
    } catch (err) {
      const message = errorMessage(err)
      if (passwordChanged) {
        setCurrentAdminPassword('')
        setNewAdminPassword('')
        setConfirmAdminPassword('')
      }
      setError(passwordChanged ? `管理密码已修改，但其他设置保存失败：${message}` : message)
    }
    finally { setSaving(false) }
  }

  return <Modal title="默认配置" onClose={onClose} closeDisabled={saving}>
    <form onSubmit={submit}>
      <div className="modal-body form-grid two-cols">
        <div className="form-section"><KeyRound size={15} /><strong>站点默认凭据</strong><span>新增站点时自动填入</span></div>
        <label><span>默认登录账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
        <label><span>默认登录密码</span><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder={current.hasPassword ? '已保存，留空不修改' : '尚未设置'} disabled={clearPassword} /></label>
        {current.hasPassword && <label className="check-line full"><input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} />清除已保存密码</label>}
        <div className="form-section"><Timer size={15} /><strong>测活行为</strong><span>作用于所有站点</span></div>
        <label>
          <span>自动测活间隔（分钟）</span>
          <input type="number" min="0" step="1" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          <small className="form-hint">填 0 关闭后台轮询</small>
        </label>
        <label>
          <span>每个模型测活次数</span>
          <input type="number" min="1" max="10" step="1" value={healthAttempts} onChange={(e) => setHealthAttempts(Number(e.target.value))} />
          <small className="form-hint">1–10 次，结果取平均</small>
        </label>
        <label className="full">
          <span>单次测活超时（秒）</span>
          <input type="number" min="10" max="1800" step="10" value={timeoutSeconds} onChange={(e) => setTimeoutSeconds(Number(e.target.value))} />
          <small className="form-hint">10–1800 秒。推理模型只是思考就可能超过 160 秒，超时过短会把慢模型判成失败</small>
        </label>
        <div className="form-section"><LockKeyhole size={15} /><strong>修改管理密码</strong><span>留空则不修改</span></div>
        <label className="full"><span>当前管理密码</span><input value={currentAdminPassword} onChange={(e) => setCurrentAdminPassword(e.target.value)} type="password" autoComplete="current-password" required={Boolean(newAdminPassword)} /></label>
        <label><span>新管理密码</span><input value={newAdminPassword} onChange={(e) => setNewAdminPassword(e.target.value)} type="password" minLength={8} maxLength={200} autoComplete="new-password" placeholder="至少 8 个字符" /></label>
        <label><span>确认新管理密码</span><input value={confirmAdminPassword} onChange={(e) => setConfirmAdminPassword(e.target.value)} type="password" minLength={8} maxLength={200} autoComplete="new-password" required={Boolean(newAdminPassword)} /></label>
        {error && <div className="form-error full" role="alert"><CircleAlert size={16} />{error}</div>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="button ghost" disabled={saving} onClick={onClose}>取消</button>
        <button className="button primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}保存</button>
      </footer>
    </form>
  </Modal>
}
