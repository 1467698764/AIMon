import { useState } from 'react'
import type { HealthJobTarget, ModelItem } from '../types'
import { fmtMs, fmtTime } from '../lib/format'
import { latencyTone } from '../lib/health'
import { copyText } from '../lib/view'
import { Modal, StatusBadge } from './primitives'

export function AttemptModal({ model, activeTarget, onClose, onCopied }: {
  model: ModelItem
  activeTarget?: HealthJobTarget
  onClose: () => void
  onCopied?: (message: string) => void
}) {
  const successes = model.attempts.filter((attempt) => attempt.ok).length
  const attemptCount = model.attemptCount || model.attempts.length || 3
  const [copying, setCopying] = useState(false)
  const failures = model.attempts.filter((attempt) => !attempt.ok)

  async function copyDiagnostics() {
    if (copying) return
    setCopying(true)
    const report = [
      `模型：${model.name}`,
      `最近测活：${fmtTime(model.checkedAt)}`,
      `成功次数：${successes}/${attemptCount}`,
      ...model.attempts.map((attempt, index) =>
        `第 ${index + 1} 次 · ${attempt.ok ? '成功' : '失败'} · HTTP ${attempt.httpStatus ?? '--'} · 首字 ${fmtMs(attempt.ttfbMs)} · TTFT ${fmtMs(attempt.ttftMs)} · 耗时 ${fmtMs(attempt.totalMs)}${attempt.ok ? '' : `\n  ${attempt.error || '测活失败，未返回错误信息'}`}`),
    ].join('\n')
    const ok = await copyText(report)
    setCopying(false)
    onCopied?.(ok ? '测活详情已复制' : '复制失败，请手动选择文本')
  }

  return <Modal title={`测活详情 · ${model.name}`} onClose={onClose} wide>
    <div className="modal-body attempt-modal-body">
      <div className="attempt-overview">
        <div><span>综合结果</span><StatusBadge model={model} activeTarget={activeTarget} /></div>
        <div><span>{activeTarget ? '当前进度' : '成功次数'}</span><strong>{activeTarget ? `第 ${activeTarget.attempt || 1}/${activeTarget.attemptCount} 次` : `${successes}/${attemptCount}`}</strong></div>
        <div><span>失败次数</span><strong>{failures.length}</strong></div>
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
            <span>首字 <b className={`tone-${latencyTone('ttfb', attempt.ttfbMs)}`}>{fmtMs(attempt.ttfbMs)}</b></span>
            <span>TTFT <b className={`tone-${latencyTone('ttft', attempt.ttftMs)}`}>{fmtMs(attempt.ttftMs)}</b></span>
            <span>耗时 <b className={`tone-${latencyTone('total', attempt.totalMs)}`}>{fmtMs(attempt.totalMs)}</b></span>
          </div>
          {!attempt.ok && <p>{attempt.error || '测活失败，未返回错误信息'}</p>}
        </article>)}
        {!model.attempts.length && <div className="empty-inline">尚无测活尝试记录</div>}
      </div>
    </div>
    <footer className="modal-footer">
      {model.attempts.length > 0 && <button type="button" className="button ghost" disabled={copying} onClick={() => void copyDiagnostics()}>复制诊断信息</button>}
      <button type="button" className="button primary" onClick={onClose}>关闭</button>
    </footer>
  </Modal>
}
