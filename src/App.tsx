import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, ArrowLeft, ArrowRight, Bot, Check, ChevronDown, ChevronRight,
  CircleAlert, GripVertical, Layers3, LoaderCircle, LockKeyhole, LogOut, MoveDown, MoveUp, Pencil, Plus,
  RefreshCw, Search, Server, Settings as SettingsIcon, Sparkles, Timer, Trash2, X,
} from 'lucide-react'
import { api } from './api'
import type {
  AuthStatus, Dashboard, GroupItem, HealthJob, HealthJobTarget, HealthStatus, ModelItem, PreparedGroup, Settings,
  SiteEditor, SiteItem,
} from './types'

const statusLabels: Record<HealthStatus, string> = {
  excellent: '优质', available: '可用', failed: '失败', pending: '待测',
}

type StatusFilter = 'all' | HealthStatus

function statusCounts(models: ModelItem[]) {
  return {
    excellent: models.filter((model) => model.status === 'excellent').length,
    available: models.filter((model) => model.status === 'available').length,
    failed: models.filter((model) => model.status === 'failed').length,
    pending: models.filter((model) => model.status === 'pending').length,
  }
}

function HealthBreakdown({ models }: { models: ModelItem[] }) {
  const counts = statusCounts(models)
  const label = `优质 ${counts.excellent}，可用 ${counts.available}，失败 ${counts.failed}，待测 ${counts.pending}`
  return <div className="health-breakdown" aria-label={label} title={label}>
    {counts.excellent > 0 && <span className="excellent"><i />{counts.excellent}</span>}
    {counts.available > 0 && <span className="available"><i />{counts.available}</span>}
    {counts.failed > 0 && <span className="failed"><i />{counts.failed}</span>}
    {counts.pending > 0 && <span className="pending"><i />{counts.pending}</span>}
  </div>
}

function matchesModel(model: ModelItem, statusFilter: StatusFilter): boolean {
  return statusFilter === 'all' || model.status === statusFilter
}

export function siteHasVisibleModels(site: SiteItem, query: string, statusFilter: StatusFilter): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized && statusFilter === 'all') return true
  const siteMatches = !normalized || `${site.name} ${site.baseUrl}`.toLowerCase().includes(normalized)
  if (statusFilter === 'all' && siteMatches) return true
  if (statusFilter === 'all' && site.groups.some((group) => group.name.toLowerCase().includes(normalized))) return true
  return site.groups.some((group) => {
    const groupMatches = siteMatches || group.name.toLowerCase().includes(normalized)
    return group.models.some((model) =>
      matchesModel(model, statusFilter) && (groupMatches || model.name.toLowerCase().includes(normalized)))
  })
}

function fmtMs(value: number | null): string {
  if (value == null) return '--'
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
}

type LatencyMetric = 'ttfb' | 'total' | 'ttft'
type LatencyTone = 'good' | 'warning' | 'bad' | 'neutral'

const latencyThresholds: Record<LatencyMetric, readonly [number, number]> = {
  ttfb: [7_000, 15_000],
  total: [6_000, 20_000],
  ttft: [2_000, 6_000],
}

export function latencyTone(metric: LatencyMetric, value: number | null): LatencyTone {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  const [good, warning] = latencyThresholds[metric]
  if (value < good) return 'good'
  if (value < warning) return 'warning'
  return 'bad'
}

function MetricValue({ metric, value, label }: { metric: LatencyMetric; value: number | null; label: string }) {
  const tone = latencyTone(metric, value)
  return <span className={`metric-value metric-${tone}`} title={`${label}：${fmtMs(value)}`}>{fmtMs(value)}</span>
}

function SuccessValue({ model, activeTarget }: { model: ModelItem; activeTarget?: HealthJobTarget }) {
  const tone: LatencyTone = activeTarget || model.successCount == null || model.attemptCount == null
    ? 'neutral'
    : model.successCount >= model.attemptCount
      ? 'good'
      : model.successCount >= Math.ceil(model.attemptCount * 2 / 3)
        ? 'warning'
        : 'bad'
  const value = activeTarget?.status === 'running'
    ? `第${activeTarget.attempt || 1}/${activeTarget.attemptCount}次`
    : activeTarget?.status === 'queued'
      ? '排队'
      : model.successCount == null || model.attemptCount == null ? '--' : `${model.successCount}/${model.attemptCount}`
  return <span className={`metric-value metric-${tone}`} title={`测活成功率：${value}`}>{value}</span>
}

function fmtTime(value: string | null): string {
  if (!value) return '尚未测活'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date)
}

function fmtCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${currency || '$'} ${value.toFixed(2)}`
  }
}

function scoreModel(model: ModelItem, standardRatio: number | null): number {
  if (!model.attemptCount || model.status === 'pending') return -1_000_000
  const success = (model.successCount || 0) / model.attemptCount
  const price = standardRatio == null ? 0 : 180 / Math.max(standardRatio, 0.05)
  const latency = (model.avgTtftMs || 10_000) * 0.07 + (model.avgTotalMs || 30_000) * 0.012
  return success * 1200 + Math.min(price, 360) - latency
}

function statusError(model: ModelItem): string {
  return model.attempts
    .map((attempt, index) => attempt.ok ? '' : `第${index + 1}次：${attempt.error || '测活失败，未返回错误信息'}`)
    .filter(Boolean)
    .join('\n')
}

function IconButton({ title, children, onClick, tone = 'default', disabled = false }: {
  title: string; children: ReactNode; onClick: () => void; tone?: 'default' | 'danger'; disabled?: boolean
}) {
  return <button type="button" className={`icon-button ${tone}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>
}

function StatusBadge({ model, activeTarget }: { model: ModelItem; activeTarget?: HealthJobTarget }) {
  const title = statusError(model)
  const label = activeTarget?.status === 'running' ? '测活中' : activeTarget?.status === 'queued' ? '排队中' : statusLabels[model.status]
  const active = Boolean(activeTarget)
  return (
    <span className={`status status-${active ? 'pending' : model.status}`} title={title || label}>
      {active && <LoaderCircle size={13} className={activeTarget?.status === 'running' ? 'spin' : ''} />}
      <span className="status-dot" />{label}
    </span>
  )
}

function Modal({ title, children, onClose, wide = false, closeDisabled = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean; closeDisabled?: boolean
}) {
  const titleId = useId()
  const modalRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    modalRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !closeDisabled) closeRef.current()
      if (event.key !== 'Tab' || !modalRef.current) return
      const focusable = [...modalRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )]
      if (!focusable.length) {
        event.preventDefault()
        modalRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previous?.focus()
    }
  }, [closeDisabled])
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !closeDisabled && onClose()}>
      <section ref={modalRef} tabIndex={-1} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header"><h2 id={titleId} title={title}>{title}</h2><IconButton title={closeDisabled ? '操作完成后可关闭' : '关闭'} disabled={closeDisabled} onClick={onClose}><X size={18} /></IconButton></header>
        {children}
      </section>
    </div>
  )
}

function AttemptModal({ model, activeTarget, onClose }: { model: ModelItem; activeTarget?: HealthJobTarget; onClose: () => void }) {
  const successes = model.attempts.filter((attempt) => attempt.ok).length
  const attemptCount = model.attemptCount || model.attempts.length || 3
  return <Modal title={`测活详情 · ${model.name}`} onClose={onClose} wide>
    <div className="modal-body attempt-modal-body">
      <div className="attempt-overview">
        <div><span>综合结果</span><StatusBadge model={model} activeTarget={activeTarget} /></div>
        <div><span>{activeTarget ? '当前进度' : '成功次数'}</span><strong>{activeTarget ? `第 ${activeTarget.attempt || 1}/${activeTarget.attemptCount} 次` : `${successes}/${attemptCount}`}</strong></div>
        <div><span>最近测活</span><strong>{fmtTime(model.checkedAt)}</strong></div>
      </div>
      <div className="attempt-list">
        {model.attempts.map((attempt, index) => <article className={`attempt-item ${attempt.ok ? 'ok' : 'failed'}`} key={index}>
          <header>
            <span className="attempt-index">{index + 1}</span>
            <div><strong>第 {index + 1} 次请求</strong><small>{attempt.ok ? '请求成功' : '请求失败'}</small></div>
            <span className="attempt-http">{attempt.httpStatus ? `HTTP ${attempt.httpStatus}` : '无有效响应'}</span>
          </header>
          <div className="attempt-metrics">
            <span>首字 <b>{fmtMs(attempt.ttfbMs)}</b></span>
            <span>TTFT <b>{fmtMs(attempt.ttftMs)}</b></span>
            <span>耗时 <b>{fmtMs(attempt.totalMs)}</b></span>
          </div>
          {!attempt.ok && <p>{attempt.error || '测活失败，未返回错误信息'}</p>}
        </article>)}
        {!model.attempts.length && <div className="empty-inline">尚无测活尝试记录</div>}
      </div>
    </div>
    <footer className="modal-footer"><button type="button" className="button primary" onClick={onClose}>关闭</button></footer>
  </Modal>
}

function AuthScreen({ status, onAuthenticated }: { status: AuthStatus; onAuthenticated: () => void }) {
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
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSubmitting(false) }
  }
  return <main className="auth-page">
    <section className="auth-panel">
      <div className="auth-brand"><div className="logo-mark"><Activity size={21} /></div><div><strong>AIMon</strong><span>AI RELAY MONITOR</span></div></div>
      <div className="auth-icon"><LockKeyhole size={26} /></div>
      <h1>{setup ? '设置管理密码' : '登录监控台'}</h1>
      <p>{setup ? '首次使用需要设置管理密码，之后访问监控数据都必须登录。' : '输入管理密码后继续。'}</p>
      <form onSubmit={submit} className="auth-form">
        <label><span>{setup ? '管理密码' : '密码'}</span><input required minLength={setup ? 8 : 1} maxLength={200} type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
        {setup && <label><span>确认管理密码</span><input required minLength={8} maxLength={200} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>}
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        <button className="button primary" disabled={submitting}>{submitting && <LoaderCircle size={16} className="spin" />}{setup ? '完成设置' : '登录'}</button>
      </form>
    </section>
  </main>
}

function SettingsModal({ current, onClose, onSaved }: {
  current: Settings; onClose: () => void; onSaved: () => void
}) {
  const [username, setUsername] = useState(current.username)
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [minutes, setMinutes] = useState(current.autoCheckMinutes)
  const [healthAttempts, setHealthAttempts] = useState(current.healthAttempts)
  const [currentAdminPassword, setCurrentAdminPassword] = useState('')
  const [newAdminPassword, setNewAdminPassword] = useState('')
  const [confirmAdminPassword, setConfirmAdminPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      if (newAdminPassword) {
        if (newAdminPassword !== confirmAdminPassword) throw new Error('两次输入的新管理密码不一致')
        await api.changePassword(currentAdminPassword, newAdminPassword)
      }
      await api.saveSettings({
        username,
        autoCheckMinutes: minutes,
        healthAttempts,
        ...(clearPassword ? { password: '' } : password ? { password } : {}),
      })
      onSaved(); onClose()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }
  return (
    <Modal title="默认配置" onClose={onClose} closeDisabled={saving}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <label><span>默认登录账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
          <label><span>默认登录密码</span><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder={current.hasPassword ? '已保存，留空不修改' : '尚未设置'} disabled={clearPassword} /></label>
          {current.hasPassword && <label className="check-line"><input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} />清除已保存密码</label>}
          <label><span>自动测活间隔（分钟）</span><input type="number" min="0" step="1" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
          <label><span>每个模型测活次数</span><input type="number" min="1" max="10" step="1" value={healthAttempts} onChange={(e) => setHealthAttempts(Number(e.target.value))} /></label>
          <div className="form-section"><LockKeyhole size={15} /><strong>修改管理密码</strong><span>留空则不修改</span></div>
          <label><span>当前管理密码</span><input value={currentAdminPassword} onChange={(e) => setCurrentAdminPassword(e.target.value)} type="password" autoComplete="current-password" required={Boolean(newAdminPassword)} /></label>
          <label><span>新管理密码</span><input value={newAdminPassword} onChange={(e) => setNewAdminPassword(e.target.value)} type="password" minLength={8} maxLength={200} autoComplete="new-password" placeholder="至少 8 个字符" /></label>
          <label><span>确认新管理密码</span><input value={confirmAdminPassword} onChange={(e) => setConfirmAdminPassword(e.target.value)} type="password" minLength={8} maxLength={200} autoComplete="new-password" required={Boolean(newAdminPassword)} /></label>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        </div>
        <footer className="modal-footer"><button type="button" className="button ghost" disabled={saving} onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}保存</button></footer>
      </form>
    </Modal>
  )
}

function Steps({ step, manual }: { step: number; manual: boolean }) {
  const labels = manual ? ['站点与分组', '选择模型'] : ['站点信息', '选择分组', '选择模型']
  const visibleStep = manual && step === 3 ? 2 : step
  return <div className="steps" style={{ gridTemplateColumns: `repeat(${labels.length}, 1fr)` }}>{labels.map((label, index) => <div className={`step ${visibleStep >= index + 1 ? 'active' : ''}`} key={label}><span>{visibleStep > index + 1 ? <Check size={13} /> : index + 1}</span>{label}</div>)}</div>
}

type ManualGroupForm = { clientId: string; id?: number; name: string; ratio: number; apiKey: string; hasKey: boolean }

function emptyManualGroup(): ManualGroupForm {
  return { clientId: crypto.randomUUID(), name: '', ratio: 1, apiKey: '', hasKey: false }
}

function SiteWizard({ siteId, onClose, onSaved }: {
  siteId?: number
  onClose: () => void
  onSaved: (runHealth: boolean, dashboard?: Dashboard, job?: HealthJob, warning?: string) => void
}) {
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(Boolean(siteId))
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<SiteEditor | null>(null)
  const [mode, setMode] = useState<'auto' | 'manual'>('auto')
  const [form, setForm] = useState({ name: '', baseUrl: '', username: '', password: '', rechargeRatio: 1, useDefault: true })
  const [manualGroups, setManualGroups] = useState<ManualGroupForm[]>([emptyManualGroup()])
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set())
  const [prepared, setPrepared] = useState<PreparedGroup[]>([])
  const [selectedModels, setSelectedModels] = useState<Map<number, Set<number>>>(new Map())
  const [savingWithHealth, setSavingWithHealth] = useState(true)
  const operationRef = useRef(false)

  async function cancel() {
    if (editor?.draftId) {
      try { await api.discardDraft(editor.draftId) } catch { /* Draft cleanup is best effort. */ }
    }
    onClose()
  }

  useEffect(() => {
    if (!siteId) return
    api.site(siteId).then((site) => {
      setEditor(site)
      setMode(site.connectionMode)
      setForm({ name: site.name, baseUrl: site.baseUrl, username: site.username, password: '', rechargeRatio: site.rechargeRatio, useDefault: !site.username && !site.hasPassword })
      setSelectedGroups(new Set(site.groups.filter((group) => group.selected).map((group) => group.id)))
      if (site.connectionMode === 'manual') {
        setManualGroups(site.groups.map((group) => ({
          clientId: crypto.randomUUID(), id: group.id, name: group.name, ratio: group.ratio, apiKey: '', hasKey: group.hasKey,
        })))
      }
    }).catch((err) => setError(err.message)).finally(() => setLoading(false))
  }, [siteId])

  async function discover(event: FormEvent) {
    if (operationRef.current) return
    operationRef.current = true
    event.preventDefault(); setLoading(true); setError('')
    try {
      if (mode === 'manual') {
        const result = await api.manual({
          ...(siteId ? { id: siteId } : {}),
          ...(editor?.draftId ? { draftId: editor.draftId } : {}),
          name: form.name, baseUrl: form.baseUrl, rechargeRatio: form.rechargeRatio,
          groups: manualGroups.map((group) => ({
            ...(group.id ? { id: group.id } : {}), name: group.name, ratio: group.ratio,
            ...(group.apiKey ? { apiKey: group.apiKey } : {}),
          })),
        })
        setEditor(result.editor)
        setPrepared(result.groups)
        setSelectedModels(new Map(result.groups.map((group) => [group.id, new Set(group.models.filter((model) => model.selected).map((model) => model.id))])))
        setStep(3)
        return
      }
      const site = await api.discover({
        ...(siteId ? { id: siteId } : {}),
        ...(editor?.draftId ? { draftId: editor.draftId } : {}),
        name: form.name, baseUrl: form.baseUrl, rechargeRatio: form.rechargeRatio,
        ...(form.useDefault ? { username: '', password: '' } : { username: form.username, ...(form.password ? { password: form.password } : {}) }),
      })
      setEditor(site)
      setSelectedGroups(new Set(site.groups.filter((group) => group.selected && group.available).map((group) => group.id)))
      setStep(2)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { operationRef.current = false; setLoading(false) }
  }

  async function prepare() {
    if (!editor || !selectedGroups.size || operationRef.current) return
    operationRef.current = true
    setLoading(true); setError('')
    try {
      if (!editor.draftId) throw new Error('请先探测站点')
      const result = await api.prepare(editor.draftId, [...selectedGroups])
      setPrepared(result.groups)
      setSelectedModels(new Map(result.groups.map((group) => [group.id, new Set(group.models.filter((model) => model.selected).map((model) => model.id))])))
      setStep(3)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { operationRef.current = false; setLoading(false) }
  }

  async function finish(runHealth: boolean) {
    if (!editor || operationRef.current) return
    const selections = prepared.map((group) => ({ groupId: group.id, modelIds: [...(selectedModels.get(group.id) || [])] }))
    if (selections.some((item) => !item.modelIds.length)) { setError('每个分组至少选择一个模型'); return }
    operationRef.current = true
    setSavingWithHealth(runHealth); setLoading(true); setError('')
    try {
      if (!editor.draftId) throw new Error('配置草稿不存在，请重新探测站点')
      const result = await api.configure(editor.draftId, selections, runHealth)
      onSaved(runHealth, result.dashboard, result.job, result.healthStartError || result.refreshError)
      onClose()
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { operationRef.current = false; setLoading(false) }
  }

  function toggleModel(groupId: number, modelId: number) {
    setSelectedModels((current) => {
      const next = new Map(current); const set = new Set(next.get(groupId) || [])
      set.has(modelId) ? set.delete(modelId) : set.add(modelId); next.set(groupId, set); return next
    })
  }

  return (
    <Modal title={siteId ? '编辑站点' : '添加站点'} onClose={() => void cancel()} wide closeDisabled={loading}>
      <Steps step={step} manual={mode === 'manual'} />
      {loading && <div className="modal-loading"><LoaderCircle className="spin" size={28} /><span>{step === 1 ? (mode === 'manual' ? '正在验证 API Key 并获取模型' : '正在识别站点并获取账户信息') : step === 2 ? '正在准备分组 Key 与模型' : savingWithHealth ? '正在保存并启动测活' : '正在保存配置'}</span></div>}
      {!loading && step === 1 && <form onSubmit={discover}>
        <div className="modal-body form-grid two-cols">
          <div className="mode-switch full" role="group" aria-label="接入方式"><button type="button" className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>自动登录</button><button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>手动 API Key</button></div>
          <label><span>站点名称</span><input required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：主力渠道" /></label>
          <label><span>Base URL（/v1 可省略）</span><input required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com" /></label>
          <label><span>充值比例</span><div className="input-prefix"><b>x</b><input required type="number" min="0.000001" step="any" value={form.rechargeRatio} onChange={(e) => setForm({ ...form, rechargeRatio: Number(e.target.value) })} /></div></label>
          {mode === 'auto' && <>
            <label className="check-line full"><input type="checkbox" checked={form.useDefault} onChange={(e) => setForm({ ...form, useDefault: e.target.checked })} />使用默认登录凭据</label>
            <label><span>登录账号</span><input value={form.username} disabled={form.useDefault} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="username" /></label>
            <label><span>登录密码</span><input value={form.password} disabled={form.useDefault} onChange={(e) => setForm({ ...form, password: e.target.value })} type="password" autoComplete="new-password" placeholder={editor?.hasPassword ? '已保存，留空不修改' : ''} /></label>
          </>}
          {mode === 'manual' && <section className="manual-groups full">
            <header><h3>分组与 API Key</h3><button type="button" className="button ghost compact" onClick={() => setManualGroups((current) => [...current, emptyManualGroup()])}><Plus size={15} />添加分组</button></header>
            {manualGroups.map((group, index) => <div className="manual-group-row" key={group.clientId}>
              <label><span>分组名称</span><input required maxLength={120} value={group.name} onChange={(e) => setManualGroups((current) => current.map((item) => item.clientId === group.clientId ? { ...item, name: e.target.value } : item))} placeholder={`分组 ${index + 1}`} /></label>
              <label><span>倍率</span><div className="input-prefix"><b>x</b><input required type="number" min="0.000001" step="any" value={group.ratio} onChange={(e) => setManualGroups((current) => current.map((item) => item.clientId === group.clientId ? { ...item, ratio: Number(e.target.value) } : item))} /></div></label>
              <label><span>API Key</span><input required={!group.hasKey} type="password" autoComplete="off" value={group.apiKey} onChange={(e) => setManualGroups((current) => current.map((item) => item.clientId === group.clientId ? { ...item, apiKey: e.target.value } : item))} placeholder={group.hasKey ? '已保存，留空沿用' : 'sk-...'} /></label>
              <IconButton title="删除此分组" tone="danger" disabled={manualGroups.length === 1} onClick={() => setManualGroups((current) => current.filter((item) => item.clientId !== group.clientId))}><Trash2 size={16} /></IconButton>
            </div>)}
          </section>}
          {error && <div className="form-error full"><CircleAlert size={16} />{error}</div>}
        </div>
        <footer className="modal-footer"><button type="button" className="button ghost" onClick={() => void cancel()}>取消</button><button className="button primary">{mode === 'manual' ? '获取模型' : '探测站点'}<ArrowRight size={16} /></button></footer>
      </form>}
      {!loading && step === 2 && mode === 'auto' && editor && <>
        <div className="site-found"><span className={`platform ${editor.type}`}>{editor.type === 'newapi' ? 'New API' : 'Sub2API'}</span><div><small>账户余额</small><strong>{fmtCurrency(editor.balance, editor.currency)}</strong></div><div><small>充值比例</small><strong>x{editor.rechargeRatio}</strong></div></div>
        <div className="modal-body selection-list">
          {editor.groups.filter((group) => group.available).map((group) => <label className="selection-row" key={group.id}>
            <input type="checkbox" checked={selectedGroups.has(group.id)} onChange={() => setSelectedGroups((current) => { const next = new Set(current); next.has(group.id) ? next.delete(group.id) : next.add(group.id); return next })} />
            <span><b>{group.name}</b><small>{group.platform || '通用分组'}</small></span><strong>{group.ratioDynamic ? '自动' : `x${group.ratio}`}</strong>{group.hasKey && <em>已复用 Key</em>}
          </label>)}
          {!editor.groups.some((group) => group.available) && <div className="empty-inline">没有可选分组</div>}
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        </div>
        <footer className="modal-footer"><button className="button ghost" onClick={() => setStep(1)}><ArrowLeft size={16} />返回</button><button className="button primary" onClick={prepare} disabled={!selectedGroups.size}>确认分组<ArrowRight size={16} /></button></footer>
      </>}
      {!loading && step === 3 && <>
        <div className="modal-body model-selector">
          {prepared.map((group) => <section className="model-select-group" key={group.id}>
            <header><div><h3>{group.name}</h3><span>{group.standardRatio == null ? '动态倍率 · 不参与价格推荐' : `x${group.ratio} · 标准 x${group.standardRatio.toFixed(3)}`}</span></div><button className="text-button" onClick={() => setSelectedModels((current) => { const next = new Map(current); const all = group.models.map((m) => m.id); next.set(group.id, (next.get(group.id)?.size || 0) === all.length ? new Set() : new Set(all)); return next })}>全选 / 取消</button></header>
            <div className="model-check-grid">{group.models.map((model) => <label key={model.id}><input type="checkbox" checked={selectedModels.get(group.id)?.has(model.id) || false} onChange={() => toggleModel(group.id, model.id)} /><span title={model.name}>{model.name}</span></label>)}</div>
          </section>)}
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        </div>
        <footer className="modal-footer"><button className="button ghost" onClick={() => setStep(mode === 'manual' ? 1 : 2)}><ArrowLeft size={16} />返回</button><button className="button ghost" onClick={() => void finish(false)}>保存</button><button className="button primary" onClick={() => void finish(true)}>保存并测活<Check size={16} /></button></footer>
      </>}
    </Modal>
  )
}

type HealthScope = { siteId?: number; groupId?: number; modelId?: number }

function ModelTable({ group, recommended, onHealth, activeTargetFor }: {
  group: GroupItem
  recommended: boolean
  onHealth: (scope: HealthScope) => void
  activeTargetFor: (modelId: number) => HealthJobTarget | undefined
}) {
  const models = useMemo(() => recommended ? [...group.models].sort((a, b) => scoreModel(b, group.standardRatio) - scoreModel(a, group.standardRatio)) : group.models, [group, recommended])
  const [detailsModelId, setDetailsModelId] = useState<number | null>(null)
  const detailsModel = detailsModelId == null ? null : models.find((model) => model.id === detailsModelId) || null
  return <>
    <div className="model-grid">
      {models.map((model, index) => {
        const activeTarget = activeTargetFor(model.id)
        const checking = Boolean(activeTarget)
        const failures = model.attempts.filter((attempt) => !attempt.ok).length
        const cardStatus = activeTarget ? 'pending' : model.status
        return <article className={`model-card model-card-${cardStatus} ${activeTarget?.status === 'running' ? 'checking' : activeTarget?.status === 'queued' ? 'queued' : ''}`} key={model.id}>
          <header className="model-card-header">
            <div className="model-card-title">
              {recommended && <span className="model-rank">{index + 1}</span>}
              <span className="model-icon"><Bot size={16} /></span>
              <div className="model-heading"><small>模型</small><h4 title={model.name}>{model.name}</h4></div>
            </div>
            <div className="model-card-controls">
              <StatusBadge model={model} activeTarget={activeTarget} />
            </div>
          </header>
          <div className="model-metrics">
            <div className="model-metric"><span>成功率</span><SuccessValue model={model} activeTarget={activeTarget} /></div>
            <div className="model-metric"><span>平均首字</span><MetricValue metric="ttfb" value={model.avgTtfbMs} label="平均首字（TTFB，首响应字节）" /></div>
            <div className="model-metric"><span>平均 TTFT</span><MetricValue metric="ttft" value={model.avgTtftMs} label="平均 TTFT（首个非空文本 token）" /></div>
            <div className="model-metric"><span>平均耗时</span><MetricValue metric="total" value={model.avgTotalMs} label="平均耗时" /></div>
          </div>
          <footer className="model-card-footer">
            <div><span>最近测活</span><time dateTime={model.checkedAt || undefined}>{fmtTime(model.checkedAt)}</time></div>
            {model.attempts.length > 0 && <button type="button" className={`attempt-link ${failures ? 'has-failures' : ''}`} onClick={() => setDetailsModelId(model.id)}>
              {failures ? `${failures} 次失败` : `${model.successCount ?? model.attempts.length} 次成功`} · 详情
            </button>}
            <IconButton title={activeTarget?.status === 'running' ? '此模型正在测活' : activeTarget?.status === 'queued' ? '此模型等待测活' : '测活此模型'} disabled={checking} onClick={() => onHealth({ modelId: model.id })}><RefreshCw className={activeTarget?.status === 'running' ? 'spin' : ''} size={15} /></IconButton>
          </footer>
        </article>
      })}
    </div>
    {detailsModel && <AttemptModal model={detailsModel} activeTarget={activeTargetFor(detailsModel.id)} onClose={() => setDetailsModelId(null)} />}
  </>
}

function SitePanel({ site, recommended, query, statusFilter, onEdit, onDelete, onHealth, isHealthActive, activeTargetFor, onChanged, onError, onMoveSite, siteIndex, siteCount, dragging, setDragging }: {
  site: SiteItem; recommended: boolean; onEdit: () => void; onDelete: () => void;
  onHealth: (scope: HealthScope) => void; isHealthActive: (scope: HealthScope) => boolean; activeTargetFor: (modelId: number) => HealthJobTarget | undefined; onChanged: () => void; onError: (message: string) => void; onMoveSite: (delta: number) => void; siteIndex: number; siteCount: number;
  query: string; statusFilter: StatusFilter;
  dragging: { kind: 'site' | 'group'; id: number } | null; setDragging: (value: { kind: 'site' | 'group'; id: number } | null) => void
}) {
  const [localGroups, setLocalGroups] = useState(site.groups)
  const [siteExpanded, setSiteExpanded] = useState(site.expanded)
  const groupMutationRef = useRef(false)
  const siteToggleRef = useRef(false)
  const siteExpandedOverrideRef = useRef<boolean | null>(null)
  const groupToggleRef = useRef(new Set<number>())
  const groupExpandedOverridesRef = useRef(new Map<number, boolean>())
  useEffect(() => {
    if (groupMutationRef.current) return
    setLocalGroups(site.groups.map((group) => {
      const desired = groupExpandedOverridesRef.current.get(group.id)
      if (desired == null) return group
      if (group.expanded === desired) {
        groupExpandedOverridesRef.current.delete(group.id)
        return group
      }
      return { ...group, expanded: desired }
    }))
  }, [site.groups])
  useEffect(() => {
    const desired = siteExpandedOverrideRef.current
    if (desired == null) {
      setSiteExpanded(site.expanded)
      return
    }
    if (site.expanded === desired) {
      siteExpandedOverrideRef.current = null
      setSiteExpanded(site.expanded)
    }
  }, [site.id, site.expanded])
  const orderedGroups = recommended ? [...localGroups].sort((a, b) => {
    const bestA = Math.max(...a.models.map((m) => scoreModel(m, a.standardRatio)), -1_000_000)
    const bestB = Math.max(...b.models.map((m) => scoreModel(m, b.standardRatio)), -1_000_000)
    return bestB - bestA
  }) : localGroups
  const normalizedQuery = query.trim().toLowerCase()
  const filtering = Boolean(normalizedQuery || statusFilter !== 'all')
  const siteMatches = !normalizedQuery || `${site.name} ${site.baseUrl}`.toLowerCase().includes(normalizedQuery)
  const groups = orderedGroups.map((group): GroupItem | null => {
    const groupMatches = siteMatches || group.name.toLowerCase().includes(normalizedQuery)
    const models = group.models.filter((model) =>
      matchesModel(model, statusFilter) && (groupMatches || model.name.toLowerCase().includes(normalizedQuery)))
    if (filtering && !models.length && !(statusFilter === 'all' && groupMatches)) return null
    return {
      ...group,
      models,
    }
  }).filter((group): group is GroupItem => group !== null)
  const siteModels = localGroups.flatMap((group) => group.models)
  async function toggleSite() {
    if (siteToggleRef.current) return
    siteToggleRef.current = true
    const next = !siteExpanded
    siteExpandedOverrideRef.current = next
    setSiteExpanded(next)
    try {
      await api.expanded('site', site.id, next)
      setSiteExpanded(next)
    }
    catch (error) {
      siteExpandedOverrideRef.current = null
      setSiteExpanded(!next)
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      siteToggleRef.current = false
    }
  }
  async function toggleGroup(group: GroupItem) {
    if (groupToggleRef.current.has(group.id)) return
    groupToggleRef.current.add(group.id)
    const next = !group.expanded
    groupExpandedOverridesRef.current.set(group.id, next)
    setLocalGroups((current) => current.map((item) => item.id === group.id ? { ...item, expanded: next } : item))
    try {
      await api.expanded('group', group.id, next)
      setLocalGroups((current) => current.map((item) => item.id === group.id ? { ...item, expanded: next } : item))
    }
    catch (error) {
      groupExpandedOverridesRef.current.delete(group.id)
      setLocalGroups((current) => current.map((item) => item.id === group.id ? { ...item, expanded: !next } : item))
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      groupToggleRef.current.delete(group.id)
    }
  }
  async function dropGroup(targetId: number) {
    if (recommended || filtering || groupMutationRef.current || dragging?.kind !== 'group' || dragging.id === targetId) return
    const from = localGroups.findIndex((g) => g.id === dragging.id); const to = localGroups.findIndex((g) => g.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...localGroups]; next.splice(to, 0, next.splice(from, 1)[0]); setLocalGroups(next); setDragging(null)
    groupMutationRef.current = true
    try { await api.reorder('group', next.map((g) => g.id)); onChanged() }
    catch { setLocalGroups(site.groups) }
    finally { groupMutationRef.current = false }
  }
  async function moveGroup(index: number, delta: number) {
    if (recommended || filtering || groupMutationRef.current) return
    const target = index + delta
    if (target < 0 || target >= localGroups.length) return
    const next = [...localGroups]
    ;[next[index], next[target]] = [next[target], next[index]]
    setLocalGroups(next)
    groupMutationRef.current = true
    try { await api.reorder('group', next.map((group) => group.id)); onChanged() }
    catch { setLocalGroups(site.groups) }
    finally { groupMutationRef.current = false }
  }
  const siteChecking = isHealthActive({ siteId: site.id })
  return <article className="site-panel">
    <header className="site-header">
      <div className="site-reorder">
        <button className="drag-handle" title={filtering ? '筛选时无法排序' : '拖动排序'} draggable={!recommended && !filtering} onDragStart={() => setDragging({ kind: 'site', id: site.id })} disabled={recommended || filtering}><GripVertical size={18} /></button>
        <button className="collapse" aria-expanded={siteExpanded} onClick={() => void toggleSite()} title={siteExpanded ? '收起站点' : '展开站点'}>{siteExpanded ? <ChevronDown size={19} /> : <ChevronRight size={19} />}</button>
      </div>
      <div className="site-identity">
        <div className="site-mark"><Server size={18} /></div>
        <div><small className="layer-kicker">站点</small><div className="site-name-line"><h2>{site.name}</h2><span className={`platform ${site.connectionMode === 'manual' ? 'manual' : site.type}`}>{site.connectionMode === 'manual' ? '手动接入' : site.type === 'newapi' ? 'New API' : 'Sub2API'}</span></div><a href={site.baseUrl} target="_blank" rel="noreferrer">{site.baseUrl}</a></div>
      </div>
      <div className="site-facts">
        <div><small>账户余额</small><strong>{site.balanceKnown ? fmtCurrency(site.balance, site.currency) : '--'}</strong></div>
        <div><small>监控范围</small><strong>{site.groups.length}<em> 组</em> / {site.groups.reduce((sum, group) => sum + group.models.length, 0)}<em> 模型</em></strong></div>
        <div><small>健康分布</small><HealthBreakdown models={siteModels} /></div>
        <div><small>最近测活</small><span>{fmtTime(site.lastCheckAt)}</span></div>
      </div>
      <div className="site-actions"><span className="mobile-order"><IconButton title="站点上移" disabled={recommended || filtering || siteIndex === 0} onClick={() => onMoveSite(-1)}><MoveUp size={15} /></IconButton><IconButton title="站点下移" disabled={recommended || filtering || siteIndex === siteCount - 1} onClick={() => onMoveSite(1)}><MoveDown size={15} /></IconButton></span><button type="button" className="button compact site-health-button" title={siteChecking ? '此站点正在测活' : '测活此站点'} disabled={siteChecking} onClick={() => onHealth({ siteId: site.id })}><RefreshCw className={siteChecking ? 'spin' : ''} size={15} /><span>{siteChecking ? '测活中' : '测活'}</span></button><IconButton title="编辑站点" onClick={onEdit}><Pencil size={16} /></IconButton><IconButton title="删除站点" tone="danger" onClick={onDelete}><Trash2 size={16} /></IconButton></div>
    </header>
    {siteExpanded && <div className="groups">
      {groups.map((group, groupIndex) => {
        const groupChecking = isHealthActive({ groupId: group.id })
        return <section className="group" key={group.id} onDragOver={(e) => !recommended && e.preventDefault()} onDrop={() => dropGroup(group.id)}>
        <header className="group-header">
          <div className="group-leading">
            <button className="drag-handle" title={filtering ? '筛选时无法排序' : '拖动排序'} draggable={!recommended && !filtering} onDragStart={(e) => { e.stopPropagation(); setDragging({ kind: 'group', id: group.id }) }} disabled={recommended || filtering}><GripVertical size={16} /></button>
            <button className="collapse" aria-expanded={group.expanded} onClick={() => void toggleGroup(group)} title={group.expanded ? '收起分组' : '展开分组'}>{group.expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
            <div className="group-title"><Layers3 size={14} /><div><small className="layer-kicker">分组</small><div><h3>{group.name}</h3>{group.platform && <span>{group.platform}</span>}</div></div></div>
          </div>
          <div className="group-meta">
            <span>分组倍率 <b>{group.ratioDynamic ? '自动' : `x${group.ratio}`}</b></span>
            <span>标准倍率 <b className="standard-ratio">{group.standardRatio == null ? '--' : `x${group.standardRatio.toFixed(3)}`}</b></span>
            <span>{group.models.length} 个模型</span>
            <HealthBreakdown models={group.models} />
          </div>
          <div className="group-actions"><span className="mobile-order"><IconButton title="分组上移" disabled={recommended || filtering || groupIndex === 0} onClick={() => void moveGroup(groupIndex, -1)}><MoveUp size={14} /></IconButton><IconButton title="分组下移" disabled={recommended || filtering || groupIndex === groups.length - 1} onClick={() => void moveGroup(groupIndex, 1)}><MoveDown size={14} /></IconButton></span><button type="button" className="button compact group-health-button" title={groupChecking ? '此分组正在测活' : '测活此分组'} disabled={groupChecking} onClick={() => onHealth({ groupId: group.id })}><RefreshCw className={groupChecking ? 'spin' : ''} size={15} /><span>{groupChecking ? '测活中' : '测活分组'}</span></button></div>
        </header>
        {group.expanded && <ModelTable group={group} recommended={recommended} onHealth={onHealth} activeTargetFor={activeTargetFor} />}
      </section>
      })}
      {!groups.length && <div className="empty-inline">尚未选择分组，编辑站点以完成配置。</div>}
    </div>}
  </article>
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [jobs, setJobs] = useState<HealthJob[]>([])
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [wizard, setWizard] = useState<{ siteId?: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recommended, setRecommended] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dragging, setDragging] = useState<{ kind: 'site' | 'group'; id: number } | null>(null)
  const [pendingHealthKeys, setPendingHealthKeys] = useState<Set<string>>(new Set())
  const pendingHealthRef = useRef(new Set<string>())
  const dashboardEpochRef = useRef(0)
  const dashboardRequestRef = useRef<Promise<void> | null>(null)
  const dashboardAbortRef = useRef<AbortController | null>(null)
  const jobsRequestRef = useRef<Promise<void> | null>(null)
  const jobsAbortRef = useRef<AbortController | null>(null)
  const jobsEpochRef = useRef(0)
  const siteReorderRef = useRef(false)
  const resumeRefreshRef = useRef<() => void>(() => undefined)
  const lastResumeAtRef = useRef(0)

  function loadDashboard(silent = false): Promise<void> {
    if (dashboardRequestRef.current) return dashboardRequestRef.current
    const epoch = dashboardEpochRef.current
    const controller = new AbortController()
    dashboardAbortRef.current = controller
    const request = api.dashboard(controller.signal)
      .then((data) => {
        if (epoch !== dashboardEpochRef.current) return
        setDashboard(data)
        if (!silent) setError('')
      })
      .catch((err) => {
        if (epoch !== dashboardEpochRef.current || controller.signal.aborted) return
        if (!silent) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (dashboardRequestRef.current === request) {
          dashboardRequestRef.current = null
          if (dashboardAbortRef.current === controller) dashboardAbortRef.current = null
        }
      })
    dashboardRequestRef.current = request
    return request
  }

  function loadJobs(silent = false): Promise<void> {
    if (jobsRequestRef.current) return jobsRequestRef.current
    const epoch = jobsEpochRef.current
    const controller = new AbortController()
    jobsAbortRef.current = controller
    const request = api.jobs(controller.signal)
      .then((data) => {
        if (epoch !== jobsEpochRef.current) return
        setJobs(data)
      })
      .catch((err) => {
        if (epoch !== jobsEpochRef.current || controller.signal.aborted) return
        if (!silent) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (jobsRequestRef.current === request) {
          jobsRequestRef.current = null
          if (jobsAbortRef.current === controller) jobsAbortRef.current = null
        }
      })
    jobsRequestRef.current = request
    return request
  }

  async function load(silent = false): Promise<void> {
    await Promise.all([loadDashboard(silent), loadJobs(silent)])
  }

  function cancelReadRequests(): void {
    dashboardEpochRef.current += 1
    jobsEpochRef.current += 1
    dashboardAbortRef.current?.abort()
    jobsAbortRef.current?.abort()
    dashboardAbortRef.current = null
    jobsAbortRef.current = null
    dashboardRequestRef.current = null
    jobsRequestRef.current = null
  }

  function loadFresh(silent = true): Promise<void> {
    cancelReadRequests()
    return load(silent)
  }
  resumeRefreshRef.current = () => {
    if (auth?.authenticated) void loadFresh(Boolean(dashboard))
  }
  useEffect(() => {
    void api.authStatus().then(setAuth).catch((err) => setError(err instanceof Error ? err.message : String(err)))
    const expired = () => { setAuth((current) => ({ configured: current?.configured ?? true, authenticated: false })); setDashboard(null) }
    window.addEventListener('aimon-auth-expired', expired)
    return () => window.removeEventListener('aimon-auth-expired', expired)
  }, [])
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'hidden') {
        cancelReadRequests()
        return
      }
      const now = Date.now()
      if (now - lastResumeAtRef.current < 500) return
      lastResumeAtRef.current = now
      resumeRefreshRef.current()
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('pageshow', resume)
    return () => {
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('pageshow', resume)
    }
  }, [])
  const hasActiveJob = jobs.some((job) => job.status === 'running' || job.status === 'queued')
  useEffect(() => {
    if (!auth?.authenticated) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let activePolls = 0
    const refresh = async (initial: boolean) => {
      if (document.visibilityState !== 'hidden') {
        if (initial || !hasActiveJob) {
          await load(initial ? false : true)
        } else {
          await loadJobs(true)
          activePolls += 1
          if (activePolls % 3 === 0) await loadDashboard(true)
        }
      }
      if (!stopped) timer = setTimeout(() => void refresh(false), hasActiveJob ? 1000 : 4000)
    }
    void refresh(true)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [auth?.authenticated, hasActiveJob])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 2800); return () => clearTimeout(timer) }, [toast])

  function healthKey(scope: HealthScope): string {
    if (scope.modelId) return `model:${scope.modelId}`
    if (scope.groupId) return `group:${scope.groupId}`
    if (scope.siteId) return `site:${scope.siteId}`
    return 'all'
  }

  function optimisticHealthJob(scope: HealthScope, key: string): HealthJob | null {
    if (!dashboard) return null
    const targets: HealthJobTarget[] = []
    for (const site of dashboard.sites) {
      if (scope.siteId && scope.siteId !== site.id) continue
      for (const group of site.groups) {
        if (scope.groupId && scope.groupId !== group.id) continue
        for (const model of group.models) {
          if (scope.modelId && scope.modelId !== model.id) continue
          targets.push({
            siteId: site.id,
            groupId: group.id,
            modelId: model.id,
            label: `${site.name} / ${group.name} / ${model.name}`,
            status: 'queued',
            attempt: 0,
            attemptCount: dashboard.settings.healthAttempts,
          })
        }
      }
    }
    if (!targets.length) return null
    return {
      id: `optimistic:${key}:${Date.now()}`,
      status: 'queued',
      phase: scope.modelId ? 'checking' : 'refreshing',
      total: targets.length,
      completed: 0,
      current: '',
      targets,
      createdAt: new Date().toISOString(),
    }
  }

  async function health(scope: HealthScope = {}) {
    const key = healthKey(scope)
    if (pendingHealthRef.current.has(key)) return
    pendingHealthRef.current.add(key)
    setPendingHealthKeys(new Set(pendingHealthRef.current))
    const optimistic = optimisticHealthJob(scope, key)
    jobsEpochRef.current += 1
    if (optimistic) setJobs((current) => [optimistic, ...current])
    try {
      const job = await api.health(scope)
      jobsEpochRef.current += 1
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id && item.id !== optimistic?.id)])
      setToast(job.deduplicated ? '重复模型已在测活，本次未重复排队' : '测活任务已开始')
      void load(true)
    }
    catch (err) {
      if (optimistic) setJobs((current) => current.filter((item) => item.id !== optimistic.id))
      setToast(err instanceof Error ? err.message : String(err))
    }
    finally {
      pendingHealthRef.current.delete(key)
      setPendingHealthKeys(new Set(pendingHealthRef.current))
    }
  }
  async function remove(site: SiteItem) {
    if (!window.confirm(`删除站点「${site.name}」及其本地监控数据？远端 API Key 不会删除。`)) return
    try { await api.deleteSite(site.id); setToast('站点已删除'); await load() } catch (err) { setToast(err instanceof Error ? err.message : String(err)) }
  }
  async function dropSite(targetId: number) {
    if (recommended || filtering || siteReorderRef.current || dragging?.kind !== 'site' || !dashboard || dragging.id === targetId) return
    const from = dashboard.sites.findIndex((s) => s.id === dragging.id); const to = dashboard.sites.findIndex((s) => s.id === targetId)
    if (from < 0 || to < 0) return
    const previous = dashboard
    const sites = [...dashboard.sites]; sites.splice(to, 0, sites.splice(from, 1)[0]); setDashboard({ ...dashboard, sites }); setDragging(null)
    siteReorderRef.current = true
    try { await api.reorder('site', sites.map((s) => s.id)); void load(true) }
    catch (err) { setDashboard(previous); setToast(err instanceof Error ? err.message : String(err)) }
    finally { siteReorderRef.current = false }
  }
  async function moveSite(index: number, delta: number) {
    if (recommended || filtering || siteReorderRef.current || !dashboard) return
    const target = index + delta
    if (target < 0 || target >= dashboard.sites.length) return
    const previous = dashboard
    const sites = [...dashboard.sites]
    ;[sites[index], sites[target]] = [sites[target], sites[index]]
    setDashboard({ ...dashboard, sites })
    siteReorderRef.current = true
    try { await api.reorder('site', sites.map((site) => site.id)); void load(true) }
    catch (err) { setDashboard(previous); setToast(err instanceof Error ? err.message : String(err)) }
    finally { siteReorderRef.current = false }
  }
  async function signedIn() {
    const status = await api.authStatus()
    setAuth(status)
    setDashboard(null)
  }
  async function signOut() {
    try { await api.logout() } finally {
      setAuth((current) => ({ configured: current?.configured ?? true, authenticated: false }))
      setDashboard(null)
      setSettingsOpen(false)
    }
  }
  const activeJobs = useMemo(() => jobs.filter((job) => job.status === 'running' || job.status === 'queued'), [jobs])
  const refreshingJobs = activeJobs.filter((job) => job.phase === 'refreshing')
  const activeTargets = useMemo(() => activeJobs.flatMap((job) => job.targets || []).filter((target) => target.status === 'queued' || target.status === 'running'), [activeJobs])
  const runningTargets = activeTargets.filter((target) => target.status === 'running')
  const queuedTargets = activeTargets.filter((target) => target.status === 'queued')
  const activeTotal = activeJobs.reduce((sum, job) => sum + job.total, 0)
  const activeCompleted = activeJobs.reduce((sum, job) => sum + job.completed, 0)
  const activeLabel = refreshingJobs.length
    ? `正在同步测活前的站点信息：${refreshingJobs.flatMap((job) => job.targets).map((target) => target.label).join('；')}`
    : runningTargets.length
    ? `正在测活：${runningTargets.map((target) => `${target.label}（第${target.attempt || 1}/${target.attemptCount}次）`).join('；')}`
    : activeTargets.length ? `等待测活：${activeTargets.map((target) => target.label).join('；')}` : '任务排队中'
  const currentTargetLabel = refreshingJobs.length
    ? '正在刷新分组倍率与站点余额'
    : runningTargets[0]?.label || queuedTargets[0]?.label || ''
  const refreshWarning = activeJobs.find((job) => job.refreshWarning)?.refreshWarning || ''
  const activeTargetByModel = useMemo(() => new Map(activeTargets.map((target) => [target.modelId, target])), [activeTargets])
  const activeGroupIds = useMemo(() => new Set(activeTargets.map((target) => target.groupId)), [activeTargets])
  const activeSiteIds = useMemo(() => new Set(activeTargets.map((target) => target.siteId)), [activeTargets])
  const isHealthActive = (scope: HealthScope): boolean => {
    if (pendingHealthKeys.has(healthKey(scope))) return true
    if (scope.modelId) return activeTargetByModel.has(scope.modelId)
    if (scope.groupId) return activeGroupIds.has(scope.groupId)
    if (scope.siteId) return activeSiteIds.has(scope.siteId)
    return activeJobs.length > 0
  }
  const activeTargetFor = (modelId: number): HealthJobTarget | undefined => activeTargetByModel.get(modelId)
  const visibleSites = dashboard?.sites.filter((site) => siteHasVisibleModels(site, query, statusFilter)) || []
  const filtering = Boolean(query.trim() || statusFilter !== 'all')
  if (!auth) return <div className="app-loading"><div className="logo-mark"><Activity /></div><LoaderCircle className="spin" /><span>{error || '正在检查访问权限'}</span></div>
  if (!auth.authenticated) return <AuthScreen status={auth} onAuthenticated={() => void signedIn()} />
  if (!dashboard) return <div className="app-loading"><div className="logo-mark"><Activity /></div><LoaderCircle className="spin" /><span>{error || '正在载入监控台'}</span></div>

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><div className="logo-mark"><Activity size={20} /></div><div><strong>AIMon</strong><span>AI RELAY MONITOR</span></div></div>
      <div className={`runtime-state ${activeJobs.length ? 'busy' : ''}`}><span />{activeJobs.length ? refreshingJobs.length ? '正在同步站点信息' : `正在测活 ${activeCompleted}/${activeTotal}` : '监控就绪'}</div>
      <div className="app-header-actions"><IconButton title="默认配置" onClick={() => setSettingsOpen(true)}><SettingsIcon size={17} /></IconButton><IconButton title="退出登录" onClick={() => void signOut()}><LogOut size={17} /></IconButton></div>
    </header>
    <main className="workspace">
      <section className="command-bar">
        <div><h1>渠道监控</h1><p>站点、分组与模型的实时可用性</p></div>
        <div className="toolbar"><button className={`button ${recommended ? 'active' : 'ghost'}`} onClick={() => setRecommended(!recommended)} title="切换智能推荐排序"><Sparkles size={16} />{recommended ? '恢复手动排序' : '智能推荐'}</button><button className="button ghost" disabled={isHealthActive({})} onClick={() => void health()}><RefreshCw className={isHealthActive({}) ? 'spin' : ''} size={16} />所有模型测活</button><button className="button primary" onClick={() => setWizard({})}><Plus size={17} />添加站点</button></div>
      </section>
      <section className="control-deck">
        <section className="summary-strip" aria-label="监控概览">
          <div><Server size={17} /><span>站点</span><strong>{dashboard.summary.sites}</strong></div>
          <div><Layers3 size={17} /><span>分组</span><strong>{dashboard.summary.groups}</strong></div>
          <div><Bot size={17} /><span>模型</span><strong>{dashboard.summary.models}</strong></div>
          <div><Activity size={17} /><span>优质模型</span><strong>{dashboard.summary.excellent}<em> / {dashboard.summary.models}</em></strong></div>
          <div><Timer size={17} /><span>自动测活</span><strong>{dashboard.settings.autoCheckMinutes ? `${dashboard.settings.autoCheckMinutes} 分钟` : '关闭'}</strong></div>
          <div><RefreshCw size={17} /><span>测活次数</span><strong>{dashboard.settings.healthAttempts}<em> 次 / 模型</em></strong></div>
        </section>
        <section className="filter-bar">
          <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点、分组或模型" aria-label="搜索站点、分组或模型" />{query && <button type="button" onClick={() => setQuery('')} title="清空搜索" aria-label="清空搜索"><X size={14} /></button>}</label>
          <div className="status-filter" role="group" aria-label="模型状态筛选">
            {([
              ['all', '全部'], ['failed', '失败'], ['available', '可用'], ['excellent', '优质'], ['pending', '待测'],
            ] as Array<[StatusFilter, string]>).map(([value, label]) =>
              <button type="button" key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}>{label}</button>)}
          </div>
          {filtering && <span className="filter-result">显示 {visibleSites.length} / {dashboard.sites.length} 个站点</span>}
        </section>
      </section>
      {activeJobs.length > 0 && <div className="job-strip" title={activeLabel} aria-live="polite"><LoaderCircle size={16} className="spin" /><span><strong>{refreshingJobs.length ? '同步中' : `${runningTargets.length} 个运行中`}</strong>{!refreshingJobs.length && <> · <strong>{queuedTargets.length}</strong> 个排队中</>}{currentTargetLabel && <em>{currentTargetLabel}</em>}{refreshWarning && <em className="job-warning">{refreshWarning}</em>}</span><div className="job-progress"><i style={{ width: `${activeTotal ? activeCompleted / activeTotal * 100 : 0}%` }} /></div><b>{activeCompleted}/{activeTotal}</b></div>}
      {error && <div className="page-error"><CircleAlert size={18} />{error}<button onClick={() => void load()}>重试</button></div>}
      <section className="site-list">
        {visibleSites.map((site) => {
          const index = dashboard.sites.findIndex((item) => item.id === site.id)
          return <div key={site.id} onDragOver={(e) => !recommended && !filtering && e.preventDefault()} onDrop={() => void dropSite(site.id)}><SitePanel site={site} siteIndex={index} siteCount={dashboard.sites.length} recommended={recommended} query={query} statusFilter={statusFilter} onMoveSite={(delta) => void moveSite(index, delta)} onEdit={() => setWizard({ siteId: site.id })} onDelete={() => void remove(site)} onHealth={(scope) => void health(scope)} isHealthActive={isHealthActive} activeTargetFor={activeTargetFor} onChanged={() => void load(true)} onError={setToast} dragging={dragging} setDragging={setDragging} /></div>
        })}
        {!dashboard.sites.length && <div className="empty-state"><div className="empty-symbol"><Activity size={30} /></div><h2>还没有监控站点</h2><p>添加第一个 AI 中转站。</p><button className="button primary" onClick={() => setWizard({})}><Plus size={17} />添加站点</button></div>}
        {dashboard.sites.length > 0 && !visibleSites.length && <div className="empty-state compact"><div className="empty-symbol"><Search size={26} /></div><h2>没有匹配的模型</h2><p>调整搜索词或状态筛选。</p><button className="button ghost" onClick={() => { setQuery(''); setStatusFilter('all') }}>清除筛选</button></div>}
      </section>
    </main>
    {wizard && <SiteWizard
      siteId={wizard.siteId}
      onClose={() => setWizard(null)}
      onSaved={(runHealth, nextDashboard, job, warning) => {
        dashboardEpochRef.current += 1
        if (nextDashboard) setDashboard(nextDashboard)
        else void loadDashboard(true)
        if (job) {
          jobsEpochRef.current += 1
          setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
        }
        setToast(warning ? `配置已保存；${warning}` : runHealth ? '配置已保存，测活任务已启动' : '配置已保存')
      }}
    />}
    {settingsOpen && <SettingsModal current={dashboard.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { setToast('默认配置已保存'); void load() }} />}
    {toast && <div className="toast">{toast}</div>}
  </div>
}
