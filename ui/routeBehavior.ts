import type { FileResponse, Focus, ProjectBranch, ProjectSummary, Snapshot, TreeResponse } from './types'
import { ApiError, validMutationResponse } from './api.ts'
import { normalizeCatalog, type FileRow, focusFromSnapshot } from './models.ts'

export function selectorOptions(projects: ProjectSummary[], activeId: string): ProjectSummary[] {
  return normalizeCatalog(projects, activeId)
}

export function closeSelectorAfterSelection(open: boolean, selectedId: string, projects: ProjectSummary[]): boolean {
  return open && projects.some((project) => project.project_id === selectedId) ? false : open
}

export function treeKeyboardAction(
  row: FileRow,
  key: string,
  expanded: boolean,
): 'next' | 'previous' | 'first' | 'last' | 'expand' | 'collapse' | 'activate' | 'none' {
  if (key === 'ArrowDown') return 'next'
  if (key === 'ArrowUp') return 'previous'
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  if (key === 'ArrowRight' && row.kind === 'folder' && !expanded) return 'expand'
  if (key === 'ArrowLeft' && row.kind === 'folder' && expanded) return 'collapse'
  if ((key === 'Enter' || key === ' ') && row.kind === 'file') return 'activate'
  return 'none'
}

export function branchTabItems(
  tab: 'local' | 'remote',
  local: ProjectBranch[],
  remote: ProjectBranch[],
): ProjectBranch[] {
  return tab === 'local' ? local : remote
}

export function focusMode(focus: Focus | null): 'file-diff' | 'branch-log' | 'commit-detail' | 'empty' {
  return focus?.kind === 'file'
    ? 'file-diff'
    : focus?.kind === 'branch'
      ? 'branch-log'
      : focus?.kind === 'commit'
        ? 'commit-detail'
        : 'empty'
}

export function retainLastGood(previous: Snapshot, next: Snapshot | undefined, failed: boolean): Snapshot {
  return failed || !next ? previous : next
}

export function routeLayoutContract(): {
  scrollOwner: 'route'
  horizontalOverflow: 'hidden'
  mobileOrder: readonly string[]
} {
  return {
    scrollOwner: 'route',
    horizontalOverflow: 'hidden',
    mobileOrder: ['selector', 'files', 'branches', 'commits', 'github', 'mutation', 'context'],
  }
}

type RouteApi = {
  catalog: () => Promise<ProjectSummary[]>
  snapshot: (projectId: string, recovery?: boolean) => Promise<Snapshot>
  commit: (projectId: string, commitId: string, snapshot: Snapshot) => Promise<unknown>
  pullRequest: (projectId: string, number: number, snapshot: Snapshot) => Promise<unknown>
  switchBranch: (projectId: string, branchName: string) => Promise<unknown>
  createBranch: (projectId: string, name: string) => Promise<unknown>
  tree: (projectId: string, path?: string) => Promise<TreeResponse>
  readFile: (projectId: string, path: string) => Promise<FileResponse>
  plansTree: (projectId: string, path?: string) => Promise<TreeResponse>
  plansFile: (projectId: string, path: string) => Promise<FileResponse>
}

export type RouteState = {
  catalog: ProjectSummary[]
  activeId?: string
  snapshot?: Snapshot
  focus: Focus | null
  detail?: unknown
  detailLoading: boolean
  loading: boolean
  error?: ApiError
  selectorOpen: boolean
  mutation: boolean
  mutationMessage: string
  mutationBusy: boolean
  selectedCommitHash?: string
  mode: 'git' | 'code' | 'plans'
  codePath?: string
  codeFile?: FileResponse
  codeLoading: boolean
  codeError?: ApiError
  planPath?: string
  planFile?: FileResponse
  planLoading: boolean
  planError?: ApiError
}

const initialState: RouteState = {
  catalog: [],
  focus: null,
  detailLoading: false,
  loading: true,
  selectorOpen: false,
  mutation: false,
  mutationMessage: '',
  mutationBusy: false,
  mode: 'git',
  codeLoading: false,
  planLoading: false,
}
const asError = (cause: unknown) => (cause instanceof ApiError ? cause : new ApiError('NETWORK'))
const INDETERMINATE_MUTATION_CODES = new Set(['MUTATION_INDETERMINATE', 'INDETERMINATE', 'READBACK_MISMATCH'])
const isDefinitiveMutationRejection = (error: ApiError): boolean =>
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  !INDETERMINATE_MUTATION_CODES.has(error.code)

export function createRouteController(api: RouteApi) {
  let state: RouteState = { ...initialState }
  let mounted = true
  let token = 0
  let snapshotToken = 0
  let mutationToken = 0
  const listeners = new Set<() => void>()
  const publish = (next: RouteState) => {
    state = next
    listeners.forEach((listener) => listener())
  }
  const update = (patch: Partial<RouteState>) => publish({ ...state, ...patch })
  const currentToken = () => token
  const loadSnapshot = async (id: string, requestToken = snapshotToken, recovery = false) => {
    update({ loading: true, detail: undefined, error: undefined, detailLoading: false })
    try {
      const next = await api.snapshot(id, recovery)
      if (!mounted || requestToken !== snapshotToken || id !== state.activeId) return
      update({
        snapshot: next,
        focus: focusFromSnapshot(state.focus ? { ...next, focusDefaults: state.focus } : next),
        loading: false,
      })
    } catch (cause) {
      if (mounted && requestToken === snapshotToken && id === state.activeId)
        update({ loading: false, error: asError(cause) })
    }
  }
  const mount = async () => {
    mounted = true
    const requestToken = ++snapshotToken
    try {
      const items = await api.catalog()
      if (!mounted || requestToken !== snapshotToken) return
      const enabledItems = items.filter((item) => item.enabled)
      const first = enabledItems[0]
      update({ catalog: enabledItems, activeId: first?.project_id, loading: Boolean(first) })
      if (first) await loadSnapshot(first.project_id, requestToken)
      else update({ loading: false })
    } catch (cause) {
      if (mounted && requestToken === snapshotToken) update({ loading: false, error: asError(cause) })
    }
  }
  const selectProject = (id: string) => {
    if (!state.catalog.some((project) => project.project_id === id && project.enabled)) return Promise.resolve()
    const requestToken = ++snapshotToken
    ++token
    ++mutationToken
    update({
      activeId: id,
      snapshot: undefined,
      focus: null,
      detail: undefined,
      detailLoading: false,
      selectedCommitHash: undefined,
      error: undefined,
      mutation: false,
      mutationMessage: '',
      mutationBusy: false,
      selectorOpen: false,
      mode: 'git',
      codePath: undefined,
      codeFile: undefined,
      codeLoading: false,
      codeError: undefined,
      planPath: undefined,
      planFile: undefined,
      planLoading: false,
      planError: undefined,
    })
    return loadSnapshot(id, requestToken)
  }
  const refresh = () => {
    if (!state.activeId) return Promise.resolve()
    const requestToken = ++snapshotToken
    ++token
    const recovery = state.mutationBusy && state.mutationMessage.startsWith('Mutation indeterminate')
    const promise = loadSnapshot(state.activeId, requestToken, recovery)
    return promise.then(() => {
      if (
        state.mutationBusy &&
        state.mutationMessage.startsWith('Mutation indeterminate') &&
        !state.error &&
        !state.loading
      )
        update({ mutation: false, mutationBusy: false })
    })
  }
  const selectFocus = async (next: Focus) => {
    const current = state.snapshot
    const requestToken = ++token
    update({
      focus: next,
      detail: undefined,
      loading: false,
      detailLoading: next.kind === 'commit',
      selectedCommitHash: next.kind === 'commit' ? next.value : undefined,
      error: undefined,
    })
    if (!current || next.kind !== 'commit') return
    try {
      const detail = await api.commit(current.project_id, next.value, current)
      if (mounted && requestToken === token && state.activeId === current.project_id) update({ detail })
    } catch (cause) {
      if (mounted && requestToken === token && state.activeId === current.project_id) update({ error: asError(cause) })
    } finally {
      if (mounted && requestToken === token) update({ detailLoading: false })
    }
  }
  const selectCommit = async (hash?: string) => {
    const current = state.snapshot
    const requestToken = ++token
    if (!current) return
    if (hash === undefined) {
      update({ selectedCommitHash: undefined, detail: undefined, detailLoading: false, error: undefined })
      return
    }
    update({ selectedCommitHash: hash, detail: undefined, detailLoading: true, error: undefined })
    try {
      const detail = await api.commit(current.project_id, hash, current)
      if (mounted && requestToken === token && state.activeId === current.project_id) update({ detail })
    } catch (cause) {
      if (mounted && requestToken === token && state.activeId === current.project_id) update({ error: asError(cause) })
    } finally {
      if (mounted && requestToken === token) update({ detailLoading: false })
    }
  }
  const selectPullRequest = async (number: number) => {
    const current = state.snapshot
    const requestToken = ++token
    if (!current) return
    update({
      focus: null,
      detail: undefined,
      loading: false,
      detailLoading: true,
      selectedCommitHash: undefined,
      error: undefined,
    })
    try {
      const detail = await api.pullRequest(current.project_id, number, current)
      if (mounted && requestToken === token && state.activeId === current.project_id) update({ detail })
    } catch (cause) {
      if (mounted && requestToken === token) update({ error: asError(cause) })
    } finally {
      if (mounted && requestToken === token) update({ detailLoading: false })
    }
  }
  const setMode = (mode: 'git' | 'code' | 'plans') => {
    ++token
    update({
      mode,
      codePath: undefined,
      codeFile: undefined,
      codeLoading: false,
      codeError: undefined,
      planPath: undefined,
      planFile: undefined,
      planLoading: false,
      planError: undefined,
    })
  }
  const openCodeFile = async (path: string) => {
    const currentId = state.activeId
    if (!currentId || state.mode !== 'code') return
    const requestToken = ++token
    update({ codePath: path, codeLoading: true, codeError: undefined })
    try {
      const file = await api.readFile(currentId, path)
      if (mounted && requestToken === token && state.activeId === currentId && state.mode === 'code')
        update({ codeFile: file, codeLoading: false })
    } catch (cause) {
      if (mounted && requestToken === token && state.activeId === currentId && state.mode === 'code')
        update({ codeError: asError(cause), codeLoading: false })
    } finally {
      if (mounted && requestToken === token && state.mode === 'code') update({ codeLoading: false })
    }
  }
  const openPlanFile = async (path: string) => {
    const currentId = state.activeId
    if (!currentId || state.mode !== 'plans') return
    const requestToken = ++token
    update({ planPath: path, planFile: undefined, planLoading: true, planError: undefined })
    try {
      const file = await api.plansFile(currentId, path)
      if (mounted && requestToken === token && state.activeId === currentId && state.mode === 'plans')
        update({ planFile: file, planLoading: false })
    } catch (cause) {
      if (mounted && requestToken === token && state.activeId === currentId && state.mode === 'plans')
        update({ planError: asError(cause), planLoading: false })
    } finally {
      if (mounted && requestToken === token && state.mode === 'plans') update({ planLoading: false })
    }
  }
  const mutate = async (kind: 'switch' | 'create', value: string) => {
    const current = state.snapshot
    if (!current || !value.trim() || state.mutationBusy) return
    const requestToken = ++mutationToken
    const focusAtStart = state.focus
    ++token
    ++snapshotToken
    update({
      mutation: true,
      mutationBusy: true,
      loading: false,
      detail: undefined,
      detailLoading: false,
      mutationMessage: '',
    })
    let completed = false
    let reconciled = false
    let rejected = false
    try {
      const acknowledgement =
        kind === 'switch'
          ? await api.switchBranch(current.project_id, value)
          : await api.createBranch(current.project_id, value)
      if (!validMutationResponse(acknowledgement, current.project_id, value, kind === 'create'))
        throw new ApiError('INVALID_MUTATION_RESPONSE', 'Mutation acknowledgement was not verified.')
      const readBack = await api.snapshot(current.project_id)
      if (
        readBack.localGeneration === undefined ||
        readBack.localGeneration < acknowledgement.generation ||
        !readBack.branches.local.some((branch) => branch.name === value && branch.current === true)
      )
        throw new ApiError('READBACK_MISMATCH', 'Mutation read-back did not confirm the requested branch.')
      ++snapshotToken
      if (!mounted || requestToken !== mutationToken || state.activeId !== current.project_id) return
      const patch: Partial<RouteState> = {
        snapshot: readBack,
        mutationMessage: 'Read-back confirmed.',
        error: undefined,
      }
      if (state.focus === focusAtStart) patch.focus = focusFromSnapshot(readBack)
      update(patch)
      completed = true
    } catch (cause) {
      const error = asError(cause)
      if (mounted && requestToken === mutationToken) {
        if (isDefinitiveMutationRejection(error)) {
          update({ mutation: false, mutationBusy: false, mutationMessage: error.message, error, loading: false })
          rejected = true
          return
        }
        update({ mutationMessage: `Mutation indeterminate: ${error.message}`, error, loading: false })
        try {
          const refreshed = await api.snapshot(current.project_id, true)
          ++snapshotToken
          if (mounted && requestToken === mutationToken && state.activeId === current.project_id) {
            const recovery: Partial<RouteState> = {
              snapshot: refreshed,
              loading: false,
              mutationMessage: 'Mutation indeterminate; state reconciled.',
              error,
            }
            if (state.focus === focusAtStart) recovery.focus = focusFromSnapshot(refreshed)
            update(recovery)
            reconciled = true
          }
        } catch {
          /* keep mutationBusy set; manual recovery is required */
        }
      }
    } finally {
      if (mounted && requestToken === mutationToken && (completed || reconciled || rejected))
        update({ mutation: false, mutationBusy: false })
    }
  }
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mount,
    unmount: () => {
      mounted = false
      ++token
      ++snapshotToken
      ++mutationToken
      listeners.clear()
    },
    selectProject,
    refresh,
    selectFocus,
    selectCommit,
    selectPullRequest,
    setMode,
    openCodeFile,
    openPlanFile,
    mutate,
    toggleSelector: () => update({ selectorOpen: !state.selectorOpen }),
  }
}
