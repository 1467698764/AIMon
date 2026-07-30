import { useMemo, useState } from 'react'
import { Bot, Clock, Copy, MessageSquareText, RefreshCw } from 'lucide-react'
import type { GroupItem, HealthJobTarget } from '../types'
import { fmtTime } from '../lib/format'
import { sortModels, type HealthScope, type SortMode } from '../lib/health'
import { copyText } from '../lib/view'
import { AttemptModal } from './AttemptModal'
import { IconButton, MetricGaugeCells, StatusBadge, SuccessCells } from './primitives'

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
        /* While a round is running the card reports that round, not the previous one: the
           server rewrites the in-flight attempts after every request. */
        const live = checking && model.liveAttempts.length > 0
        const attempts = live ? model.liveAttempts : model.attempts
        const failures = attempts.filter((attempt) => !attempt.ok).length
        const successes = attempts.length - failures
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
          <div className="model-metrics">
            <SuccessCells model={model} activeTarget={activeTarget} />
            <MetricGaugeCells metric="ttfb" label="平均首字" hint="平均首字（TTFB，首个响应字节）" value={model.avgTtfbMs} />
            <MetricGaugeCells metric="ttft" label="平均 TTFT" hint="平均 TTFT（首个非空文本 token）" value={model.avgTtftMs} />
            <MetricGaugeCells metric="total" label="平均耗时" hint="平均耗时（读取完成）" value={model.avgTotalMs} />
          </div>
          <footer className="model-card-footer">
            <span className="model-checked" title={`最近测活 ${fmtTime(model.checkedAt)}`}>
              <Clock size={13} />
              <time dateTime={model.checkedAt || undefined}>{fmtTime(model.checkedAt)}</time>
            </span>
            <div className="model-card-tools">
              {attempts.length > 0 && <button
                type="button"
                /* The tally itself now lives in the metrics grid, so the link only has to be a
                   door; spelling out "N 次失败" again is what pushed this row onto two lines. */
                className={`attempt-link ${live ? 'is-live' : ''}`}
                title={live
                  ? `本轮测活进行中，已完成 ${attempts.length}/${model.liveAttemptCount || activeTarget?.attemptCount || attempts.length} 次 · 查看详情`
                  : `${failures ? `${failures} 次失败` : `${model.successCount ?? successes} 次成功`} · 查看详情`}
                onClick={() => setDetailsModelId(model.id)}
              >详情</button>}
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
            </div>
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
