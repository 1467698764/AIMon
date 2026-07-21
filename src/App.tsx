import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, ArrowLeft, ArrowRight, Bot, Check, ChevronDown, ChevronRight,
  CircleAlert, Gauge, GripVertical, Layers3, LoaderCircle, MoveDown, MoveUp, Pencil, Plus,
  RefreshCw, Server, Settings as SettingsIcon, Sparkles, Trash2, WalletCards, X,
} from 'lucide-react'
import { api } from './api'
import type {
  Dashboard, GroupItem, HealthJob, HealthStatus, ModelItem, PreparedGroup, Settings,
  SiteEditor, SiteItem,
} from './types'

const statusLabels: Record<HealthStatus, string> = {
  excellent: '优质', available: '可用', failed: '失败', pending: '待测',
}

function fmtMs(value: number | null): string {
  if (value == null) return '--'
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
}

function fmtTime(value: string | null): string {
  if (!value) return '尚未测活'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value))
}

function scoreModel(model: ModelItem, standardRatio: number | null): number {
  if (!model.attemptCount || model.status === 'pending') return -1_000_000
  const success = (model.successCount || 0) / model.attemptCount
  const price = standardRatio == null ? 0 : 180 / Math.max(standardRatio, 0.05)
  const latency = (model.avgTtftMs || 10_000) * 0.07 + (model.avgTotalMs || 30_000) * 0.012
  return success * 1200 + Math.min(price, 360) - latency
}

function statusError(model: ModelItem): string {
  return model.attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.error).filter(Boolean).join('\n')
}

function IconButton({ title, children, onClick, tone = 'default', disabled = false }: {
  title: string; children: ReactNode; onClick: () => void; tone?: 'default' | 'danger'; disabled?: boolean
}) {
  return <button type="button" className={`icon-button ${tone}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{children}</button>
}

function StatusBadge({ model }: { model: ModelItem }) {
  const title = statusError(model)
  return (
    <span className={`status status-${model.status}`} title={title || statusLabels[model.status]}>
      {model.status === 'pending' && <LoaderCircle size={13} className="spin" />}
      <span className="status-dot" />{statusLabels[model.status]}
    </span>
  )
}

function Modal({ title, children, onClose, wide = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean
}) {
  const titleId = useId()
  const modalRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previous?.focus() }
  }, [])
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={modalRef} tabIndex={-1} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header"><h2 id={titleId}>{title}</h2><IconButton title="关闭" onClick={onClose}><X size={18} /></IconButton></header>
        {children}
      </section>
    </div>
  )
}

function SettingsModal({ current, onClose, onSaved }: {
  current: Settings; onClose: () => void; onSaved: () => void
}) {
  const [username, setUsername] = useState(current.username)
  const [password, setPassword] = useState('')
  const [clearPassword, setClearPassword] = useState(false)
  const [minutes, setMinutes] = useState(current.autoCheckMinutes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      await api.saveSettings({
        username,
        autoCheckMinutes: minutes,
        ...(clearPassword ? { password: '' } : password ? { password } : {}),
      })
      onSaved(); onClose()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }
  return (
    <Modal title="默认配置" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <label><span>默认登录账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
          <label><span>默认登录密码</span><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder={current.hasPassword ? '已保存，留空不修改' : '尚未设置'} disabled={clearPassword} /></label>
          {current.hasPassword && <label className="check-line"><input type="checkbox" checked={clearPassword} onChange={(e) => setClearPassword(e.target.checked)} />清除已保存密码</label>}
          <label><span>自动测活间隔（分钟）</span><input type="number" min="0" step="1" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        </div>
        <footer className="modal-footer"><button type="button" className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving && <LoaderCircle size={16} className="spin" />}保存</button></footer>
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

function SiteWizard({ siteId, onClose, onSaved }: { siteId?: number; onClose: () => void; onSaved: () => void }) {
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
    finally { setLoading(false) }
  }

  async function prepare() {
    if (!editor || !selectedGroups.size) return
    setLoading(true); setError('')
    try {
      if (!editor.draftId) throw new Error('请先探测站点')
      const result = await api.prepare(editor.draftId, [...selectedGroups])
      setPrepared(result.groups)
      setSelectedModels(new Map(result.groups.map((group) => [group.id, new Set(group.models.filter((model) => model.selected).map((model) => model.id))])))
      setStep(3)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setLoading(false) }
  }

  async function finish() {
    if (!editor) return
    const selections = prepared.map((group) => ({ groupId: group.id, modelIds: [...(selectedModels.get(group.id) || [])] }))
    if (selections.some((item) => !item.modelIds.length)) { setError('每个分组至少选择一个模型'); return }
    setLoading(true); setError('')
    try {
      if (!editor.draftId) throw new Error('配置草稿不存在，请重新探测站点')
      await api.configure(editor.draftId, selections); onSaved(); onClose()
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setLoading(false) }
  }

  function toggleModel(groupId: number, modelId: number) {
    setSelectedModels((current) => {
      const next = new Map(current); const set = new Set(next.get(groupId) || [])
      set.has(modelId) ? set.delete(modelId) : set.add(modelId); next.set(groupId, set); return next
    })
  }

  return (
    <Modal title={siteId ? '编辑站点' : '添加站点'} onClose={() => void cancel()} wide>
      <Steps step={step} manual={mode === 'manual'} />
      {loading && <div className="modal-loading"><LoaderCircle className="spin" size={28} /><span>{step === 1 ? (mode === 'manual' ? '正在验证 API Key 并获取模型' : '正在识别站点并获取账户信息') : step === 2 ? '正在准备分组 Key 与模型' : '正在保存并启动测活'}</span></div>}
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
        <div className="site-found"><span className={`platform ${editor.type}`}>{editor.type === 'newapi' ? 'New API' : 'Sub2API'}</span><div><small>账户余额</small><strong>${editor.balance.toFixed(2)}</strong></div><div><small>充值比例</small><strong>x{editor.rechargeRatio}</strong></div></div>
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
        <footer className="modal-footer"><button className="button ghost" onClick={() => setStep(mode === 'manual' ? 1 : 2)}><ArrowLeft size={16} />返回</button><button className="button primary" onClick={finish}>保存并测活<Check size={16} /></button></footer>
      </>}
    </Modal>
  )
}

function ModelTable({ group, recommended, onHealth }: { group: GroupItem; recommended: boolean; onHealth: (scope: Record<string, number>) => void }) {
  const models = useMemo(() => recommended ? [...group.models].sort((a, b) => scoreModel(b, group.standardRatio) - scoreModel(a, group.standardRatio)) : group.models, [group, recommended])
  return <div className="model-table">
    <div className="model-head"><span>模型</span><span>成功率</span><span>平均首字</span><span>平均耗时</span><span>平均 TTFT</span><span>结果</span><span /></div>
    {models.map((model, index) => <div className="model-row" key={model.id}>
      <div className="model-name"><span className="rank">{recommended ? index + 1 : ''}</span><Bot size={15} /><b title={model.name}>{model.name}</b></div>
      <div data-label="成功率"><strong>{model.successCount == null ? '--' : `${model.successCount}/${model.attemptCount}`}</strong></div>
      <div data-label="平均首字">{fmtMs(model.avgTtfbMs)}</div><div data-label="平均耗时">{fmtMs(model.avgTotalMs)}</div><div data-label="平均 TTFT">{fmtMs(model.avgTtftMs)}</div>
      <div data-label="结果"><StatusBadge model={model} /></div>
      <IconButton title="测活此模型" onClick={() => onHealth({ modelId: model.id })}><RefreshCw size={15} /></IconButton>
    </div>)}
  </div>
}

function SitePanel({ site, recommended, onEdit, onDelete, onHealth, onChanged, onMoveSite, siteIndex, siteCount, dragging, setDragging }: {
  site: SiteItem; recommended: boolean; onEdit: () => void; onDelete: () => void;
  onHealth: (scope: Record<string, number>) => void; onChanged: () => void; onMoveSite: (delta: number) => void; siteIndex: number; siteCount: number;
  dragging: { kind: 'site' | 'group'; id: number } | null; setDragging: (value: { kind: 'site' | 'group'; id: number } | null) => void
}) {
  const [localGroups, setLocalGroups] = useState(site.groups)
  useEffect(() => setLocalGroups(site.groups), [site.groups])
  const groups = recommended ? [...localGroups].sort((a, b) => {
    const bestA = Math.max(...a.models.map((m) => scoreModel(m, a.standardRatio)), -1_000_000)
    const bestB = Math.max(...b.models.map((m) => scoreModel(m, b.standardRatio)), -1_000_000)
    return bestB - bestA
  }) : localGroups
  async function toggleSite() { await api.expanded('site', site.id, !site.expanded); onChanged() }
  async function toggleGroup(group: GroupItem) { await api.expanded('group', group.id, !group.expanded); onChanged() }
  async function dropGroup(targetId: number) {
    if (recommended || dragging?.kind !== 'group' || dragging.id === targetId) return
    const from = localGroups.findIndex((g) => g.id === dragging.id); const to = localGroups.findIndex((g) => g.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...localGroups]; next.splice(to, 0, next.splice(from, 1)[0]); setLocalGroups(next); setDragging(null)
    await api.reorder('group', next.map((g) => g.id)); onChanged()
  }
  async function moveGroup(index: number, delta: number) {
    if (recommended) return
    const target = index + delta
    if (target < 0 || target >= localGroups.length) return
    const next = [...localGroups]
    ;[next[index], next[target]] = [next[target], next[index]]
    setLocalGroups(next)
    await api.reorder('group', next.map((group) => group.id)); onChanged()
  }
  return <article className="site-panel">
    <header className="site-header">
      <button className="drag-handle" title="拖动排序" draggable={!recommended} onDragStart={() => setDragging({ kind: 'site', id: site.id })} disabled={recommended}><GripVertical size={18} /></button>
      <button className="collapse" onClick={toggleSite} title={site.expanded ? '收起站点' : '展开站点'}>{site.expanded ? <ChevronDown size={19} /> : <ChevronRight size={19} />}</button>
      <div className="site-identity"><div className="site-mark">{site.name.slice(0, 1).toUpperCase()}</div><div><h2>{site.name}</h2><a href={site.baseUrl} target="_blank" rel="noreferrer">{site.baseUrl}</a></div></div>
      <span className={`platform ${site.connectionMode === 'manual' ? 'manual' : site.type}`}>{site.connectionMode === 'manual' ? '手动接入' : site.type === 'newapi' ? 'New API' : 'Sub2API'}</span>
      <div className="site-balance"><small>账户余额</small><strong>{site.balanceKnown ? `$${site.balance.toFixed(2)}` : '--'}</strong></div>
      <div className="site-updated"><small>最近测活</small><span>{fmtTime(site.lastCheckAt)}</span></div>
      <div className="site-actions"><span className="mobile-order"><IconButton title="站点上移" disabled={recommended || siteIndex === 0} onClick={() => onMoveSite(-1)}><MoveUp size={15} /></IconButton><IconButton title="站点下移" disabled={recommended || siteIndex === siteCount - 1} onClick={() => onMoveSite(1)}><MoveDown size={15} /></IconButton></span><IconButton title="测活此站点" onClick={() => onHealth({ siteId: site.id })}><RefreshCw size={16} /></IconButton><IconButton title="编辑站点" onClick={onEdit}><Pencil size={16} /></IconButton><IconButton title="删除站点" tone="danger" onClick={onDelete}><Trash2 size={16} /></IconButton></div>
    </header>
    {site.expanded && <div className="groups">
      {groups.map((group, groupIndex) => <section className="group" key={group.id} onDragOver={(e) => !recommended && e.preventDefault()} onDrop={() => dropGroup(group.id)}>
        <header className="group-header">
          <button className="drag-handle" title="拖动排序" draggable={!recommended} onDragStart={(e) => { e.stopPropagation(); setDragging({ kind: 'group', id: group.id }) }} disabled={recommended}><GripVertical size={16} /></button>
          <button className="collapse" onClick={() => toggleGroup(group)} title={group.expanded ? '收起分组' : '展开分组'}>{group.expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>
          <div className="group-title"><h3>{group.name}</h3>{group.platform && <span>{group.platform}</span>}</div>
          <div className="ratio"><small>分组倍率</small><b>{group.ratioDynamic ? '自动' : `x${group.ratio}`}</b></div><div className="ratio standard"><small>标准倍率</small><b>{group.standardRatio == null ? '--' : `x${group.standardRatio.toFixed(3)}`}</b></div>
          <span className="model-count">{group.models.length} 个模型</span>
          <div className="group-actions"><span className="mobile-order"><IconButton title="分组上移" disabled={recommended || groupIndex === 0} onClick={() => void moveGroup(groupIndex, -1)}><MoveUp size={14} /></IconButton><IconButton title="分组下移" disabled={recommended || groupIndex === groups.length - 1} onClick={() => void moveGroup(groupIndex, 1)}><MoveDown size={14} /></IconButton></span><IconButton title="测活此分组" onClick={() => onHealth({ groupId: group.id })}><RefreshCw size={15} /></IconButton></div>
        </header>
        {group.expanded && <ModelTable group={group} recommended={recommended} onHealth={onHealth} />}
      </section>)}
      {!groups.length && <div className="empty-inline">尚未选择分组，编辑站点以完成配置。</div>}
    </div>}
  </article>
}

export function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [jobs, setJobs] = useState<HealthJob[]>([])
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [wizard, setWizard] = useState<{ siteId?: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recommended, setRecommended] = useState(false)
  const [dragging, setDragging] = useState<{ kind: 'site' | 'group'; id: number } | null>(null)

  async function load(silent = false) {
    try {
      const [data, jobData] = await Promise.all([api.dashboard(), api.jobs()])
      setDashboard(data); setJobs(jobData); if (!silent) setError('')
    } catch (err) { if (!silent) setError(err instanceof Error ? err.message : String(err)) }
  }
  useEffect(() => { void load(); const timer = setInterval(() => void load(true), 4000); return () => clearInterval(timer) }, [])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 2800); return () => clearTimeout(timer) }, [toast])

  async function health(scope: Record<string, number> = {}) {
    try { const job = await api.health(scope); setJobs((current) => [job, ...current]); setToast('测活任务已开始'); void load(true) }
    catch (err) { setToast(err instanceof Error ? err.message : String(err)) }
  }
  async function remove(site: SiteItem) {
    if (!window.confirm(`删除站点「${site.name}」及其本地监控数据？远端 API Key 不会删除。`)) return
    try { await api.deleteSite(site.id); setToast('站点已删除'); await load() } catch (err) { setToast(err instanceof Error ? err.message : String(err)) }
  }
  async function dropSite(targetId: number) {
    if (recommended || dragging?.kind !== 'site' || !dashboard || dragging.id === targetId) return
    const from = dashboard.sites.findIndex((s) => s.id === dragging.id); const to = dashboard.sites.findIndex((s) => s.id === targetId)
    if (from < 0 || to < 0) return
    const sites = [...dashboard.sites]; sites.splice(to, 0, sites.splice(from, 1)[0]); setDashboard({ ...dashboard, sites }); setDragging(null)
    await api.reorder('site', sites.map((s) => s.id)); void load(true)
  }
  async function moveSite(index: number, delta: number) {
    if (recommended || !dashboard) return
    const target = index + delta
    if (target < 0 || target >= dashboard.sites.length) return
    const sites = [...dashboard.sites]
    ;[sites[index], sites[target]] = [sites[target], sites[index]]
    setDashboard({ ...dashboard, sites })
    await api.reorder('site', sites.map((site) => site.id)); void load(true)
  }
  const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'queued')
  if (!dashboard) return <div className="app-loading"><div className="logo-mark"><Activity /></div><LoaderCircle className="spin" /><span>{error || '正在载入监控台'}</span></div>

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="logo-mark"><Activity size={21} /></div><div><strong>AIMon</strong><span>CHANNEL OBSERVER</span></div></div>
      <nav><button className="active"><Gauge size={18} /><span>渠道监控</span></button></nav>
      <div className="sidebar-foot"><div className={`pulse-state ${activeJob ? 'busy' : ''}`}><span />{activeJob ? '正在测活' : '监控就绪'}</div><button onClick={() => setSettingsOpen(true)}><SettingsIcon size={18} /><span>默认配置</span></button></div>
    </aside>
    <main>
      <header className="topbar"><div><h1>渠道监控</h1><p>站点、分组与模型运行状态</p></div><div className="toolbar"><button className={`button ${recommended ? 'active' : 'ghost'}`} onClick={() => setRecommended(!recommended)} title="切换智能推荐排序"><Sparkles size={16} />{recommended ? '恢复手动排序' : '智能推荐'}</button><button className="button ghost" onClick={() => void health()}><RefreshCw size={16} />所有模型测活</button><button className="button primary" onClick={() => setWizard({})}><Plus size={17} />添加站点</button></div></header>
      <section className="summary-band">
        <div><span className="summary-icon green"><Server size={18} /></span><p><small>接入站点</small><strong>{dashboard.summary.sites}</strong></p></div>
        <div><span className="summary-icon blue"><Layers3 size={18} /></span><p><small>监控分组</small><strong>{dashboard.summary.groups}</strong></p></div>
        <div><span className="summary-icon amber"><Bot size={18} /></span><p><small>已选模型</small><strong>{dashboard.summary.models}</strong></p></div>
        <div><span className="summary-icon coral"><Activity size={18} /></span><p><small>优质模型</small><strong>{dashboard.summary.excellent}<em> / {dashboard.summary.models}</em></strong></p></div>
        <div><span className="summary-icon gray"><WalletCards size={18} /></span><p><small>自动测活</small><strong>{dashboard.settings.autoCheckMinutes ? `${dashboard.settings.autoCheckMinutes}m` : '关闭'}</strong></p></div>
      </section>
      {activeJob && <div className="job-strip"><LoaderCircle size={16} className="spin" /><span>{activeJob.current || '任务排队中'}</span><div className="job-progress"><i style={{ width: `${activeJob.total ? activeJob.completed / activeJob.total * 100 : 0}%` }} /></div><b>{activeJob.completed}/{activeJob.total}</b></div>}
      {error && <div className="page-error"><CircleAlert size={18} />{error}<button onClick={() => void load()}>重试</button></div>}
      <section className="site-list">
        {dashboard.sites.map((site, index) => <div key={site.id} onDragOver={(e) => !recommended && e.preventDefault()} onDrop={() => void dropSite(site.id)}><SitePanel site={site} siteIndex={index} siteCount={dashboard.sites.length} recommended={recommended} onMoveSite={(delta) => void moveSite(index, delta)} onEdit={() => setWizard({ siteId: site.id })} onDelete={() => void remove(site)} onHealth={(scope) => void health(scope)} onChanged={() => void load(true)} dragging={dragging} setDragging={setDragging} /></div>)}
        {!dashboard.sites.length && <div className="empty-state"><div className="empty-symbol"><Activity size={30} /></div><h2>还没有监控站点</h2><p>添加第一个 AI 中转站。</p><button className="button primary" onClick={() => setWizard({})}><Plus size={17} />添加站点</button></div>}
      </section>
    </main>
    {wizard && <SiteWizard siteId={wizard.siteId} onClose={() => setWizard(null)} onSaved={() => { setToast('配置已保存，测活任务已启动'); void load(true) }} />}
    {settingsOpen && <SettingsModal current={dashboard.settings} onClose={() => setSettingsOpen(false)} onSaved={() => { setToast('默认配置已保存'); void load() }} />}
    {toast && <div className="toast">{toast}</div>}
  </div>
}
