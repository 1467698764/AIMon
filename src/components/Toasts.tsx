import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'

export type ToastTone = 'info' | 'success' | 'error'
export type Toast = { id: number; message: string; tone: ToastTone; count: number; expiresAt: number }

const MAX_TOASTS = 3

function lifetime(message: string): number {
  return Math.min(10_000, Math.max(2_800, message.length * 80))
}

/** Stacked notices that collapse repeats instead of replacing the previous message. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const sequenceRef = useRef(0)

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    if (!message) return
    setToasts((current) => {
      const expiresAt = Date.now() + lifetime(message)
      const existing = current.find((toast) => toast.message === message && toast.tone === tone)
      if (existing) {
        return current.map((toast) => toast === existing
          ? { ...toast, count: toast.count + 1, expiresAt }
          : toast)
      }
      sequenceRef.current += 1
      return [...current, { id: sequenceRef.current, message, tone, count: 1, expiresAt }].slice(-MAX_TOASTS)
    })
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  useEffect(() => {
    if (!toasts.length) return
    const next = Math.max(120, Math.min(...toasts.map((toast) => toast.expiresAt)) - Date.now())
    const timer = setTimeout(() => {
      const now = Date.now()
      setToasts((current) => current.filter((toast) => toast.expiresAt > now))
    }, next)
    return () => clearTimeout(timer)
  }, [toasts])

  return { toasts, push, dismiss }
}

const icons = { info: Info, success: CircleCheck, error: CircleAlert } as const

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null
  return <div className="toast-stack" role="status" aria-live="polite">
    {toasts.map((toast) => {
      const Icon = icons[toast.tone]
      return <div className={`toast toast-${toast.tone}`} key={toast.id}>
        <Icon size={16} />
        <p>{toast.message}</p>
        {toast.count > 1 && <span className="toast-count">×{toast.count}</span>}
        <button type="button" onClick={() => onDismiss(toast.id)} title="关闭提示" aria-label="关闭提示"><X size={14} /></button>
      </div>
    })}
  </div>
}
