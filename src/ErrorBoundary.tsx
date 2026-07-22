import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Activity, RefreshCw, TriangleAlert } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('AIMon render failed', error, info)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return <main className="fatal-page">
      <section className="fatal-panel">
        <div className="fatal-brand"><span className="logo-mark"><Activity size={20} /></span><strong>AIMon</strong></div>
        <span className="fatal-icon"><TriangleAlert size={27} /></span>
        <h1>页面恢复失败</h1>
        <p>页面遇到了临时渲染错误。重新载入不会删除任何站点或测活数据。</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          <RefreshCw size={16} />重新载入
        </button>
        <details><summary>错误信息</summary><code>{this.state.error.message}</code></details>
      </section>
    </main>
  }
}
