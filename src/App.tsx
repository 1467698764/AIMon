import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowUpDown, ChevronsDown, ChevronsUp, CircleAlert, Clock, Command, List, LoaderCircle, LogOut,
  MessageSquareText, PanelLeft, Plus, RefreshCw, Rows3, Search, Server, Settings as SettingsIcon, SunMoon, Trash2,
} from 'lucide-react'
import { api } from './api'
import type { AuthStatus, Dashboard, HealthJob, HealthJobTarget, SiteItem } from './types'
import { errorMessage, fmtClock, hostOf } from './lib/format'
import {
  healthKey, siteHasVisibleModels, sortModes, statusCounts, statusLabels, statusOrder, summarizeHealthTargets,
  summarizeRefreshingJobs, type HealthScope, type SortMode, type StatusFilter,
} from './lib/health'
import { applyDensity, applyTheme, prefs, type Density, type SiteViewMode, type ThemeChoice } from './lib/prefs'
import { resolveSiteView } from './lib/view'
import { AppHeader } from './components/AppHeader'
import { AuthScreen } from './components/AuthScreen'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { JobStrip } from './components/JobStrip'
import { OverviewTiles } from './components/OverviewTiles'
import { PromptModal } from './components/PromptModal'
import { SettingsModal } from './components/SettingsModal'
import { ShortcutHelp } from './components/ShortcutHelp'
import { SiteDirectory } from './components/SiteDirectory'
import { SitePanel, type DragState } from './components/SitePanel'
import { SiteWizard } from './components/SiteWizard'
import { ToastStack, useToasts, type ToastTone } from './components/Toasts'
import { Workbench } from './components/Workbench'
import { LoadingScreen, Modal } from './components/primitives'

const themeOrder: readonly ThemeChoice[] = ['auto', 'light', 'dark']
const themeNames: Record<ThemeChoice, string> = { auto: '跟随系统', light: '浅色', dark: '深色' }

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase())
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [jobs, setJobs] = useState<HealthJob[]>([])
  const [authError, setAuthError] = useState('')
  const [dashboardError, setDashboardError] = useState('')
  const [jobsError, setJobsError] = useState('')
  const { toasts, push, dismiss } = useToasts()
  const [wizard, setWizard] = useState<{ siteId?: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeChoice>(() => prefs.theme())
  const [density, setDensity] = useState<Density>(() => prefs.density())
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    const stored = prefs.sort()
    return sortModes.some((mode) => mode.value === stored) ? stored as SortMode : 'manual'
  })
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [directoryQuery, setDirectoryQuery] = useState('')
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const [siteViewPreference, setSiteViewPreference] = useState<SiteViewMode | null>(() => prefs.siteView())
  const [focusedSiteId, setFocusedSiteId] = useState<number | null>(() => prefs.focusedSite())
  // A focused site can be collapsed manually. Selecting it again from the site
  // directory is an explicit request to open it, even when its id did not change.
  // Including this revision in the focused panel key makes that intent reliable
  // instead of depending on React remounting only when the selected id changes.
  const [focusRevision, setFocusRevision] = useState(0)
  const [expansionCommand, setExpansionCommand] = useState<{ revision: number; siteIds: number[]; expanded: boolean } | null>(null)
  const [bulkAllToggling, setBulkAllToggling] = useState(false)
  const [dragging, setDragging] = useState<DragState>(null)
  const [pendingHealthKeys, setPendingHealthKeys] = useState<Set<string>>(new Set())
  const [deletingSiteIds, setDeletingSiteIds] = useState<Set<number>>(new Set())
  const [deleteCandidate, setDeleteCandidate] = useState<SiteItem | null>(null)
  const [promptRequest, setPromptRequest] = useState<{ scope: HealthScope; label: string; hint: string } | null>(null)
  const pendingHealthRef = useRef(new Set<string>())
  const trackedJobIdsRef = useRef(new Set<string>())
  const knownJobIdsRef = useRef(new Set<string>())
  const jobsInitializedRef = useRef(false)
  const dashboardEpochRef = useRef(0)
  const dashboardRequestRef = useRef<Promise<boolean> | null>(null)
  const dashboardAbortRef = useRef<AbortController | null>(null)
  const jobsRequestRef = useRef<Promise<boolean> | null>(null)
  const jobsAbortRef = useRef<AbortController | null>(null)
  const jobsEpochRef = useRef(0)
  const freshRequestRef = useRef<Promise<boolean> | null>(null)
  const freshQueuedRef = useRef(false)
  const freshSilentRef = useRef(true)
  const refreshCancellationEpochRef = useRef(0)
  const siteReorderRef = useRef(false)
  const siteWorkspaceRef = useRef<HTMLElement | null>(null)
  const workbenchRef = useRef<HTMLElement | null>(null)
  const directoryListRef = useRef<HTMLElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const siteScrollLockRef = useRef<{ siteId: number; until: number } | null>(null)
  const resumeRefreshRef = useRef<() => void>(() => undefined)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => undefined)

  function loadDashboard(silent = false): Promise<boolean> {
    if (dashboardRequestRef.current) return dashboardRequestRef.current
    const epoch = dashboardEpochRef.current
    const controller = new AbortController()
    dashboardAbortRef.current = controller
    const request = api.dashboard(controller.signal)
      .then((data) => {
        if (epoch !== dashboardEpochRef.current) return false
        setDashboard(data)
        setLastUpdatedAt(Date.now())
        setDashboardError('')
        return true
      })
      .catch((err) => {
        if (epoch !== dashboardEpochRef.current || controller.signal.aborted) return false
        setDashboardError(errorMessage(err))
        return false
      })
      .finally(() => {
        if (dashboardRequestRef.current === request) {
          dashboardRequestRef.current = null
          if (dashboardAbortRef.current === controller) dashboardAbortRef.current = null
        }
      })
    dashboardRequestRef.current = request
    return request
  }
  function loadJobs(silent = false): Promise<boolean> {
    if (jobsRequestRef.current) return jobsRequestRef.current
    const epoch = jobsEpochRef.current
    const controller = new AbortController()
    jobsAbortRef.current = controller
    const request = api.jobs(controller.signal)
      .then((data) => {
        if (epoch !== jobsEpochRef.current) return false
        if (!jobsInitializedRef.current) {
          for (const job of data) {
            knownJobIdsRef.current.add(job.id)
            if (job.status === 'queued' || job.status === 'running') trackedJobIdsRef.current.add(job.id)
          }
          jobsInitializedRef.current = true
        }
        setJobs(data)
        setJobsError('')
        return true
      })
      .catch((err) => {
        if (epoch !== jobsEpochRef.current || controller.signal.aborted) return false
        setJobsError(errorMessage(err))
        return false
      })
      .finally(() => {
        if (jobsRequestRef.current === request) {
          jobsRequestRef.current = null
          if (jobsAbortRef.current === controller) jobsAbortRef.current = null
        }
      })
    jobsRequestRef.current = request
    return request
  }

  async function load(silent = false): Promise<boolean> {
    const results = await Promise.all([loadDashboard(silent), loadJobs(silent)])
    return results.every(Boolean)
  }

  function cancelReadRequests(): void {
    refreshCancellationEpochRef.current += 1
    freshQueuedRef.current = false
    freshSilentRef.current = true
    dashboardEpochRef.current += 1
    jobsEpochRef.current += 1
    dashboardAbortRef.current?.abort()
    jobsAbortRef.current?.abort()
    dashboardAbortRef.current = null
    jobsAbortRef.current = null
    dashboardRequestRef.current = null
    jobsRequestRef.current = null
  }
  /** Coalesces refresh requests so a burst of mutations issues one extra read. */
  function loadFresh(silent = true): Promise<boolean> {
    freshQueuedRef.current = true
    freshSilentRef.current = freshSilentRef.current && silent
    if (freshRequestRef.current) return freshRequestRef.current

    const run = (async () => {
      let succeeded = true
      while (freshQueuedRef.current) {
        freshQueuedRef.current = false
        const cycleSilent = freshSilentRef.current
        freshSilentRef.current = true
        const cancellationEpoch = refreshCancellationEpochRef.current
        const pendingReads = [dashboardRequestRef.current, jobsRequestRef.current].filter(
          (request): request is Promise<boolean> => request != null,
        )
        if (pendingReads.length) await Promise.allSettled(pendingReads)
        if (cancellationEpoch !== refreshCancellationEpochRef.current) return false
        succeeded = (await load(cycleSilent)) && succeeded
      }
      return succeeded
    })().finally(() => { freshRequestRef.current = null })
    freshRequestRef.current = run
    return run
  }

  function resetSession(): void {
    cancelReadRequests()
    setAuth((current) => ({ configured: current?.configured ?? true, authenticated: false }))
    setDashboard(null)
    setJobs([])
    pendingHealthRef.current.clear()
    trackedJobIdsRef.current.clear()
    knownJobIdsRef.current.clear()
    jobsInitializedRef.current = false
    setPendingHealthKeys(new Set())
    setDeletingSiteIds(new Set())
    setDeleteCandidate(null)
    setWizard(null)
    setSettingsOpen(false)
    setPaletteOpen(false)
    setShortcutsOpen(false)
    setDashboardError('')
    setJobsError('')
  }

  resumeRefreshRef.current = () => {
    if (auth?.authenticated) void load(Boolean(dashboard))
  }
  useEffect(() => {
    void api.authStatus()
      .then((status) => { setAuth(status); setAuthError('') })
      .catch((err) => setAuthError(errorMessage(err)))
    const expired = () => resetSession()
    window.addEventListener('aimon-auth-expired', expired)
    return () => window.removeEventListener('aimon-auth-expired', expired)
  }, [])
  useEffect(() => {
    const scheduleResume = () => {
      if (document.visibilityState === 'hidden') return
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
      resumeTimerRef.current = setTimeout(() => {
        resumeTimerRef.current = null
        if (document.visibilityState !== 'hidden') resumeRefreshRef.current()
      }, 80)
    }
    document.addEventListener('visibilitychange', scheduleResume)
    window.addEventListener('focus', scheduleResume)
    window.addEventListener('pageshow', scheduleResume)
    window.addEventListener('online', scheduleResume)
    const online = () => setIsOnline(true)
    const offline = () => setIsOnline(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    const onKeyDown = (event: KeyboardEvent) => shortcutRef.current(event)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('visibilitychange', scheduleResume)
      window.removeEventListener('focus', scheduleResume)
      window.removeEventListener('pageshow', scheduleResume)
      window.removeEventListener('online', scheduleResume)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      window.removeEventListener('keydown', onKeyDown)
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
      resumeTimerRef.current = null
    }
  }, [])
  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => {
    if (theme !== 'auto' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => applyTheme('auto')
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [theme])
  useEffect(() => { applyDensity(density) }, [density])
  const hasActiveJob = jobs.some((job) => job.status === 'running' || job.status === 'queued')
  useEffect(() => {
    if (!auth?.authenticated) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let activePolls = 0
    const refresh = async (initial: boolean) => {
      if (document.visibilityState !== 'hidden') {
        if (initial || !hasActiveJob) {
          await load(initial ? false : true)
        } else {
          await loadJobs(true)
          activePolls += 1
          if (activePolls % 3 === 0) await loadDashboard(true)
        }
      }
      if (!stopped) timer = setTimeout(() => void refresh(false), hasActiveJob ? 1000 : 4000)
    }
    void refresh(true)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [auth?.authenticated, hasActiveJob])
  useEffect(() => {
    if (!jobsInitializedRef.current) return
    const notices: Array<{ message: string; tone: ToastTone }> = []
    for (const job of jobs) {
      const unseen = !knownJobIdsRef.current.has(job.id)
      knownJobIdsRef.current.add(job.id)
      if (unseen) trackedJobIdsRef.current.add(job.id)
      if (!trackedJobIdsRef.current.has(job.id) || job.status === 'queued' || job.status === 'running') continue
      trackedJobIdsRef.current.delete(job.id)
      if (job.refreshWarning) notices.push({ message: `测活已完成；${job.refreshWarning}`, tone: 'info' })
      else if (job.status === 'failed') notices.push({ message: job.error || '测活任务执行失败', tone: 'error' })
      else notices.push({ message: '测活任务已完成', tone: 'success' })
    }
    for (const notice of notices) push(notice.message, notice.tone)
    while (knownJobIdsRef.current.size > 500) {
      const oldest = knownJobIdsRef.current.values().next().value
      if (oldest == null) break
      knownJobIdsRef.current.delete(oldest)
    }
  }, [jobs, push])
  /** Renders the queued targets immediately so the UI never lags the click. */
  function optimisticHealthJob(scope: HealthScope, key: string): HealthJob | null {
    if (!dashboard) return null
    const targets: HealthJobTarget[] = []
    for (const site of dashboard.sites) {
      if (scope.siteId && scope.siteId !== site.id) continue
      for (const group of site.groups) {
        if (scope.groupId && scope.groupId !== group.id) continue
        for (const model of group.models) {
          if (scope.modelId && scope.modelId !== model.id) continue
          targets.push({
            siteId: site.id,
            groupId: group.id,
            modelId: model.id,
            label: `${site.name} / ${group.name} / ${model.name}`,
            status: 'queued',
            attempt: 0,
            attemptCount: dashboard.settings.healthAttempts,
          })
        }
      }
    }
    if (!targets.length) return null
    return {
      id: `optimistic:${key}:${Date.now()}`,
      status: 'queued',
      phase: scope.modelId ? 'checking' : 'refreshing',
      total: targets.length,
      completed: 0,
      current: '',
      targets,
      createdAt: new Date().toISOString(),
    }
  }

  async function health(scope: HealthScope = {}, prompt?: string) {
    const key = healthKey(scope)
    if (pendingHealthRef.current.has(key)) return
    pendingHealthRef.current.add(key)
    setPendingHealthKeys(new Set(pendingHealthRef.current))
    const optimistic = optimisticHealthJob(scope, key)
    jobsEpochRef.current += 1
    if (optimistic) setJobs((current) => [optimistic, ...current])
    try {
      const job = await api.health(scope, prompt)
      jobsEpochRef.current += 1
      trackedJobIdsRef.current.add(job.id)
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id && item.id !== optimistic?.id)])
      if (job.deduplicated) push('重复模型已在测活，本次未重复排队')
      else push(job.prompt ? '自定义问题测活已开始' : '测活任务已开始', 'success')
      void loadFresh(true)
    }
    catch (err) {
      if (optimistic) setJobs((current) => current.filter((item) => item.id !== optimistic.id))
      push(errorMessage(err), 'error')
    }
    finally {
      pendingHealthRef.current.delete(key)
      setPendingHealthKeys(new Set(pendingHealthRef.current))
    }
  }
  /** Opens the custom-question dialog for one scope; the run itself starts on submit. */
  function askCustomHealth(scope: HealthScope, label: string, hint: string) {
    if (isHealthActive(scope)) return
    setPromptRequest({ scope, label, hint })
  }
  async function remove(site: SiteItem) {
    if (deletingSiteIds.has(site.id) || isHealthActive({ siteId: site.id })) return
    setDeletingSiteIds((current) => new Set(current).add(site.id))
    try {
      await api.deleteSite(site.id)
      push('站点已删除', 'success')
      setDeleteCandidate(null)
      await loadFresh(false)
    } catch (err) {
      push(errorMessage(err), 'error')
    } finally {
      setDeletingSiteIds((current) => {
        const next = new Set(current)
        next.delete(site.id)
        return next
      })
    }
  }
  async function dropSite(targetId: number) {
    if (!reorderable || siteReorderRef.current || dragging?.kind !== 'site' || !dashboard || dragging.id === targetId) return
    const from = dashboard.sites.findIndex((site) => site.id === dragging.id)
    const to = dashboard.sites.findIndex((site) => site.id === targetId)
    if (from < 0 || to < 0) return
    const previous = dashboard
    const sites = [...dashboard.sites]
    sites.splice(to, 0, sites.splice(from, 1)[0])
    setDashboard({ ...dashboard, sites })
    setDragging(null)
    siteReorderRef.current = true
    try { await api.reorder('site', sites.map((site) => site.id)); void loadFresh(true) }
    catch (err) { setDashboard(previous); push(errorMessage(err), 'error') }
    finally { siteReorderRef.current = false }
  }
  async function moveSite(index: number, delta: number) {
    if (!reorderable || siteReorderRef.current || !dashboard) return
    const target = index + delta
    if (target < 0 || target >= dashboard.sites.length) return
    const previous = dashboard
    const sites = [...dashboard.sites]
    ;[sites[index], sites[target]] = [sites[target], sites[index]]
    setDashboard({ ...dashboard, sites })
    siteReorderRef.current = true
    try { await api.reorder('site', sites.map((site) => site.id)); void loadFresh(true) }
    catch (err) { setDashboard(previous); push(errorMessage(err), 'error') }
    finally { siteReorderRef.current = false }
  }
  function signedIn() {
    setAuth({ configured: true, authenticated: true })
    setDashboard(null)
    setAuthError('')
  }
  async function signOut() {
    try { await api.logout() } finally { resetSession() }
  }
  const activeJobs = useMemo(() => jobs.filter((job) => job.status === 'running' || job.status === 'queued'), [jobs])
  const refreshingJobs = activeJobs.filter((job) => job.phase === 'refreshing')
  const activeTargets = useMemo(
    () => activeJobs.flatMap((job) => job.targets || []).filter((target) => target.status === 'queued' || target.status === 'running'),
    [activeJobs],
  )
  const runningTargets = activeTargets.filter((target) => target.status === 'running')
  const queuedTargets = activeTargets.filter((target) => target.status === 'queued')
  const activeTotal = activeJobs.reduce((sum, job) => sum + job.total, 0)
  const activeCompleted = activeJobs.reduce((sum, job) => sum + job.completed, 0)
  const activeLabel = refreshingJobs.length
    ? `正在同步测活前的站点信息：${summarizeRefreshingJobs(refreshingJobs)}`
    : runningTargets.length
      ? `正在测活：${summarizeHealthTargets(runningTargets, (target) => `${target.label}（第${target.attempt || 1}/${target.attemptCount}次）`)}`
      : activeTargets.length ? `等待测活：${summarizeHealthTargets(activeTargets)}` : '任务排队中'
  const currentTargetLabel = refreshingJobs.length
    ? '正在刷新分组倍率与站点余额'
    : runningTargets[0]?.label || queuedTargets[0]?.label || ''
  const refreshWarning = activeJobs.map((job) => job.refreshWarning).filter(Boolean).join('；')
  const activeTargetByModel = useMemo(() => new Map(activeTargets.map((target) => [target.modelId, target])), [activeTargets])
  const activeModelIds = useMemo(() => new Set(activeTargetByModel.keys()), [activeTargetByModel])
  const activeGroupIds = useMemo(() => new Set(activeTargets.map((target) => target.groupId)), [activeTargets])
  const activeSiteIds = useMemo(() => new Set(activeTargets.map((target) => target.siteId)), [activeTargets])
  const globalModels = useMemo(
    () => dashboard?.sites.flatMap((site) => site.groups.flatMap((group) => group.models)) || [],
    [dashboard?.sites],
  )
  const globalStatusCounts = useMemo(() => statusCounts(globalModels, activeModelIds), [globalModels, activeModelIds])
  const isHealthActive = (scope: HealthScope): boolean => {
    if (pendingHealthKeys.has(healthKey(scope))) return true
    if (scope.modelId) return activeTargetByModel.has(scope.modelId)
    if (scope.groupId) return activeGroupIds.has(scope.groupId)
    if (scope.siteId) return activeSiteIds.has(scope.siteId)
    return activeJobs.length > 0
  }
  const activeTargetFor = (modelId: number): HealthJobTarget | undefined => activeTargetByModel.get(modelId)
  const visibleSites = dashboard?.sites.filter((site) => siteHasVisibleModels(site, deferredQuery, statusFilter, activeModelIds)) || []
  const filtering = Boolean(query.trim() || statusFilter !== 'all')
  const reorderable = sortMode === 'manual' && !filtering
  const siteView = resolveSiteView(dashboard?.sites.length || 0, siteViewPreference)
  const focusedSite = visibleSites.find((site) => site.id === focusedSiteId) || visibleSites[0]
  const focusedVisibleIndex = focusedSite ? visibleSites.findIndex((site) => site.id === focusedSite.id) : -1
  const displayedSites = siteView === 'focus' ? (focusedSite ? [focusedSite] : []) : visibleSites
  const normalizedDirectoryQuery = directoryQuery.trim().toLowerCase()
  const directorySites = normalizedDirectoryQuery
    ? visibleSites.filter((site) => `${site.name} ${site.baseUrl}`.toLowerCase().includes(normalizedDirectoryQuery))
    : visibleSites
  const visibleSiteKey = visibleSites.map((site) => site.id).join(',')
  const dashboardSiteKey = dashboard?.sites.map((site) => site.id).join(',') || ''
  useEffect(() => {
    if (!dashboard?.sites.length) {
      if (focusedSiteId != null) setFocusedSiteId(null)
      return
    }
    if (!dashboard.sites.some((site) => site.id === focusedSiteId)) setFocusedSiteId(dashboard.sites[0].id)
  }, [dashboardSiteKey, focusedSiteId])
  useEffect(() => {
    if (focusedSiteId != null) prefs.setFocusedSite(focusedSiteId)
  }, [focusedSiteId])
  useEffect(() => {
    if (siteView !== 'all' || !visibleSites.length) return
    let frame: number | null = null
    const syncCurrentSite = () => {
      frame = null
      const lock = siteScrollLockRef.current
      if (lock && lock.until > Date.now()) {
        setFocusedSiteId((previous) => previous === lock.siteId ? previous : lock.siteId)
        return
      }
      siteScrollLockRef.current = null
      const siteId = currentViewportSiteId()
      if (siteId != null) setFocusedSiteId((previous) => previous === siteId ? previous : siteId)
    }
    const scheduleSync = () => {
      if (frame != null) return
      frame = window.requestAnimationFrame(syncCurrentSite)
    }
    scheduleSync()
    window.addEventListener('scroll', scheduleSync, { passive: true })
    window.addEventListener('resize', scheduleSync)
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', scheduleSync)
      window.removeEventListener('resize', scheduleSync)
    }
  }, [siteView, visibleSiteKey])
  useEffect(() => {
    const list = directoryListRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!list || !active) return
    const horizontal = list.scrollWidth > list.clientWidth && getComputedStyle(list).display === 'flex'
    if (horizontal) {
      const left = active.offsetLeft - Math.max(0, (list.clientWidth - active.offsetWidth) / 2)
      list.scrollTo({ left, behavior: 'smooth' })
    } else {
      const top = active.offsetTop - Math.max(0, (list.clientHeight - active.offsetHeight) / 2)
      list.scrollTo({ top, behavior: 'smooth' })
    }
  }, [focusedSite?.id, siteView, normalizedDirectoryQuery])
  // The sticky site directory and every scroll-to-site jump have to clear the sticky
  // toolbar, whose height changes as its rows wrap. Publish the measured height once
  // instead of hard-coding an offset that goes stale on every layout tweak.
  useEffect(() => {
    const bar = workbenchRef.current
    if (!bar || typeof ResizeObserver === 'undefined') return
    const publish = () => {
      document.documentElement.style.setProperty('--workbench-h', `${Math.round(bar.offsetHeight)}px`)
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(bar)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--workbench-h')
    }
  }, [auth?.authenticated, dashboard != null])
  function changeSiteView(mode: SiteViewMode) {
    setSiteViewPreference(mode)
    prefs.setSiteView(mode)
  }

  function toggleDensity() {
    setDensity((current) => {
      const next: Density = current === 'compact' ? 'comfortable' : 'compact'
      prefs.setDensity(next)
      return next
    })
  }

  function cycleTheme() {
    setTheme((current) => {
      const next = themeOrder[(themeOrder.indexOf(current) + 1) % themeOrder.length]
      prefs.setTheme(next)
      return next
    })
  }

  function changeSortMode(mode: SortMode) {
    setSortMode(mode)
    prefs.setSort(mode)
  }

  async function refreshPanel() {
    if (manualRefreshing) return
    setManualRefreshing(true)
    try {
      const succeeded = await loadFresh(false)
      if (succeeded) push('监控数据已刷新', 'success')
      else push('部分监控数据刷新失败，请查看页面提示', 'error')
    } finally {
      setManualRefreshing(false)
    }
  }

  function selectFocusedSite(siteId: number, scroll = true) {
    // Selecting a site is an explicit open command. Do not let a previous
    // bulk-collapse command replay when the focused panel remounts.
    setExpansionCommand(null)
    setFocusedSiteId(siteId)
    setFocusRevision((current) => current + 1)
    if (!scroll) return
    window.requestAnimationFrame(() => {
      const top = (siteWorkspaceRef.current?.getBoundingClientRect().top || 0) + window.scrollY - siteScrollOffset()
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    })
  }
  /** Height of everything sticky above a site panel, so scrolling lands cleanly. */
  function siteScrollOffset(): number {
    if (!window.matchMedia('(max-width: 1100px)').matches) {
      const bar = workbenchRef.current
      if (!bar) return 128
      const stickyTop = Number.parseFloat(getComputedStyle(bar).top)
      return (Number.isFinite(stickyTop) ? stickyTop : 66) + bar.offsetHeight + 10
    }
    const directory = siteWorkspaceRef.current?.querySelector<HTMLElement>('.site-directory')
    if (!directory) return 72
    const stickyTop = Number.parseFloat(getComputedStyle(directory).top)
    return (Number.isFinite(stickyTop) ? stickyTop : 56) + directory.offsetHeight + 10
  }

  function currentViewportSiteId(): number | null {
    const entries = Array.from(siteWorkspaceRef.current?.querySelectorAll<HTMLElement>('[data-site-id]') || [])
    if (!entries.length) return null
    const visibleTop = siteScrollOffset()
    const visibleBottom = window.innerHeight - (window.matchMedia('(max-width: 1100px)').matches ? 66 : 0)
    const current = entries.reduce((best, entry) => {
      const rect = entry.getBoundingClientRect()
      const visible = Math.max(0, Math.min(rect.bottom, visibleBottom) - Math.max(rect.top, visibleTop))
      const distance = Math.abs(rect.top - visibleTop)
      return visible > best.visible || (visible === best.visible && distance < best.distance)
        ? { entry, visible, distance }
        : best
    }, { entry: entries[0], visible: -1, distance: Number.POSITIVE_INFINITY }).entry
    const siteId = Number(current.dataset.siteId)
    return Number.isFinite(siteId) ? siteId : null
  }

  function scrollToSite(siteId: number) {
    siteScrollLockRef.current = { siteId, until: Date.now() + 1_200 }
    setFocusedSiteId((previous) => previous === siteId ? previous : siteId)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const entry = siteWorkspaceRef.current?.querySelector<HTMLElement>(`[data-site-id="${siteId}"]`)
      const target = entry || siteWorkspaceRef.current
      if (!target) return
      const top = target.getBoundingClientRect().top + window.scrollY - siteScrollOffset()
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }))
  }

  function focusCurrentSite() {
    const siteId = currentViewportSiteId()
    if (siteId == null) return
    changeSiteView('focus')
    selectFocusedSite(siteId)
  }

  function showAllSites() {
    const siteId = focusedSite?.id
    changeSiteView('all')
    if (siteId != null) scrollToSite(siteId)
  }
  function selectDirectorySite(siteId: number) {
    if (siteView === 'focus') {
      selectFocusedSite(siteId)
      return
    }
    setFocusedSiteId(siteId)
    scrollToSite(siteId)
  }

  function stepSite(delta: number) {
    if (!visibleSites.length) return
    const next = visibleSites[(focusedVisibleIndex < 0 ? 0 : focusedVisibleIndex) + delta]
    if (next) selectDirectorySite(next.id)
  }

  async function setSitesExpanded(siteIds: number[], expanded: boolean) {
    if (bulkAllToggling || !dashboard) return
    const ids = new Set(siteIds)
    // The directory/context selection is the user's explicit current site. Prefer
    // it over a geometry re-scan: after collapsing all sites several short rows
    // can be equally visible and the scan may otherwise jump to a neighbour.
    const anchorSiteId = focusedSite?.id || currentViewportSiteId()
    if (!ids.size) return
    setBulkAllToggling(true)
    setExpansionCommand((current) => ({ revision: (current?.revision || 0) + 1, siteIds: [...ids], expanded }))
    setDashboard((current) => current ? ({
      ...current,
      sites: current.sites.map((site) => ids.has(site.id) ? ({
        ...site, expanded, groups: site.groups.map((group) => ({ ...group, expanded })),
      }) : site),
    }) : current)
    try {
      await api.expandedBulk([...ids], expanded)
      await loadFresh(true)
    } catch (error) {
      push(errorMessage(error), 'error')
      await loadFresh(true)
      setExpansionCommand(null)
    } finally {
      setBulkAllToggling(false)
      if (anchorSiteId) scrollToSite(anchorSiteId)
    }
  }

  function setScopeExpanded(expanded: boolean) {
    if (!dashboard) return
    if (siteView === 'focus') {
      if (focusedSite) void setSitesExpanded([focusedSite.id], expanded)
      return
    }
    void setSitesExpanded(dashboard.sites.map((site) => site.id), expanded)
  }
  const overlayOpen = Boolean(wizard || settingsOpen || shortcutsOpen || deleteCandidate || promptRequest)

  shortcutRef.current = (event) => {
    if (event.defaultPrevented || !auth?.authenticated || !dashboard || overlayOpen) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      setPaletteOpen((open) => !open)
      return
    }
    if (paletteOpen) return
    const typing = isTypingTarget(event.target)
    if (event.key === 'Escape') {
      if (query) setQuery('')
      else if (typing && event.target instanceof HTMLElement) event.target.blur()
      return
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === '/') {
      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    if (event.key === '?') {
      event.preventDefault()
      setShortcutsOpen(true)
      return
    }
    const handlers: Record<string, () => void> = {
      r: () => void refreshPanel(),
      a: () => { if (!isHealthActive({})) void health() },
      p: () => askCustomHealth({}, '所有模型', '全部站点的所有模型'),
      n: () => setWizard({}),
      f: () => siteView === 'focus' ? showAllSites() : focusCurrentSite(),
      e: () => setScopeExpanded(true),
      c: () => setScopeExpanded(false),
      j: () => stepSite(1),
      k: () => stepSite(-1),
      d: () => toggleDensity(),
      t: () => cycleTheme(),
    }
    const handler = handlers[event.key.toLowerCase()]
    if (!handler) return
    event.preventDefault()
    handler()
  }
  if (!auth) return <LoadingScreen message="正在检查访问权限" error={authError} onRetry={() => {
    setAuthError('')
    void api.authStatus()
      .then((status) => { setAuth(status); setAuthError('') })
      .catch((err) => setAuthError(errorMessage(err)))
  }} />
  if (!auth.authenticated) return <AuthScreen status={auth} onAuthenticated={signedIn} />
  if (!dashboard) return <LoadingScreen message="正在载入监控台" error={dashboardError} onRetry={() => {
    setDashboardError('')
    void loadFresh(false)
  }} />

  const sites = dashboard.sites
  const searchPending = deferredQuery !== query
  const statusFilterCounts: Record<StatusFilter, number> = { all: globalModels.length, ...globalStatusCounts }
  const runtimeLabel = !isOnline
    ? '网络离线'
    : dashboardError || jobsError
      ? '连接异常'
      : activeJobs.length
        ? refreshingJobs.length ? '正在同步站点信息' : `正在测活 ${activeCompleted}/${activeTotal}`
        : '监控就绪'
  const runtimeTone = !isOnline || dashboardError || jobsError ? 'error' : activeJobs.length ? 'busy' : 'ready'
  const paletteActions: PaletteAction[] = [
    { id: 'refresh', section: '操作', label: '刷新监控数据', hint: 'R', icon: <RefreshCw size={15} />, run: () => void refreshPanel() },
    { id: 'health-all', section: '操作', label: '对所有模型测活', hint: 'A', icon: <Activity size={15} />, run: () => void health() },
    {
      id: 'health-all-custom', section: '操作', label: '用自定义问题对所有模型测活', hint: 'P',
      icon: <MessageSquareText size={15} />, run: () => askCustomHealth({}, '所有模型', '全部站点的所有模型'),
    },
    { id: 'add-site', section: '操作', label: '添加站点', hint: 'N', icon: <Plus size={15} />, run: () => setWizard({}) },
    { id: 'settings', section: '操作', label: '打开默认配置', icon: <SettingsIcon size={15} />, run: () => setSettingsOpen(true) },
    { id: 'shortcuts', section: '操作', label: '查看键盘快捷键', hint: '?', icon: <Command size={15} />, run: () => setShortcutsOpen(true) },
    { id: 'sign-out', section: '操作', label: '退出登录', icon: <LogOut size={15} />, run: () => void signOut() },
    {
      id: 'view', section: '视图', hint: 'F',
      label: siteView === 'focus' ? '返回全部站点' : '切换到单站查看',
      icon: siteView === 'focus' ? <List size={15} /> : <PanelLeft size={15} />,
      run: () => siteView === 'focus' ? showAllSites() : focusCurrentSite(),
    },
    { id: 'expand', section: '视图', label: siteView === 'focus' ? '展开本站' : '展开所有站点', hint: 'E', icon: <ChevronsDown size={15} />, run: () => setScopeExpanded(true) },
    { id: 'collapse', section: '视图', label: siteView === 'focus' ? '收起本站' : '收起所有站点', hint: 'C', icon: <ChevronsUp size={15} />, run: () => setScopeExpanded(false) },
    { id: 'density', section: '视图', label: density === 'compact' ? '切换为舒适布局' : '切换为紧凑布局', hint: 'D', icon: <Rows3 size={15} />, run: toggleDensity },
    { id: 'theme', section: '视图', label: `切换主题（当前：${themeNames[theme]}）`, hint: 'T', icon: <SunMoon size={15} />, run: cycleTheme },
    ...sortModes.map((mode) => ({
      id: `sort:${mode.value}`, section: '排序', label: `排序：${mode.label}`, hint: mode.hint,
      icon: <ArrowUpDown size={15} />, run: () => changeSortMode(mode.value),
    })),
    ...(['all', ...statusOrder] as StatusFilter[]).map((value) => ({
      id: `filter:${value}`, section: '筛选', icon: <Search size={15} />,
      label: value === 'all' ? '显示全部状态' : `只看${statusLabels[value]}模型`,
      run: () => setStatusFilter(value),
    })),
    ...visibleSites.map((site) => ({
      id: `site:${site.id}`, section: '跳转到站点', label: site.name, hint: hostOf(site.baseUrl),
      icon: <Server size={15} />, run: () => selectDirectorySite(site.id),
    })),
  ]
  return <div className="app-shell">
    <AppHeader
      runtimeLabel={runtimeLabel}
      runtimeTone={runtimeTone}
      runtimeTitle={dashboardError || jobsError || activeLabel || runtimeLabel}
      refreshing={manualRefreshing}
      onRefresh={() => void refreshPanel()}
      theme={theme}
      onTheme={cycleTheme}
      density={density}
      onDensity={toggleDensity}
      onPalette={() => setPaletteOpen(true)}
      onShortcuts={() => setShortcutsOpen(true)}
      onSettings={() => setSettingsOpen(true)}
      onSignOut={() => void signOut()}
    />
    <main className="workspace">
      <section className="page-head">
        <div>
          <h1>渠道监控</h1>
          <p className="page-subtitle">
            站点、分组与模型的实时可用性
            {lastUpdatedAt && <time dateTime={new Date(lastUpdatedAt).toISOString()}>
              <Clock size={12} />最近刷新 {fmtClock(lastUpdatedAt)}
            </time>}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="button accent" disabled={isHealthActive({})} onClick={() => void health()}>
            <RefreshCw className={isHealthActive({}) ? 'spin' : ''} size={16} />所有模型测活
          </button>
          <button
            type="button"
            className="button accent"
            title="用自己的问题对所有模型测活，并保留回复原文"
            disabled={isHealthActive({})}
            onClick={() => askCustomHealth({}, '所有模型', '全部站点的所有模型')}
          ><MessageSquareText size={16} />自定义测活</button>
          <button type="button" className="button primary" onClick={() => setWizard({})}><Plus size={17} />添加站点</button>
        </div>
      </section>
      <OverviewTiles
        dashboard={dashboard}
        counts={globalStatusCounts}
        total={globalModels.length}
        checking={activeModelIds.size}
      />
      <Workbench
        barRef={workbenchRef}
        query={query}
        onQuery={setQuery}
        pending={searchPending}
        inputRef={searchInputRef}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        counts={statusFilterCounts}
        sortMode={sortMode}
        onSortMode={changeSortMode}
        result={sites.length ? `显示 ${visibleSites.length} / ${sites.length} 个站点` : ''}
        focusMode={siteView === 'focus'}
        siteName={focusedSite?.name || ''}
        index={focusedVisibleIndex}
        count={visibleSites.length}
        busy={bulkAllToggling}
        onPrev={focusedVisibleIndex > 0 ? () => selectFocusedSite(visibleSites[focusedVisibleIndex - 1].id) : undefined}
        onNext={focusedVisibleIndex >= 0 && focusedVisibleIndex < visibleSites.length - 1
          ? () => selectFocusedSite(visibleSites[focusedVisibleIndex + 1].id)
          : undefined}
        onToggleView={() => siteView === 'focus' ? showAllSites() : focusCurrentSite()}
        onExpand={() => setScopeExpanded(true)}
        onCollapse={() => setScopeExpanded(false)}
      />
      {activeJobs.length > 0 && <JobStrip
        label={activeLabel}
        headline={refreshingJobs.length ? '正在同步站点信息' : `${runningTargets.length} 个模型测活中`}
        detail={refreshingJobs.length ? undefined : `${queuedTargets.length} 个排队中`}
        current={currentTargetLabel}
        warning={refreshWarning}
        customPrompt={activeJobs.find((job) => job.prompt)?.prompt}
        completed={activeCompleted}
        total={activeTotal}
      />}
      {dashboardError && <div className="page-error">
        <CircleAlert size={18} /><span>监控数据刷新失败：{dashboardError}</span>
        <button type="button" onClick={() => { setDashboardError(''); void loadFresh(false) }}>重试</button>
      </div>}
      {jobsError && <div className="page-error page-warning">
        <CircleAlert size={18} /><span>任务状态刷新失败：{jobsError}</span>
        <button type="button" onClick={() => { setJobsError(''); void loadFresh(true) }}>重试</button>
      </div>}
      <section
        ref={siteWorkspaceRef}
        className={`site-workspace ${visibleSites.length ? 'has-sites' : ''} ${siteView === 'focus' && visibleSites.length ? 'focus' : 'all'}`}
      >
        {visibleSites.length > 0 && <SiteDirectory
          sites={visibleSites}
          matches={directorySites}
          focusedSiteId={focusedSite?.id}
          focusedIndex={focusedVisibleIndex}
          activeSiteIds={activeSiteIds}
          activeModelIds={activeModelIds}
          query={directoryQuery}
          onQuery={setDirectoryQuery}
          onSelect={selectDirectorySite}
          listRef={directoryListRef}
          focusMode={siteView === 'focus'}
        />}
        <section className="site-list">
          {displayedSites.map((site) => {
            const index = sites.findIndex((item) => item.id === site.id)
            return <div
              className="site-entry"
              data-site-id={site.id}
              key={siteView === 'focus' ? `focus:${site.id}:${focusRevision}` : `all:${site.id}`}
              onDragOver={(event) => { if (siteView === 'all' && reorderable) event.preventDefault() }}
              onDrop={() => { if (siteView === 'all') void dropSite(site.id) }}
            >
              <SitePanel
                site={site}
                siteIndex={index}
                siteCount={sites.length}
                sortMode={sortMode}
                query={deferredQuery}
                statusFilter={statusFilter}
                activeModelIds={activeModelIds}
                siteDragEnabled={siteView === 'all'}
                focusedView={siteView === 'focus'}
                expansionCommand={expansionCommand?.siteIds.includes(site.id) ? expansionCommand : undefined}
                onMoveSite={(delta) => void moveSite(index, delta)}
                onEdit={() => setWizard({ siteId: site.id })}
                onDelete={() => setDeleteCandidate(site)}
                deleting={deletingSiteIds.has(site.id)}
                onHealth={(scope) => void health(scope)}
                onCustomHealth={askCustomHealth}
                isHealthActive={isHealthActive}
                activeTargetFor={activeTargetFor}
                onChanged={() => void loadFresh(true)}
                onError={(message) => push(message, 'error')}
                onNotice={(message) => push(message)}
                dragging={dragging}
                setDragging={setDragging}
              />
            </div>
          })}
          {!sites.length && <div className="empty-state">
            <div className="empty-symbol"><Activity size={30} /></div>
            <h2>还没有监控站点</h2>
            <p>添加第一个 AI 中转站，AIMon 会拉取分组与模型并开始测活。</p>
            <button type="button" className="button primary" onClick={() => setWizard({})}><Plus size={17} />添加站点</button>
          </div>}
          {sites.length > 0 && !visibleSites.length && <div className="empty-state compact">
            <div className="empty-symbol"><Search size={26} /></div>
            <h2>没有匹配的模型</h2>
            <p>调整搜索词或状态筛选。</p>
            <button type="button" className="button" onClick={() => { setQuery(''); setStatusFilter('all') }}>清除筛选</button>
          </div>}
        </section>
      </section>
    </main>
    {paletteOpen && <CommandPalette actions={paletteActions} onClose={() => setPaletteOpen(false)} />}
    {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
    {wizard && <SiteWizard
      siteId={wizard.siteId}
      onClose={() => setWizard(null)}
      onSaved={(runHealth, nextDashboard, job, warning) => {
        dashboardEpochRef.current += 1
        if (nextDashboard) setDashboard(nextDashboard)
        else void loadFresh(true)
        if (job) {
          jobsEpochRef.current += 1
          trackedJobIdsRef.current.add(job.id)
          setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
        }
        if (warning) push(`配置已保存；${warning}`)
        else push(runHealth ? '配置已保存，测活任务已启动' : '配置已保存', 'success')
      }}
    />}
    {promptRequest && <PromptModal
      scopeLabel={promptRequest.label}
      targetHint={promptRequest.hint}
      onClose={() => setPromptRequest(null)}
      onRun={(prompt) => {
        const { scope } = promptRequest
        setPromptRequest(null)
        void health(scope, prompt)
      }}
    />}
    {settingsOpen && <SettingsModal
      current={dashboard.settings}
      onClose={() => setSettingsOpen(false)}
      onSaved={() => { push('默认配置已保存', 'success'); void loadFresh(false) }}
    />}
    {deleteCandidate && <Modal
      title="删除站点"
      closeDisabled={deletingSiteIds.has(deleteCandidate.id)}
      onClose={() => setDeleteCandidate(null)}
    >
      <div className="modal-body delete-confirm">
        <div className="delete-confirm-icon"><Trash2 size={22} /></div>
        <div>
          <strong>确认删除“{deleteCandidate.name}”？</strong>
          <p>本站的分组、模型和历史测活记录会从 AIMon 删除。远端站点中的 API Key 保持不变。</p>
        </div>
      </div>
      <footer className="modal-footer">
        <button
          type="button"
          className="button ghost"
          disabled={deletingSiteIds.has(deleteCandidate.id)}
          onClick={() => setDeleteCandidate(null)}
        >取消</button>
        <button
          type="button"
          className="button danger"
          disabled={deletingSiteIds.has(deleteCandidate.id) || isHealthActive({ siteId: deleteCandidate.id })}
          onClick={() => void remove(deleteCandidate)}
        >{deletingSiteIds.has(deleteCandidate.id) && <LoaderCircle size={16} className="spin" />}删除站点</button>
      </footer>
    </Modal>}
    <ToastStack toasts={toasts} onDismiss={dismiss} />
  </div>
}
