import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Activity, CircleAlert, LoaderCircle, X } from 'lucide-react'
import type { HealthAttempt, HealthJobTarget, ModelItem } from '../types'
import { fmtMs } from '../lib/format'
import {
  latencyFill, latencyTick, latencyTone, noActiveModelIds, statusCounts, statusError, statusLabels,
  type LatencyMetric,
} from '../lib/health'

export function IconButton({ title, children, onClick, tone = 'default', disabled = false, pressed, className = '' }: {
  title: string
  children: ReactNode
  onClick: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
  pressed?: boolean
  className?: string
}) {
  return <button
    type="button"
    className={`icon-button ${tone} ${pressed ? 'active' : ''} ${className}`}
    title={title}
    aria-label={title}
    aria-pressed={pressed}
    onClick={onClick}
    disabled={disabled}
  >{children}</button>
}

export function LoadingScreen({ message, error, onRetry }: { message: string; error?: string; onRetry?: () => void }) {
  return <div className="app-loading">
    <div className="logo-mark"><Activity /></div>
    {error ? <CircleAlert className="loading-error-icon" /> : <LoaderCircle className="spin" />}
    <span>{error || message}</span>
    {!error && <div className="skeleton-shell" aria-hidden="true">
      <div className="skeleton" /><div className="skeleton" /><div className="skeleton" />
    </div>}
    {error && onRetry && <button type="button" className="button primary" onClick={onRetry}>重试</button>}
  </div>
}

export function HealthBreakdown({ models, activeModelIds = noActiveModelIds }: {
  models: ModelItem[]
  activeModelIds?: ReadonlySet<number>
}) {
  const counts = statusCounts(models, activeModelIds)
  const label = `优质 ${counts.excellent}，可用 ${counts.available}，失败 ${counts.failed}，待测 ${counts.pending}`
  return <div className="health-breakdown" aria-label={label} title={label}>
    {counts.excellent > 0 && <span className="excellent"><i />{counts.excellent}</span>}
    {counts.available > 0 && <span className="available"><i />{counts.available}</span>}
    {counts.failed > 0 && <span className="failed"><i />{counts.failed}</span>}
    {counts.pending > 0 && <span className="pending"><i />{counts.pending}</span>}
  </div>
}

/** One column of the card's metric row: label, reading, then the gauge under both. */
export function MetricStat({ metric, label, hint, value }: {
  metric: LatencyMetric
  label: string
  hint: string
  value: number | null
}) {
  const tone = latencyTone(metric, value)
  const fill = latencyFill(metric, value)
  const readout = fmtMs(value)
  return <div className="metric-stat" title={`${hint}：${readout}`}>
    <span className="metric-label">{label}</span>
    <span className={`metric-value tone-${tone}`}>{readout}</span>
    <span className={`metric-gauge tone-${tone} ${fill == null ? 'empty' : ''}`} aria-hidden="true">
      {fill != null && <>
        <span className="gauge-fill" style={{ width: `${fill * 100}%` }} />
        <span className="gauge-tick" style={{ left: `${latencyTick(metric) * 100}%` }} />
      </>}
    </span>
  </div>
}

export function AttemptDots({ attempts }: { attempts: HealthAttempt[] }) {
  if (!attempts.length) return null
  return <span className="attempt-dots" aria-hidden="true">
    {attempts.map((attempt, index) => <i key={index} className={attempt.ok ? 'ok' : 'bad'} />)}
  </span>
}

/**
 * The verdict, optionally with the round's tally beside it. The tally is opt-in because the
 * details modal prints 成功次数 and 失败次数 as fields of their own two lines below.
 */
export function StatusBadge({ model, activeTarget, score = false }: {
  model: ModelItem
  activeTarget?: HealthJobTarget
  score?: boolean
}) {
  const title = statusError(model)
  const running = activeTarget?.status === 'running'
  const label = running ? '测活中' : activeTarget?.status === 'queued' ? '排队中' : statusLabels[model.status]
  const active = Boolean(activeTarget)
  /* A live round counts up as its requests land; a finished one shows what it scored. */
  const done = Math.max(model.liveAttempts.length, activeTarget?.attempt || 1)
  const tally = running
    ? `${done}/${model.liveAttemptCount || activeTarget.attemptCount}`
    : activeTarget || model.successCount == null || model.attemptCount == null
      ? null
      : `${model.successCount}/${model.attemptCount}`
  return <span className={`status status-${active ? 'pending' : model.status}`} title={title || label}>
    {active && <LoaderCircle size={13} className={running ? 'spin' : ''} />}
    <span className="status-dot" />{label}
    {score && tally && <b>{tally}</b>}
  </span>
}

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/** Traps focus, locks scrolling and restores the previous focus target on unmount. */
export function useModalShell<T extends HTMLElement = HTMLElement>(onClose: () => void, closeDisabled: boolean) {
  const containerRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    // Clipping the body re-anchors the viewport on whatever still holds focus, so an overlay
    // opened from a control that had scrolled out of view used to yank the page up to it.
    // Pin the offset across the lock, and never let a focus() call move the viewport.
    const pin = () => {
      const { scrollX, scrollY } = window
      return () => { if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY) }
    }
    let unpin = pin()
    document.body.style.overflow = 'hidden'
    containerRef.current?.focus({ preventScroll: true })
    unpin()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !closeDisabled) closeRef.current()
      if (event.key !== 'Tab' || !containerRef.current) return
      const focusable = [...containerRef.current.querySelectorAll<HTMLElement>(focusableSelector)]
      if (!focusable.length) {
        event.preventDefault()
        containerRef.current.focus()
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
      unpin = pin()
      document.body.style.overflow = previousOverflow
      previous?.focus({ preventScroll: true })
      unpin()
    }
  }, [closeDisabled])
  return containerRef
}

export function Modal({ title, children, onClose, wide = false, closeDisabled = false }: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  closeDisabled?: boolean
}) {
  const titleId = useId()
  const modalRef = useModalShell(onClose, closeDisabled)
  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !closeDisabled && onClose()}
    >
      <section ref={modalRef} tabIndex={-1} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <h2 id={titleId} title={title}>{title}</h2>
          <IconButton title={closeDisabled ? '操作完成后可关闭' : '关闭'} className="quiet" disabled={closeDisabled} onClick={onClose}><X size={18} /></IconButton>
        </header>
        {children}
      </section>
    </div>, document.body,
  )
}

export function ProgressTrack({ value, total, label }: { value: number; total: number; label: string }) {
  return <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}>
    <i style={{ width: `${total ? Math.min(100, value / total * 100) : 0}%` }} />
  </div>
}
