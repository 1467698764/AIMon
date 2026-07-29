import { LoaderCircle, MessageSquareText } from 'lucide-react'
import { ProgressTrack } from './primitives'

export function JobStrip({ label, headline, detail, current, warning, completed, total, customPrompt }: {
  label: string
  headline: string
  detail?: string
  current?: string
  warning?: string
  completed: number
  total: number
  customPrompt?: string
}) {
  return <div className="job-strip" title={label} aria-live="polite">
    <LoaderCircle size={16} className="spin" />
    <div className="job-info">
      <div className="job-headline">
        {headline}
        {customPrompt && <em className="job-custom" title={customPrompt}><MessageSquareText size={12} />自定义问题</em>}
        {detail && <span>{detail}</span>}
      </div>
      {current && <div className="job-current">{current}</div>}
      {warning && <div className="job-current job-warning">{warning}</div>}
    </div>
    <ProgressTrack value={completed} total={total} label="测活任务进度" />
    <b className="job-count">{completed}/{total}</b>
  </div>
}
