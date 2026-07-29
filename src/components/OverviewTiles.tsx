import type { ReactNode } from 'react'
import { Activity, Bot, CircleAlert, CircleCheck, Layers3, RefreshCw, Server, Timer } from 'lucide-react'
import type { Dashboard } from '../types'
import type { StatusCounts } from '../lib/health'

function Tile({ icon, label, value, hint, tone, setting }: {
  icon: ReactNode
  label: string
  value: ReactNode
  hint: string
  tone?: 'good' | 'bad'
  setting?: boolean
}) {
  return <article className={`overview-tile ${tone ? `tone-${tone}` : ''} ${setting ? 'is-setting' : ''}`}>
    <header>{icon}{label}</header>
    <strong>{value}</strong>
    <small>{hint}</small>
  </article>
}

export function OverviewTiles({ dashboard, counts, total, checking }: {
  dashboard: Dashboard
  counts: StatusCounts
  total: number
  checking: number
}) {
  const ratio = total ? Math.round(counts.excellent / total * 100) : 0
  return <section className="overview" aria-label="监控概览">
    <Tile icon={<Server size={15} />} label="站点" value={dashboard.summary.sites} hint="接入监控的中转站" />
    <Tile icon={<Layers3 size={15} />} label="分组" value={dashboard.summary.groups} hint="已选择的计费分组" />
    <Tile icon={<Bot size={15} />} label="模型" value={dashboard.summary.models} hint="纳入测活的模型" />
    <Tile
      icon={<CircleCheck size={15} />}
      label="优质模型"
      tone="good"
      value={<>{counts.excellent}<em> / {total}</em></>}
      hint={`占比 ${ratio}%`}
    />
    <Tile
      icon={<CircleAlert size={15} />}
      label="失败模型"
      tone={counts.failed ? 'bad' : undefined}
      value={counts.failed}
      hint={counts.failed ? '最近一轮测活未通过' : '全部模型均有响应'}
    />
    <Tile
      icon={<Activity size={15} />}
      label="待测 / 测活中"
      value={<>{counts.pending}<em>{checking ? ` · ${checking} 进行中` : ''}</em></>}
      hint={checking ? '任务正在执行' : '尚无测活结果'}
    />
    <Tile
      icon={<Timer size={15} />}
      label="自动测活"
      setting
      value={dashboard.settings.autoCheckMinutes ? `${dashboard.settings.autoCheckMinutes} 分钟` : '关闭'}
      hint="后台轮询间隔"
    />
    <Tile
      icon={<RefreshCw size={15} />}
      label="测活次数"
      setting
      value={<>{dashboard.settings.healthAttempts}<em> 次</em></>}
      hint="每个模型每轮请求数"
    />
  </section>
}
