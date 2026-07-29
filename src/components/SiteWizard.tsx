import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import type { Dashboard, HealthJob, PreparedGroup, SiteEditor } from '../types'
import { errorMessage, fmtCurrency } from '../lib/format'
import { comparableBaseUrl, createManualGroupClientId } from '../lib/view'
import { IconButton, Modal } from './primitives'

type ManualGroupForm = { clientId: string; id?: number; name: string; ratio: number; apiKey: string; hasKey: boolean }

function emptyManualGroup(): ManualGroupForm {
  return { clientId: createManualGroupClientId(), name: '', ratio: 1, apiKey: '', hasKey: false }
}

function Steps({ step, manual }: { step: number; manual: boolean }) {
  const labels = manual ? ['站点与分组', '选择模型'] : ['站点信息', '选择分组', '选择模型']
  const visibleStep = manual && step === 3 ? 2 : step
  return <div className="steps" aria-label="配置步骤" style={{ gridTemplateColumns: `repeat(${labels.length}, 1fr)` }}>
    {labels.map((label, index) => <div
      className={`step ${visibleStep >= index + 1 ? 'active' : ''}`}
      aria-current={visibleStep === index + 1 ? 'step' : undefined}
      key={label}
    ><span>{visibleStep > index + 1 ? <Check size={13} /> : index + 1}</span>{label}</div>)}
  </div>
}

export function SiteWizard({ siteId, onClose, onSaved }: {
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
  const [saving, setSaving] = useState(false)
  const [loadingSeconds, setLoadingSeconds] = useState(0)
  const operationRef = useRef(false)
  const operationAbortRef = useRef<AbortController | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const focusedStepRef = useRef(step)
  useEffect(() => {
    if (!loading) {
      setLoadingSeconds(0)
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [loading])

  useEffect(() => {
    // Announce a newly reached wizard stage without stealing focus when an
    // operation merely finishes (including validation and network failures).
    if (!loading && focusedStepRef.current !== step) {
      focusedStepRef.current = step
      stageRef.current?.focus()
    }
  }, [step, loading])

  function cancel() {
    operationAbortRef.current?.abort()
    operationAbortRef.current = null
    operationRef.current = false
    const draftId = editor?.draftId
    onClose()
    if (draftId) void api.discardDraft(draftId).catch(() => undefined)
  }

  useEffect(() => {
    if (!siteId) return
    const controller = new AbortController()
    operationAbortRef.current = controller
    api.site(siteId, controller.signal).then((site) => {
      setEditor(site)
      setMode(site.connectionMode)
      setForm({ name: site.name, baseUrl: site.baseUrl, username: site.username, password: '', rechargeRatio: site.rechargeRatio, useDefault: !site.username && !site.hasPassword })
      setSelectedGroups(new Set(site.groups.filter((group) => group.selected).map((group) => group.id)))
      if (site.connectionMode === 'manual') {
        setManualGroups(site.groups.map((group) => ({
          clientId: createManualGroupClientId(), id: group.id, name: group.name, ratio: group.ratio, apiKey: '', hasKey: group.hasKey,
        })))
      }
    }).catch((err) => { if (!controller.signal.aborted) setError(errorMessage(err)) }).finally(() => {
      if (operationAbortRef.current === controller) operationAbortRef.current = null
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [siteId])
  async function discover(event: FormEvent) {
    if (operationRef.current) return
    operationRef.current = true
    const controller = new AbortController()
    operationAbortRef.current = controller
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
        }, controller.signal)
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
        useDefaultCredentials: form.useDefault,
        ...(form.useDefault ? { username: '', password: '' } : { username: form.username, ...(form.password ? { password: form.password } : {}) }),
      }, controller.signal)
      setEditor(site)
      setSelectedGroups(new Set(site.groups.filter((group) => group.selected && group.available).map((group) => group.id)))
      setStep(2)
    } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)) }
    finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null
      operationRef.current = false
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  async function prepare() {
    if (!editor || !selectedGroups.size || operationRef.current) return
    operationRef.current = true
    const controller = new AbortController()
    operationAbortRef.current = controller
    setLoading(true); setError('')
    try {
      if (!editor.draftId) throw new Error('请先探测站点')
      const result = await api.prepare(editor.draftId, [...selectedGroups], controller.signal)
      setPrepared(result.groups)
      setSelectedModels(new Map(result.groups.map((group) => [group.id, new Set(group.models.filter((model) => model.selected).map((model) => model.id))])))
      setStep(3)
    } catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)) }
    finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null
      operationRef.current = false
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  async function finish(runHealth: boolean) {
    if (!editor || operationRef.current) return
    const selections = prepared.map((group) => ({ groupId: group.id, modelIds: [...(selectedModels.get(group.id) || [])] }))
    if (selections.some((item) => !item.modelIds.length)) { setError('每个分组至少选择一个模型'); return }
    operationRef.current = true
    const controller = new AbortController()
    operationAbortRef.current = controller
    setSaving(true)
    setSavingWithHealth(runHealth); setLoading(true); setError('')
    try {
      if (!editor.draftId) throw new Error('配置草稿不存在，请重新探测站点')
      const result = await api.configure(editor.draftId, selections, runHealth, controller.signal)
      onSaved(runHealth, result.dashboard, result.job, result.healthStartError || result.refreshError)
      onClose()
    }
    catch (err) { if (!controller.signal.aborted) setError(errorMessage(err)) }
    finally {
      if (operationAbortRef.current === controller) operationAbortRef.current = null
      operationRef.current = false
      setSaving(false)
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  function toggleModel(groupId: number, modelId: number) {
    setSelectedModels((current) => {
      const next = new Map(current); const set = new Set(next.get(groupId) || [])
      set.has(modelId) ? set.delete(modelId) : set.add(modelId); next.set(groupId, set); return next
    })
  }

  const baseUrlChanged = Boolean(siteId && editor
    && comparableBaseUrl(form.baseUrl) !== comparableBaseUrl(editor.baseUrl))
  const loadingLabel = step === 1
    ? (mode === 'manual' ? '正在验证 API Key 并获取模型' : '正在识别站点并获取账户信息')
    : step === 2 ? '正在准备分组 Key 与模型'
    : savingWithHealth ? '正在保存并启动测活' : '正在保存配置'

  return <Modal title={siteId ? '编辑站点' : '添加站点'} onClose={cancel} wide closeDisabled={saving}>
    <Steps step={step} manual={mode === 'manual'} />
    {loading && <div ref={stageRef} tabIndex={-1} className="modal-loading" role="status" aria-live="polite" aria-atomic="true">
      <LoaderCircle className="spin" size={28} />
      <span>{loadingLabel}</span>
      {loadingSeconds >= 2 && <small>已等待 {loadingSeconds} 秒，复杂站点或 Cloudflare 验证可能需要更久</small>}
      {!saving && <button type="button" className="button ghost" onClick={cancel}>取消当前操作</button>}
    </div>}
    {!loading && step === 1 && <form onSubmit={discover}>
      <div ref={stageRef} tabIndex={-1} className="modal-body form-grid two-cols">
        <div className="mode-switch full" role="group" aria-label="接入方式">
          <button type="button" aria-pressed={mode === 'auto'} className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>自动登录</button>
          <button type="button" aria-pressed={mode === 'manual'} className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>手动 API Key</button>
        </div>
        <label><span>站点名称</span><input required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：主力渠道" /></label>
        <label><span>Base URL（/v1 可省略）</span><input required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com" /></label>
        <label><span>充值比例</span><div className="input-prefix"><b>x</b><input required type="number" min="0.000001" step="any" value={form.rechargeRatio} onChange={(e) => setForm({ ...form, rechargeRatio: Number(e.target.value) })} /></div></label>
        {mode === 'auto' && <>
          <label className="check-line full"><input type="checkbox" checked={form.useDefault} onChange={(e) => setForm({ ...form, useDefault: e.target.checked })} />使用默认登录凭据</label>
          <label><span>登录账号</span><input required={!form.useDefault} value={form.username} disabled={form.useDefault} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="username" /></label>
          <label><span>登录密码</span><input required={!form.useDefault && (!editor?.hasPassword || baseUrlChanged)} value={form.password} disabled={form.useDefault} onChange={(e) => setForm({ ...form, password: e.target.value })} type="password" autoComplete="new-password" placeholder={baseUrlChanged ? 'Base URL 已变化，请重新填写' : editor?.hasPassword ? '已保存，留空不修改' : ''} /></label>
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
        {error && <div className="form-error full" role="alert"><CircleAlert size={16} />{error}</div>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="button ghost" onClick={cancel}>取消</button>
        <button className="button primary">{mode === 'manual' ? '获取模型' : '探测站点'}<ArrowRight size={16} /></button>
      </footer>
    </form>}
    {!loading && step === 2 && mode === 'auto' && editor && <>
      <div ref={stageRef} tabIndex={-1} className="site-found">
        <span className={`platform ${editor.type}`}>{editor.type === 'newapi' ? 'New API' : 'Sub2API'}</span>
        <div><small>账户余额</small><strong>{fmtCurrency(editor.balance, editor.currency)}</strong></div>
        <div><small>充值比例</small><strong>x{editor.rechargeRatio}</strong></div>
      </div>
      <div className="modal-body selection-list">
        {editor.groups.filter((group) => group.available).map((group) => <label className={`selection-row ${selectedGroups.has(group.id) ? 'selected' : ''}`} key={group.id}>
          <input type="checkbox" checked={selectedGroups.has(group.id)} onChange={() => setSelectedGroups((current) => { const next = new Set(current); next.has(group.id) ? next.delete(group.id) : next.add(group.id); return next })} />
          <span><b>{group.name}</b><small>{group.platform || '通用分组'}</small></span>
          <strong>{group.ratioDynamic ? '自动' : `x${group.ratio}`}</strong>
          {group.hasKey && <em>已复用 Key</em>}
        </label>)}
        {!editor.groups.some((group) => group.available) && <div className="empty-inline">没有可选分组</div>}
        {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
      </div>
      <footer className="modal-footer">
        <button className="button ghost" onClick={() => setStep(1)}><ArrowLeft size={16} />返回</button>
        <button className="button primary" onClick={prepare} disabled={!selectedGroups.size}>确认分组<ArrowRight size={16} /></button>
      </footer>
    </>}
    {!loading && step === 3 && <>
      <div ref={stageRef} tabIndex={-1} className="modal-body model-selector">
        {prepared.map((group) => <section className="model-select-group" key={group.id}>
          <header>
            <div><h3>{group.name}</h3><span>{group.standardRatio == null ? '动态倍率 · 不参与价格推荐' : `x${group.ratio} · 标准 x${group.standardRatio.toFixed(3)}`}</span></div>
            <button className="text-button" onClick={() => setSelectedModels((current) => { const next = new Map(current); const all = group.models.map((m) => m.id); next.set(group.id, (next.get(group.id)?.size || 0) === all.length ? new Set() : new Set(all)); return next })}>全选 / 取消</button>
          </header>
          <div className="model-check-grid">{group.models.map((model) => {
            const selected = selectedModels.get(group.id)?.has(model.id) || false
            return <label className={selected ? 'selected' : ''} key={model.id}><input type="checkbox" checked={selected} onChange={() => toggleModel(group.id, model.id)} /><span title={model.name}>{model.name}</span></label>
          })}</div>
        </section>)}
        {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
      </div>
      <footer className="modal-footer">
        <button className="button ghost" onClick={() => setStep(mode === 'manual' ? 1 : 2)}><ArrowLeft size={16} />返回</button>
        <button className="button ghost" onClick={() => void finish(false)}>保存</button>
        <button className="button primary" onClick={() => void finish(true)}>保存并测活<Check size={16} /></button>
      </footer>
    </>}
  </Modal>
}
