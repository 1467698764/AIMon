import { useState } from 'react'
import { LoaderCircle, MessageSquareText } from 'lucide-react'
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
  /* A round in flight reports itself: the server rewrites the pending row's attempts after
     every request, so the list grows one entry at a time instead of appearing all at once
     when the last request returns. */
  const inFlight = Boolean(activeTarget)
  const live = inFlight && model.liveAttempts.length > 0
  const attempts = live ? model.liveAttempts : model.attempts
  const successes = attempts.filter((attempt) => attempt.ok).length
  const attemptCount = live
    ? model.liveAttemptCount || activeTarget?.attemptCount || attempts.length
    : model.attemptCount || model.attempts.length || 3
  const [copying, setCopying] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(false)
  const failures = attempts.filter((attempt) => !attempt.ok)
  const question = (inFlight && model.liveCustomPrompt ? model.liveCustomPrompt : model.customPrompt).trim()

  async function copyDiagnostics() {
    if (copying) return
    setCopying(true)
    const report = [
      `模型：${model.name}`,
      `最近测活：${fmtTime(model.checkedAt)}`,
      `成功次数：${successes}/${attemptCount}`,
      ...(question ? [`自定义问题：\n${question}`] : []),
      ...attempts.map((attempt, index) => {
        const head = `第 ${index + 1} 次 · ${attempt.ok ? '成功' : '失败'} · HTTP ${attempt.httpStatus ?? '--'} · 首字 ${fmtMs(attempt.ttfbMs)} · TTFT ${fmtMs(attempt.ttftMs)} · 耗时 ${fmtMs(attempt.totalMs)}`
        if (!attempt.ok) return `${head}\n  ${attempt.error || '测活失败，未返回错误信息'}`
        return attempt.reply ? `${head}\n  回复：${attempt.reply}` : head
      }),
    ].join('\n')
    const ok = await copyText(report)
    setCopying(false)
    onCopied?.(ok ? '测活详情已复制' : '复制失败，请手动选择文本')
  }

  return <Modal title={`测活详情 · ${model.name}`} onClose={onClose} wide>
    <div className="modal-body attempt-modal-body">
      <div className="attempt-overview">
        <div><span>综合结果</span><StatusBadge model={model} activeTarget={activeTarget} /></div>
        <div><span>{inFlight ? '当前进度' : '成功次数'}</span><strong>{inFlight ? `第 ${Math.max(attempts.length, activeTarget?.attempt || 1)}/${attemptCount} 次` : `${successes}/${attemptCount}`}</strong></div>
        <div><span>失败次数</span><strong>{failures.length}</strong></div>
        <div><span>最近测活</span><strong>{fmtTime(model.checkedAt)}</strong></div>
      </div>
      {question && <section className={`attempt-question ${questionOpen ? 'open' : ''}`}>
        <header>
          <MessageSquareText size={15} />
          <div><small>本次使用的自定义问题</small><strong>{question.replace(/\s+/g, ' ')}</strong></div>
          <button type="button" className="text-button" onClick={() => setQuestionOpen((open) => !open)}>
            {questionOpen ? '收起' : '查看全文'}
          </button>
        </header>
        {questionOpen && <pre>{question}</pre>}
      </section>}
      <div className="attempt-list">
        {inFlight && <p className="attempt-live-note">
          <LoaderCircle size={14} className={activeTarget?.status === 'running' ? 'spin' : ''} />
          {activeTarget?.status === 'queued'
            ? '此模型正在排队，开始后每次请求的结果都会立刻出现在下方。'
            : `本轮测活进行中，已完成 ${attempts.length}/${attemptCount} 次，结果逐次刷新。`}
        </p>}
        {attempts.map((attempt, index) => <article className={`attempt-item ${attempt.ok ? 'ok' : 'failed'}`} key={index}>
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
          {attempt.ok && attempt.reply && <div className="attempt-reply">
            <small>模型回复</small>
            <pre>{attempt.reply}</pre>
          </div>}
        </article>)}
        {!attempts.length && <div className="empty-inline">{inFlight ? '正在等待第 1 次请求返回…' : '尚无测活尝试记录'}</div>}
      </div>
    </div>
    <footer className="modal-footer">
      {attempts.length > 0 && <button type="button" className="button" disabled={copying} onClick={() => void copyDiagnostics()}>复制诊断信息</button>}
      <button type="button" className="button primary" onClick={onClose}>关闭</button>
    </footer>
  </Modal>
}
