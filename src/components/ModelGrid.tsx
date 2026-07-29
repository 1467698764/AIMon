import { useMemo, useState } from 'react'
import { Bot, Clock, Copy, MessageSquareText, RefreshCw } from 'lucide-react'
import type { GroupItem, HealthJobTarget } from '../types'
import { fmtTime } from '../lib/format'
import { sortModels, type HealthScope, type SortMode } from '../lib/health'
import { copyText } from '../lib/view'
import { AttemptModal } from './AttemptModal'
import { IconButton, MetricGaugeCells, StatusBadge, SuccessReadout } from './primitives'

export function ModelGrid({ group, sortMode, onHealth, onCustomHealth, activeTargetFor, onNotice }: {
  group: GroupItem
  sortMode: SortMode
  onHealth: (scope: HealthScope) => void
  onCustomHealth: (scope: HealthScope, modelName: string) => void
  activeTargetFor: (modelId: number) => HealthJobTarget | undefined
  onNotice: (message: string) => void
}) {
  const models = useMemo(() => sortModels(group.models, sortMode, group.standardRatio), [group, sortMode])
  const [detailsModelId, setDetailsModelId] = useState<number | null>(null)
  const detailsModel = detailsModelId == null ? null : models.find((model) => model.id === detailsModelId) || null
  const ranked = sortMode !== 'manual' && sortMode !== 'name'

  async function copyName(name: string) {
    onNotice(await copyText(name) ? `已复制模型名称 ${name}` : '复制失败，请手动选择文本')
  }

  return <>
    <div className="model-grid">
      {models.map((model, index) => {
        const activeTarget = activeTargetFor(model.id)
        const checking = Boolean(activeTarget)
        const failures = model.attempts.filter((attempt) => !attempt.ok).length
        const cardStatus = activeTarget ? 'pending' : model.status
        return <article
          className={`model-card model-card-${cardStatus} ${activeTarget?.status === 'running' ? 'checking' : activeTarget?.status === 'queued' ? 'queued' : ''}`}
          key={model.id}
        >
          <header className="model-card-header">
            <div className="model-card-title">
              {ranked && <span className="model-rank">{index + 1}</span>}
              <span className="model-icon"><Bot size={15} /></span>
              <h4 title={model.name}>{model.name}</h4>
            </div>
            <StatusBadge model={model} activeTarget={activeTarget} />
          </header>
          <SuccessReadout model={model} activeTarget={activeTarget} />
          <div className="model-metrics">
            <MetricGaugeCells metric="ttfb" label="平均首字" hint="平均首字（TTFB，首个响应字节）" value={model.avgTtfbMs} />
            <MetricGaugeCells metric="ttft" label="平均 TTFT" hint="平均 TTFT（首个非空文本 token）" value={model.avgTtftMs} />
            <MetricGaugeCells metric="total" label="平均耗时" hint="平均耗时（读取完成）" value={model.avgTotalMs} />
          </div>
          <footer className="model-card-footer">
            <span className="model-checked" title={`最近测活 ${fmtTime(model.checkedAt)}`}>
              <Clock size={13} />
              <time dateTime={model.checkedAt || undefined}>{fmtTime(model.checkedAt)}</time>
            </span>
            {model.attempts.length > 0 && <button type="button" className={`attempt-link ${failures ? 'has-failures' : ''}`} onClick={() => setDetailsModelId(model.id)}>
              {failures ? `${failures} 次失败` : `${model.successCount ?? model.attempts.length} 次成功`} · 详情
            </button>}
            <IconButton title="复制模型名称" onClick={() => void copyName(model.name)}><Copy size={14} /></IconButton>
            <IconButton
              title="用自定义问题测活此模型"
              disabled={checking}
              onClick={() => onCustomHealth({ modelId: model.id }, model.name)}
            ><MessageSquareText size={14} /></IconButton>
            <IconButton
              title={activeTarget?.status === 'running' ? '此模型正在测活' : activeTarget?.status === 'queued' ? '此模型等待测活' : '测活此模型'}
              disabled={checking}
              onClick={() => onHealth({ modelId: model.id })}
            ><RefreshCw className={activeTarget?.status === 'running' ? 'spin' : ''} size={15} /></IconButton>
          </footer>
        </article>
      })}
    </div>
    {detailsModel && <AttemptModal
      model={detailsModel}
      activeTarget={activeTargetFor(detailsModel.id)}
      onClose={() => setDetailsModelId(null)}
      onCopied={onNotice}
    />}
  </>
}
