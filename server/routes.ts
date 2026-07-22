import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import {
  configureSite,
  deleteSite,
  discardDraft,
  discoverSite,
  getDashboard,
  getSettings,
  getSiteEditor,
  prepareManualSite,
  prepareGroups,
  reorder,
  saveSettings,
  updateExpanded,
  updateExpandedBulk,
} from './site-service.js'
import { hasActiveHealthForSite, listJobs, startHealthCheck } from './health.js'
import { redactSensitiveText, sensitiveValues } from './privacy.js'

const router = Router()

const asyncHandler = (handler: (...args: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { void handler(req, res, next).catch(next) }

router.get('/dashboard', (_req, res) => res.json(getDashboard()))
router.get('/settings', (_req, res) => res.json(getSettings()))
router.put('/settings', (req, res) => {
  const input = z.object({
    username: z.string().optional(),
    password: z.string().optional(),
    autoCheckMinutes: z.number().int().min(0).max(525_600).optional(),
    healthAttempts: z.number().int().min(1).max(10).optional(),
  }).parse(req.body)
  res.json(saveSettings(input))
})

router.get('/sites/:id', (req, res) => res.json(getSiteEditor(Number(req.params.id))))
router.post('/sites/discover', asyncHandler(async (req, res) => {
  const input = z.object({
    id: z.number().int().positive().optional(),
    draftId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().min(1).max(500),
    username: z.string().max(200).optional(),
    password: z.string().max(500).optional(),
    useDefaultCredentials: z.boolean().optional(),
    rechargeRatio: z.number().positive().max(1_000_000).optional(),
  }).parse(req.body)
  res.json(await discoverSite(input))
}))
router.post('/sites/manual', asyncHandler(async (req, res) => {
  const input = z.object({
    id: z.number().int().positive().optional(),
    draftId: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().min(1).max(500),
    rechargeRatio: z.number().positive().max(1_000_000).optional(),
    groups: z.array(z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1).max(120),
      ratio: z.number().positive().max(1_000_000),
      apiKey: z.string().max(4_000).optional(),
    })).min(1).max(100),
  }).parse(req.body)
  res.json(await prepareManualSite(input))
}))
router.post('/drafts/:id/prepare', asyncHandler(async (req, res) => {
  const input = z.object({ groupIds: z.array(z.number().int().positive()).min(1) }).parse(req.body)
  res.json(await prepareGroups(Number(req.params.id), input.groupIds))
}))
router.post('/drafts/:id/configure', (req, res) => {
  const input = z.object({
    runHealth: z.boolean().optional().default(true),
    selections: z.array(z.object({
      groupId: z.number().int().positive(),
      modelIds: z.array(z.number().int().positive()).min(1),
    })).min(1),
  }).parse(req.body)
  const siteId = configureSite(Number(req.params.id), input.selections)
  const secrets = sensitiveValues(req.body)
  let job
  let healthStartError
  if (input.runHealth) {
    try {
      job = startHealthCheck({ siteId })
    } catch (error) {
      healthStartError = redactSensitiveText(error, secrets)
    }
  }
  let dashboard
  let refreshError
  try {
    dashboard = getDashboard()
  } catch (error) {
    refreshError = redactSensitiveText(error, secrets)
  }
  res.json({
    ok: true,
    siteId,
    ...(dashboard ? { dashboard } : {}),
    ...(job ? { job } : {}),
    ...(healthStartError ? { healthStartError } : {}),
    ...(refreshError ? { refreshError } : {}),
  })
})
router.delete('/drafts/:id', (req, res) => {
  discardDraft(Number(req.params.id))
  res.status(204).end()
})
router.delete('/sites/:id', (req, res) => {
  const siteId = Number(req.params.id)
  if (hasActiveHealthForSite(siteId)) {
    res.status(409).json({ error: '该站点正在测活，请等待任务完成后再删除' })
    return
  }
  deleteSite(siteId)
  res.status(204).end()
})
router.patch('/sites/expanded/bulk', (req, res) => {
  const input = z.object({
    siteIds: z.array(z.number().int().positive()).min(1).max(1_000),
    expanded: z.boolean(),
  }).parse(req.body)
  res.json({ ok: true, ...updateExpandedBulk(input.siteIds, input.expanded) })
})
router.patch('/sites/:kind/:id/expanded', (req, res) => {
  const kind = z.enum(['site', 'group']).parse(req.params.kind)
  const { expanded } = z.object({ expanded: z.boolean() }).parse(req.body)
  updateExpanded(kind, Number(req.params.id), expanded)
  res.json({ ok: true })
})
router.put('/order/:kind', (req, res) => {
  const kind = z.enum(['site', 'group']).parse(req.params.kind)
  const { ids } = z.object({ ids: z.array(z.number().int().positive()) }).parse(req.body)
  reorder(kind, ids)
  res.json({ ok: true })
})

router.post('/health/run', (req, res) => {
  const scope = z.object({
    siteId: z.number().int().positive().optional(),
    groupId: z.number().int().positive().optional(),
    modelId: z.number().int().positive().optional(),
  }).refine((value) => [value.siteId, value.groupId, value.modelId].filter(Boolean).length <= 1, {
    message: '一次只能选择站点、分组或模型中的一个测活范围',
  }).parse(req.body || {})
  res.status(202).json(startHealthCheck(scope))
})
router.get('/health/jobs', (_req, res) => res.json(listJobs()))

export default router
