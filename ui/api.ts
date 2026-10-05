import type {
  CapabilityStatus,
  Commit,
  CommitDetail,
  CommitDetailFile,
  FileEntry,
  FileRawResponse,
  FileResponse,
  Issue,
  ProjectBranch,
  ProjectSummary,
  PullRequest,
  PullRequestCheck,
  PullRequestDetail,
  Snapshot,
  TreeEntry,
  TreeResponse,
} from './types'
import { safeHttpsUrl } from './models'

const API_ROOT = '/api/local/mc-project-plugin/projects'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_PROJECTS = 50
const MAX_FILES = 2_000
const MAX_BRANCHES = 500
const MAX_COMMITS = 500
const MAX_GITHUB_ITEMS = 100
const MAX_DETAIL_FILES = 500
const MAX_DETAIL_CHECKS = 100
const MAX_DETAIL_NAMES = 100
const MAX_STRING = 4096
const MAX_FILE_BYTES = 262_144

export class ApiError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, message = 'Unable to load project data.', status?: number) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'ApiError'
  }
}

type Envelope<T> = { ok: true; data: T; meta: { schemaVersion: 1; requestId: string; observedAt: string } }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))
const hasRequiredKeys = (
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
): value is Record<string, unknown> =>
  record(value) && required.every((key) => key in value) && exactKeys(value, allowed)
const string = (value: unknown, max = MAX_STRING): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const utf8Length = (value: string): number => new TextEncoder().encode(value).length
const isoTimestamp = (value: unknown): value is string => {
  if (!string(value, 128)) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match || Number.isNaN(Date.parse(value))) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}
const optionalString = (value: unknown, max = MAX_STRING): value is string | null | undefined =>
  value === undefined || value === null || string(value, max)
const boundedArray = <T>(value: unknown, max: number, item: (v: unknown) => v is T): value is T[] =>
  Array.isArray(value) && value.length <= max && value.every(item)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
const nonNegativeInteger = (value: unknown): value is number => integer(value) && value >= 0

function safeError(response: Response, payload: unknown): ApiError {
  if (response.status === 401) return new ApiError('UNAUTHENTICATED', 'Authentication required.', response.status)
  if (record(payload) && typeof payload.error === 'string')
    return new ApiError(payload.error, 'The project service returned an error.', response.status)
  return new ApiError(`HTTP_${response.status || 'NETWORK'}`, undefined, response.status || undefined)
}
function unwrap<T>(response: Response, payload: unknown): T {
  if (!response.ok) throw safeError(response, payload)
  if (
    !hasRequiredKeys(payload, ['ok', 'data', 'meta'], ['ok', 'data', 'meta']) ||
    payload.ok !== true ||
    !record(payload.meta) ||
    !hasRequiredKeys(
      payload.meta,
      ['schemaVersion', 'requestId', 'observedAt'],
      ['schemaVersion', 'requestId', 'observedAt'],
    ) ||
    payload.meta.schemaVersion !== 1 ||
    !string(payload.meta.requestId, 256) ||
    !isoTimestamp(payload.meta.observedAt)
  )
    throw new ApiError('INVALID_RESPONSE')
  return (payload as Envelope<T>).data
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers = new Headers(init?.headers)
    headers.set('Accept', 'application/json')
    if (init?.body) headers.set('Content-Type', 'application/json')
    const token = window.localStorage.getItem('mission-control-token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const response = await fetch(`${API_ROOT}${path}`, { ...init, headers, signal: controller.signal })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    return unwrap<T>(response, payload)
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError')
      throw new ApiError('TIMEOUT', 'The request timed out.')
    throw new ApiError('NETWORK')
  } finally {
    window.clearTimeout(timer)
  }
}

function project(value: unknown): value is ProjectSummary {
  return (
    hasRequiredKeys(
      value,
      ['project_id', 'name', 'enabled', 'default_branch'],
      ['project_id', 'name', 'enabled', 'remote', 'default_branch', 'repository'],
    ) &&
    string(value.project_id, 64) &&
    string(value.name, 256) &&
    typeof value.enabled === 'boolean' &&
    string(value.remote, 512) &&
    string(value.default_branch, 256) &&
    optionalString(value.repository, 512)
  )
}
const pathDepth = (value: string): boolean => value.split('/').length <= 32
const validGitRef = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) &&
  !value.includes('..') &&
  !value.includes('//') &&
  !value.includes('@{') &&
  value
    .split('/')
    .every(
      (part) =>
        part &&
        part !== '.' &&
        part !== '..' &&
        !part.startsWith('.') &&
        !part.endsWith('.') &&
        !part.endsWith('.lock'),
    )
const relativePath = (value: string): boolean => !value.startsWith('/') && !value.split('/').includes('..')
function file(value: unknown): value is FileEntry {
  return (
    hasRequiredKeys(value, ['path'], ['path', 'status', 'oldPath']) &&
    string(value.path, 1024) &&
    pathDepth(value.path) &&
    relativePath(value.path) &&
    optionalString(value.status, 8) &&
    optionalString(value.oldPath, 1024)
  )
}
function branch(value: unknown): value is ProjectBranch {
  return (
    hasRequiredKeys(
      value,
      ['name'],
      ['name', 'current', 'tracking', 'remoteAlias', 'repository', 'relation', 'ahead', 'behind'],
    ) &&
    validGitRef(value.name) &&
    (value.current === undefined || typeof value.current === 'boolean') &&
    (value.tracking === undefined || value.tracking === null || validGitRef(value.tracking)) &&
    optionalString(value.remoteAlias, 128) &&
    optionalString(value.repository, 512) &&
    optionalString(value.relation, 32) &&
    (value.ahead === undefined || (integer(value.ahead) && value.ahead >= 0)) &&
    (value.behind === undefined || (integer(value.behind) && value.behind >= 0))
  )
}
function commit(value: unknown): value is Commit {
  return (
    record(value) &&
    hasRequiredKeys(
      value,
      ['hash', 'shortHash', 'subject', 'author', 'date', 'merge', 'parents', 'refs'],
      ['hash', 'shortHash', 'subject', 'author', 'authoredAt', 'date', 'merge', 'parents', 'refs'],
    ) &&
    typeof value.hash === 'string' &&
    /^[0-9a-fA-F]{40}$/.test(value.hash) &&
    typeof value.shortHash === 'string' &&
    /^[0-9a-fA-F]{7,40}$/.test(value.shortHash) &&
    value.hash.toLowerCase().startsWith(value.shortHash.toLowerCase()) &&
    string(value.subject, 4096) &&
    typeof value.author === 'string' &&
    string(value.author, 512) &&
    (value.authoredAt === undefined || isoTimestamp(value.authoredAt)) &&
    isoTimestamp(value.date) &&
    typeof value.merge === 'boolean' &&
    boundedArray(value.refs, 32, (v): v is string => string(v, 256)) &&
    boundedArray(value.parents, 32, (v): v is string => typeof v === 'string' && /^[0-9a-fA-F]{40}$/.test(v))
  )
}
const pull = validPullRequest
const detailPathValue = (value: unknown): value is string =>
  string(value, 1024) && pathDepth(value) && relativePath(value)
const detailFile = (value: unknown): value is CommitDetailFile =>
  record(value) &&
  exactKeys(value, ['path', 'additions', 'deletions', 'binary']) &&
  detailPathValue(value.path) &&
  nonNegativeInteger(value.additions) &&
  value.additions <= 1_000_000 &&
  nonNegativeInteger(value.deletions) &&
  value.deletions <= 1_000_000 &&
  typeof value.binary === 'boolean'
export function validCommitDetail(value: unknown): value is CommitDetail {
  return (
    record(value) &&
    exactKeys(value, ['hash', 'subject', 'author', 'date', 'files', 'diff']) &&
    typeof value.hash === 'string' &&
    /^[0-9a-fA-F]{40}$/.test(value.hash) &&
    string(value.subject, 4096) &&
    string(value.author, 512) &&
    isoTimestamp(value.date) &&
    boundedArray(value.files, MAX_DETAIL_FILES, detailFile) &&
    typeof value.diff === 'string' &&
    utf8Length(value.diff) <= 1024 * 1024
  )
}
const detailCheck = (value: unknown): value is PullRequestCheck =>
  record(value) &&
  exactKeys(value, ['name', 'status', 'conclusion']) &&
  string(value.name, 256) &&
  optionalString(value.conclusion, 64)
const detailNames = (value: unknown): value is string[] =>
  boundedArray(value, MAX_DETAIL_NAMES, (item): item is string => string(item, 256))
function repositoryName(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const raw = value
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : undefined
}
const repositoryBoundUrl = (
  value: unknown,
  repository: string | undefined,
  kind: 'pull' | 'issue',
  number: number,
): boolean => {
  if (value === undefined || value === null) return true
  if (!repository || typeof value !== 'string') return false
  try {
    const url = new URL(value)
    const segment = kind === 'pull' ? 'pull' : 'issues'
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === `/${repository}/${segment}/${number}`
    )
  } catch {
    return false
  }
}
function canonicalPullRequestUrl(
  value: unknown,
  repository: string | null | undefined,
  number: number,
): string | undefined {
  return typeof value === 'string'
    ? safeHttpsUrl(value, { kind: 'pull', number, repository: repositoryName(repository) ?? repository })
    : undefined
}
export function validPullRequestDetail(value: unknown, repository?: string | null): value is PullRequestDetail {
  if (
    !record(value) ||
    !exactKeys(value, [
      'number',
      'title',
      'url',
      'description',
      'author',
      'labels',
      'reviewers',
      'assignees',
      'head',
      'base',
      'head_repository',
      'base_repository',
      'checks',
      'created_at',
      'updated_at',
      'draft',
    ]) ||
    !integer(value.number) ||
    value.number <= 0 ||
    !string(value.title, 4096) ||
    !canonicalPullRequestUrl(value.url, repository, value.number) ||
    typeof value.description !== 'string' ||
    value.description.length > 64 * 1024 ||
    !string(value.author, 512) ||
    !detailNames(value.labels) ||
    !detailNames(value.reviewers) ||
    !detailNames(value.assignees) ||
    !string(value.head, 512) ||
    !string(value.base, 512) ||
    !optionalString(value.head_repository, 512) ||
    !string(value.base_repository, 512) ||
    !boundedArray(value.checks, MAX_DETAIL_CHECKS, detailCheck) ||
    !isoTimestamp(value.created_at) ||
    !isoTimestamp(value.updated_at) ||
    typeof value.draft !== 'boolean'
  )
    return false
  return (
    repositoryName(value.base_repository) === repositoryName(repository) &&
    (value.head_repository === null || repositoryName(value.head_repository) !== undefined)
  )
}
export function validPullRequest(value: unknown, expectedRepository?: string): value is PullRequest {
  return (
    hasRequiredKeys(
      value,
      ['number', 'title', 'created_at'],
      [
        'number',
        'title',
        'url',
        'author',
        'head',
        'base',
        'head_repository',
        'base_repository',
        'repository',
        'created_at',
        'draft',
        'description',
        'labels',
        'checks',
      ],
    ) &&
    integer(value.number) &&
    value.number > 0 &&
    string(value.title, 4096) &&
    (value.url === undefined ||
      value.url === null ||
      (typeof value.url === 'string' &&
        typeof (expectedRepository ?? value.repository) === 'string' &&
        safeHttpsUrl(value.url, {
          kind: 'pull',
          number: value.number,
          repository: (expectedRepository ?? value.repository) as string,
        }) !== undefined)) &&
    optionalString(value.author, 512) &&
    optionalString(value.head, 512) &&
    optionalString(value.base, 512) &&
    optionalString(value.head_repository, 512) &&
    optionalString(value.base_repository, 512) &&
    optionalString(value.repository, 512) &&
    isoTimestamp(value.created_at) &&
    (value.draft === undefined || typeof value.draft === 'boolean') &&
    optionalString(value.description, 4096) &&
    (value.labels === undefined || boundedArray(value.labels, 32, (v): v is string => string(v, 128))) &&
    optionalString(value.checks, 4096)
  )
}
export function validIssue(value: unknown, expectedRepository?: string): value is Issue {
  return (
    hasRequiredKeys(
      value,
      ['number', 'title', 'created_at'],
      ['number', 'title', 'url', 'repository', 'labels', 'author', 'created_at', 'updatedAt'],
    ) &&
    integer(value.number) &&
    value.number > 0 &&
    string(value.title, 4096) &&
    (value.url === undefined ||
      value.url === null ||
      (typeof value.url === 'string' &&
        typeof (expectedRepository ?? value.repository) === 'string' &&
        safeHttpsUrl(value.url, {
          kind: 'issue',
          number: value.number,
          repository: (expectedRepository ?? value.repository) as string,
        }) !== undefined)) &&
    optionalString(value.repository, 512) &&
    (value.labels === undefined || boundedArray(value.labels, 32, (v): v is string => string(v, 128))) &&
    optionalString(value.author, 512) &&
    isoTimestamp(value.created_at) &&
    (value.updatedAt === undefined || isoTimestamp(value.updatedAt))
  )
}
const issue = validIssue
function capability(value: unknown): boolean {
  if (
    !hasRequiredKeys(
      value,
      ['status', 'stale', 'source', 'observedAt', 'generation', 'value'],
      ['status', 'stale', 'source', 'observedAt', 'generation', 'errorCode', 'staleSince', 'value'],
    )
  )
    return false
  if (typeof value.status !== 'string' || !['ready', 'empty', 'stale', 'unavailable', 'error'].includes(value.status))
    return false
  if (typeof value.stale !== 'boolean' || (value.status === 'stale' ? value.stale !== true : value.stale !== false))
    return false
  return (
    (value.source === 'local_git' || value.source === 'github') &&
    isoTimestamp(value.observedAt) &&
    integer(value.generation) &&
    value.generation >= 0 &&
    'value' in value &&
    optionalString(value.errorCode, 128) &&
    (value.staleSince === undefined || value.staleSince === null || isoTimestamp(value.staleSince))
  )
}
const focus = (value: unknown): value is Snapshot['focusDefaults'] =>
  record(value) &&
  exactKeys(value, ['kind', 'value']) &&
  typeof value.kind === 'string' &&
  ['file', 'branch', 'commit'].includes(value.kind) &&
  (value.value === undefined || value.value === null || string(value.value, 1024))
const capabilityFor = (name: string, value: unknown): boolean => {
  if (!capability(value)) return false
  const item = value as { status: string; value: unknown }
  if (name === 'workingTree')
    return record(item.value) && exactKeys(item.value, ['files']) && boundedArray(item.value.files, MAX_FILES, file)
  if (name === 'branches')
    return (
      record(item.value) &&
      exactKeys(item.value, ['local', 'remote', 'remoteAlias', 'repository']) &&
      boundedArray(item.value.local, MAX_BRANCHES, branch) &&
      boundedArray(item.value.remote, MAX_BRANCHES, branch) &&
      string(item.value.remoteAlias, 128) &&
      optionalString(item.value.repository, 512)
    )
  if (name === 'commits') return boundedArray(item.value, MAX_COMMITS, commit)
  if (name === 'branchLogs')
    return (
      record(item.value) &&
      Object.keys(item.value).length <= MAX_BRANCHES &&
      Object.keys(item.value).every(detailRef) &&
      Object.values(item.value).every((entries) => boundedArray(entries, 100, commit))
    )
  if (name === 'github')
    return (
      record(item.value) &&
      exactKeys(item.value, ['status', 'pullRequests', 'issues']) &&
      item.value.status === item.status &&
      typeof item.value.status === 'string' &&
      ['ready', 'empty', 'stale', 'unavailable', 'error'].includes(item.value.status) &&
      boundedArray(item.value.pullRequests, MAX_GITHUB_ITEMS, (item): item is PullRequest => pull(item)) &&
      boundedArray(item.value.issues, MAX_GITHUB_ITEMS, (item): item is Issue => issue(item))
    )
  return false
}
const detailPath = (value: string): boolean => string(value, 1024) && pathDepth(value) && relativePath(value)
const detailRef = (value: string): boolean => validGitRef(value)
function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    )
  if (record(left) || record(right)) {
    if (!record(left) || !record(right)) return false
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return (
      leftKeys.length === rightKeys.length && leftKeys.every((key) => key in right && sameJson(left[key], right[key]))
    )
  }
  return false
}
export function validSnapshot(value: unknown, projectId: string): value is Snapshot {
  if (
    !record(value) ||
    !string(value.project_id, 64) ||
    value.project_id !== projectId ||
    !exactKeys(value, [
      'schemaVersion',
      'project_id',
      'project',
      'snapshotId',
      'head',
      'observedAt',
      'refreshing',
      'lastUpdated',
      'fingerprints',
      'capabilities',
      'workingTree',
      'fileDiffs',
      'branchLogs',
      'branches',
      'commits',
      'focusDefaults',
      'github',
      'warnings',
      'localStatus',
      'processInstanceId',
      'registryEpoch',
      'localGeneration',
      'contextIdentity',
    ]) ||
    value.schemaVersion !== 1 ||
    !record(value.project) ||
    !exactKeys(value.project, ['name', 'repository']) ||
    !string(value.project.name, 256) ||
    !optionalString(value.project.repository, 512) ||
    !string(value.snapshotId, 128) ||
    !isoTimestamp(value.observedAt) ||
    typeof value.refreshing !== 'boolean' ||
    !record(value.fingerprints) ||
    !exactKeys(value.fingerprints, [
      'HEAD',
      'status',
      'refs/remotes',
      'refs/heads',
      'currentBranch',
      'workingTree',
      'branches',
      'commits',
      'local',
    ]) ||
    !Object.values(value.fingerprints).every((item) => string(item, 128)) ||
    !record(value.workingTree) ||
    !boundedArray(value.workingTree.files, MAX_FILES, file) ||
    !record(value.fileDiffs) ||
    !exactKeys(value.fileDiffs, Object.keys(value.fileDiffs)) ||
    Object.keys(value.fileDiffs).length > MAX_FILES ||
    !Object.keys(value.fileDiffs).every(detailPath) ||
    !Object.values(value.fileDiffs).every((item) => typeof item === 'string' && utf8Length(item) <= 1024 * 1024) ||
    !record(value.branchLogs) ||
    Object.keys(value.branchLogs).length > MAX_BRANCHES ||
    !Object.keys(value.branchLogs).every(detailRef) ||
    !Object.values(value.branchLogs).every((item) => boundedArray(item, 100, commit)) ||
    !record(value.branches) ||
    !exactKeys(value.branches, ['local', 'remote', 'remoteAlias', 'repository']) ||
    !boundedArray(value.branches.local, MAX_BRANCHES, branch) ||
    !boundedArray(value.branches.remote, MAX_BRANCHES, branch) ||
    !string(value.branches.remoteAlias, 128) ||
    !optionalString(value.branches.repository, 512) ||
    !boundedArray(value.commits, MAX_COMMITS, commit) ||
    !record(value.github) ||
    !string(value.github.status, 32) ||
    !boundedArray(value.github.pullRequests, MAX_GITHUB_ITEMS, (item): item is PullRequest => pull(item)) ||
    !boundedArray(value.github.issues, MAX_GITHUB_ITEMS, (item): item is Issue => issue(item)) ||
    !record(value.capabilities) ||
    Object.keys(value.capabilities as Record<string, unknown>).length !== 5 ||
    !Object.keys(value.capabilities as Record<string, unknown>).every(
      (name) =>
        ['workingTree', 'branches', 'commits', 'branchLogs', 'github'].includes(name) &&
        capabilityFor(name, (value.capabilities as Record<string, unknown>)[name]),
    ) ||
    !optionalString(value.head, 128) ||
    !optionalString(value.lastUpdated, 128) ||
    !optionalString(value.processInstanceId, 128) ||
    !(
      (value.registryEpoch === undefined || (integer(value.registryEpoch) && value.registryEpoch >= 0)) &&
      (value.localGeneration === undefined || (integer(value.localGeneration) && value.localGeneration >= 0))
    ) ||
    !optionalString(value.contextIdentity, 256) ||
    (value.localStatus !== undefined && !string(value.localStatus, 64)) ||
    (value.focusDefaults !== undefined && !focus(value.focusDefaults)) ||
    (value.warnings !== undefined && !boundedArray(value.warnings, 32, (v): v is string => string(v, 128)))
  )
    return false
  if (
    !record(value.github) ||
    typeof value.github.status !== 'string' ||
    !['ready', 'empty', 'stale', 'unavailable', 'error'].includes(value.github.status)
  )
    return false
  if (value.head !== null && (typeof value.head !== 'string' || !/^[0-9a-fA-F]{40}$/.test(value.head))) return false
  if (
    !isoTimestamp(value.lastUpdated) ||
    !string(value.processInstanceId, 128) ||
    !integer(value.registryEpoch) ||
    value.registryEpoch < 0 ||
    !integer(value.localGeneration) ||
    value.localGeneration < 0 ||
    !string(value.contextIdentity, 256) ||
    !string(value.localStatus, 64) ||
    !focus(value.focusDefaults) ||
    !boundedArray(value.warnings, 32, (v): v is string => string(v, 128))
  )
    return false
  const capabilities = value.capabilities as Record<string, { value: unknown }>
  const expectedRepository =
    repositoryName(value.project.repository) ??
    (typeof value.project.repository === 'string' ? value.project.repository : undefined)
  if (
    !value.github.pullRequests.every((item) => validPullRequest(item, expectedRepository)) ||
    !value.github.issues.every((item) => validIssue(item, expectedRepository))
  )
    return false
  const pairs: Array<[string, unknown]> = [
    ['workingTree', value.workingTree],
    ['branches', value.branches],
    ['commits', value.commits],
    ['branchLogs', value.branchLogs],
    ['github', value.github],
  ]
  return pairs.every(([name, raw]) => sameJson(raw, capabilities[name].value))
}

export function validMutationResponse(
  value: unknown,
  expectedProjectId?: string,
  expectedBranch?: string,
  expectedCreated?: boolean,
): value is { verified: true; generation: number; project_id?: string; branch?: string; created?: boolean } {
  if (
    !record(value) ||
    !hasRequiredKeys(
      value,
      ['verified', 'generation'],
      ['verified', 'generation', 'project_id', 'branch', 'tracking', 'status', 'created'],
    ) ||
    value.verified !== true ||
    !nonNegativeInteger(value.generation)
  )
    return false
  if (
    expectedProjectId !== undefined &&
    (value.project_id !== expectedProjectId ||
      typeof value.branch !== 'string' ||
      value.branch !== expectedBranch ||
      value.status !== 'clean' ||
      value.created !== expectedCreated)
  )
    return false
  return (
    (value.project_id === undefined || string(value.project_id, 64)) &&
    (value.branch === undefined || validGitRef(value.branch)) &&
    (value.tracking === undefined || value.tracking === null || validGitRef(value.tracking)) &&
    (value.status === undefined || value.status === 'clean') &&
    (value.created === undefined || typeof value.created === 'boolean')
  )
}

function cleanSnapshot(value: Snapshot): Snapshot {
  const cleanFile = (item: FileEntry): FileEntry => ({
    path: item.path,
    ...(item.status !== undefined ? { status: item.status } : {}),
    ...(item.oldPath !== undefined ? { oldPath: item.oldPath } : {}),
  })
  const cleanBranch = (item: ProjectBranch): ProjectBranch => ({
    name: item.name,
    ...(item.current !== undefined ? { current: item.current } : {}),
    ...(item.tracking !== undefined ? { tracking: item.tracking } : {}),
    ...(item.remoteAlias !== undefined ? { remoteAlias: item.remoteAlias } : {}),
    ...(item.repository !== undefined ? { repository: item.repository } : {}),
    ...(item.relation !== undefined ? { relation: item.relation } : {}),
    ...(item.ahead !== undefined ? { ahead: item.ahead } : {}),
    ...(item.behind !== undefined ? { behind: item.behind } : {}),
  })
  const cleanCommit = (item: Commit): Commit => ({
    hash: item.hash,
    subject: item.subject,
    ...(item.shortHash !== undefined ? { shortHash: item.shortHash } : {}),
    ...(item.author !== undefined ? { author: item.author } : {}),
    ...(item.authoredAt !== undefined ? { authoredAt: item.authoredAt } : {}),
    ...(item.date !== undefined ? { date: item.date } : {}),
    ...(item.merge !== undefined ? { merge: item.merge } : {}),
    ...(item.refs !== undefined ? { refs: Array.isArray(item.refs) ? [...item.refs] : item.refs } : {}),
    ...(item.parents !== undefined ? { parents: [...item.parents] } : {}),
  })
  const cleanPull = (item: PullRequest): PullRequest => ({
    number: item.number,
    title: item.title,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.author !== undefined ? { author: item.author } : {}),
    ...(item.head !== undefined ? { head: item.head } : {}),
    ...(item.base !== undefined ? { base: item.base } : {}),
    ...(item.head_repository !== undefined ? { head_repository: item.head_repository } : {}),
    ...(item.base_repository !== undefined ? { base_repository: item.base_repository } : {}),
    ...(item.repository !== undefined ? { repository: item.repository } : {}),
    created_at: item.created_at,
    ...(item.draft !== undefined ? { draft: item.draft } : {}),
    ...(item.description !== undefined ? { description: item.description } : {}),
    ...(item.labels !== undefined ? { labels: [...item.labels] } : {}),
    ...(item.checks !== undefined ? { checks: item.checks } : {}),
  })
  const cleanIssue = (item: Issue): Issue => ({
    number: item.number,
    title: item.title,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.repository !== undefined ? { repository: item.repository } : {}),
    ...(item.labels !== undefined ? { labels: [...item.labels] } : {}),
    ...(item.author !== undefined ? { author: item.author } : {}),
    created_at: item.created_at,
    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
  })
  const cleanValue = (name: string, raw: unknown): unknown =>
    name === 'workingTree' && record(raw)
      ? { files: (raw.files as FileEntry[]).map(cleanFile) }
      : name === 'branches' && record(raw)
        ? {
            local: (raw.local as ProjectBranch[]).map(cleanBranch),
            remote: (raw.remote as ProjectBranch[]).map(cleanBranch),
            remoteAlias: raw.remoteAlias,
            ...(raw.repository !== undefined ? { repository: raw.repository } : {}),
          }
        : name === 'commits' && Array.isArray(raw)
          ? raw.map((item) => cleanCommit(item as Commit))
          : name === 'branchLogs' && record(raw)
            ? Object.fromEntries(
                Object.entries(raw).map(([branchName, entries]) => [
                  branchName,
                  (entries as Commit[]).map(cleanCommit),
                ]),
              )
            : name === 'github' && record(raw)
              ? {
                  status: raw.status,
                  pullRequests: (raw.pullRequests as PullRequest[]).map(cleanPull),
                  issues: (raw.issues as Issue[]).map(cleanIssue),
                }
              : raw
  const capabilities = Object.fromEntries(
    Object.entries(value.capabilities).map(([name, raw]) => {
      const cap = raw as {
        status: CapabilityStatus
        stale: boolean
        source: 'local_git' | 'github'
        observedAt: string
        generation: number
        errorCode?: string | null
        staleSince?: string
        value: unknown
      }
      return [
        name,
        {
          status: cap.status,
          stale: cap.stale,
          source: cap.source,
          observedAt: cap.observedAt,
          generation: cap.generation,
          ...(cap.errorCode !== undefined ? { errorCode: cap.errorCode } : {}),
          ...(cap.staleSince !== undefined ? { staleSince: cap.staleSince } : {}),
          value: cleanValue(name, cap.value),
        },
      ]
    }),
  )
  return {
    schemaVersion: 1,
    project_id: value.project_id,
    project: {
      name: value.project.name,
      ...(value.project.repository !== undefined ? { repository: value.project.repository } : {}),
    },
    snapshotId: value.snapshotId,
    ...(value.head !== undefined ? { head: value.head } : {}),
    observedAt: value.observedAt,
    refreshing: value.refreshing,
    ...(value.lastUpdated !== undefined ? { lastUpdated: value.lastUpdated } : {}),
    fingerprints: { ...value.fingerprints },
    capabilities,
    workingTree: { files: value.workingTree.files.map(cleanFile) },
    branches: {
      local: value.branches.local.map(cleanBranch),
      remote: value.branches.remote.map(cleanBranch),
      remoteAlias: value.branches.remoteAlias,
      ...(value.branches.repository !== undefined ? { repository: value.branches.repository } : {}),
    },
    commits: value.commits.map(cleanCommit),
    fileDiffs: Object.fromEntries(Object.entries(value.fileDiffs).map(([path, diff]) => [path, diff])),
    branchLogs: Object.fromEntries(
      Object.entries(value.branchLogs).map(([name, items]) => [name, items.map(cleanCommit)]),
    ),
    github: {
      status: value.github.status,
      pullRequests: value.github.pullRequests.map(cleanPull),
      issues: value.github.issues.map(cleanIssue),
    },
    ...(value.focusDefaults !== undefined
      ? {
          focusDefaults: {
            kind: value.focusDefaults.kind,
            ...(value.focusDefaults.value !== undefined ? { value: value.focusDefaults.value } : {}),
          },
        }
      : {}),
    ...(value.warnings !== undefined ? { warnings: [...value.warnings] } : {}),
    ...(value.localStatus !== undefined ? { localStatus: value.localStatus } : {}),
    ...(value.processInstanceId !== undefined ? { processInstanceId: value.processInstanceId } : {}),
    ...(value.registryEpoch !== undefined ? { registryEpoch: value.registryEpoch } : {}),
    ...(value.localGeneration !== undefined ? { localGeneration: value.localGeneration } : {}),
    ...(value.contextIdentity !== undefined ? { contextIdentity: value.contextIdentity } : {}),
  }
}

const treeEntry = (value: unknown): value is TreeEntry =>
  hasRequiredKeys(value, ['name', 'path', 'type'], ['name', 'path', 'type']) &&
  string(value.name, 256) &&
  string(value.path, 1024) &&
  pathDepth(value.path) &&
  relativePath(value.path) &&
  (value.type === 'dir' || value.type === 'file')

export const validTree = (value: unknown): value is TreeResponse =>
  hasRequiredKeys(value, ['path', 'entries', 'truncated'], ['path', 'entries', 'truncated']) &&
  string(value.path, 1024) &&
  pathDepth(value.path) &&
  relativePath(value.path) &&
  boundedArray(value.entries, MAX_FILES, treeEntry) &&
  typeof value.truncated === 'boolean'

const plansPath = (value: unknown, allowEmpty = false): value is string =>
  typeof value === 'string' &&
  value.length <= 1024 &&
  ((value === '' || value === '.') ? allowEmpty : value.split('/').length <= 32 && relativePath(value) &&
    value.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.') && !segment.includes('\\') && !/[\x00-\x1f]/.test(segment)))
const markdownPath = (value: unknown): value is string =>
  plansPath(value) && /\.(?:md|markdown)$/i.test(value)

export const validPlansTree = (value: unknown): value is TreeResponse =>
  hasRequiredKeys(value, ['path', 'entries', 'truncated'], ['path', 'entries', 'truncated']) &&
  plansPath(value.path, true) &&
  boundedArray(value.entries, MAX_FILES, (entry): entry is TreeEntry =>
    treeEntry(entry) &&
    !entry.name.startsWith('.') &&
    plansPath(entry.path) &&
    (entry.type === 'dir' || markdownPath(entry.path)) &&
    entry.path.split('/').at(-1) === entry.name,
  ) &&
  typeof value.truncated === 'boolean'

export const validPlansFile = (value: unknown): value is FileResponse =>
  hasRequiredKeys(value, ['path', 'size', 'content', 'truncated', 'binary'], ['path', 'size', 'content', 'truncated', 'binary']) &&
  markdownPath(value.path) &&
  nonNegativeInteger(value.size) &&
  value.size <= MAX_FILE_BYTES &&
  typeof value.content === 'string' &&
  utf8Length(value.content) <= MAX_FILE_BYTES &&
  value.truncated === false &&
  value.binary === false

export const validFileContent = (value: unknown): value is FileResponse =>
  hasRequiredKeys(value, ['path', 'size', 'truncated', 'binary'], ['path', 'size', 'content', 'truncated', 'binary']) &&
  string(value.path, 1024) &&
  pathDepth(value.path) &&
  relativePath(value.path) &&
  nonNegativeInteger(value.size) &&
  typeof value.truncated === 'boolean' &&
  typeof value.binary === 'boolean' &&
  (value.content === undefined || (typeof value.content === 'string' && utf8Length(value.content) <= MAX_FILE_BYTES))

export const validFileRaw = (value: unknown): value is FileRawResponse =>
  hasRequiredKeys(
    value,
    ['path', 'contentType', 'size', 'contentBase64', 'truncated'],
    ['path', 'contentType', 'size', 'contentBase64', 'truncated'],
  ) &&
  string(value.path, 1024) &&
  pathDepth(value.path) &&
  relativePath(value.path) &&
  string(value.contentType, 128) &&
  nonNegativeInteger(value.size) &&
  value.size <= MAX_FILE_BYTES &&
  typeof value.contentBase64 === 'string' &&
  value.contentBase64.length > 0 &&
  value.contentBase64.length <= MAX_FILE_BYTES * 2 &&
  value.truncated === false

export const projectsApi = {
  async catalog(): Promise<ProjectSummary[]> {
    const data = await request<unknown>('/catalog')
    if (!boundedArray(data, MAX_PROJECTS, project)) throw new ApiError('INVALID_RESPONSE')
    return data
      .filter((item) => item.enabled)
      .map(({ project_id, name, enabled, remote, default_branch, repository }) => ({
        project_id,
        name,
        enabled,
        remote,
        default_branch,
        repository,
      }))
  },
  async snapshot(projectId: string, recovery = false): Promise<Snapshot> {
    const data = await request<unknown>(
      `/snapshot?project_id=${encodeURIComponent(projectId)}${recovery ? '&recovery=true' : ''}`,
    )
    if (!validSnapshot(data, projectId)) throw new ApiError('INVALID_RESPONSE')
    return cleanSnapshot(data)
  },
  async commit(projectId: string, commitId: string, snapshot: Snapshot): Promise<CommitDetail> {
    const data = await request<unknown>(
      `/commit?project_id=${encodeURIComponent(projectId)}&commit=${encodeURIComponent(commitId)}&local_generation=${snapshot.localGeneration ?? ''}&processInstanceId=${encodeURIComponent(snapshot.processInstanceId ?? '')}&registryEpoch=${snapshot.registryEpoch ?? ''}&contextIdentity=${encodeURIComponent(snapshot.contextIdentity ?? '')}&snapshotId=${encodeURIComponent(snapshot.snapshotId)}`,
    )
    if (!validCommitDetail(data) || data.hash.toLowerCase() !== commitId.toLowerCase())
      throw new ApiError('INVALID_RESPONSE')
    return {
      hash: data.hash,
      subject: data.subject,
      author: data.author,
      date: data.date,
      files: data.files.map((item) => ({
        path: item.path,
        additions: item.additions,
        deletions: item.deletions,
        binary: item.binary,
      })),
      diff: data.diff,
    }
  },
  async pullRequest(projectId: string, number: number, snapshot: Snapshot): Promise<PullRequestDetail> {
    const data = await request<unknown>(
      `/pull-request?project_id=${encodeURIComponent(projectId)}&pull_request=${number}&local_generation=${snapshot.localGeneration ?? ''}&processInstanceId=${encodeURIComponent(snapshot.processInstanceId ?? '')}&registryEpoch=${snapshot.registryEpoch ?? ''}&contextIdentity=${encodeURIComponent(snapshot.contextIdentity ?? '')}&snapshotId=${encodeURIComponent(snapshot.snapshotId)}`,
    )
    if (!validPullRequestDetail(data, snapshot.project.repository) || data.number !== number)
      throw new ApiError('INVALID_RESPONSE')
    return {
      ...data,
      labels: [...data.labels],
      reviewers: [...data.reviewers],
      assignees: [...data.assignees],
      checks: data.checks.map((check) => ({
        name: check.name,
        status: check.status,
        ...(check.conclusion !== undefined ? { conclusion: check.conclusion } : {}),
      })),
    }
  },
  async switchBranch(projectId: string, branchName: string): Promise<{ verified: true; generation: number }> {
    const result = await request<unknown>('/branch/switch', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, branch: branchName }),
    })
    if (!validMutationResponse(result, projectId, branchName, false)) throw new ApiError('INVALID_MUTATION_RESPONSE')
    return result
  },
  async createBranch(projectId: string, name: string): Promise<{ verified: true; generation: number }> {
    const result = await request<unknown>('/branch/create', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, name }),
    })
    if (!validMutationResponse(result, projectId, name, true)) throw new ApiError('INVALID_MUTATION_RESPONSE')
    return result
  },
  async tree(projectId: string, path = ''): Promise<TreeResponse> {
    const suffix = path ? `&path=${encodeURIComponent(path)}` : ''
    const data = await request<unknown>(`/tree?project_id=${encodeURIComponent(projectId)}${suffix}`)
    if (!validTree(data)) throw new ApiError('INVALID_RESPONSE')
    return data
  },
  async readFile(projectId: string, path: string): Promise<FileResponse> {
    const data = await request<unknown>(`/file?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`)
    if (!validFileContent(data)) throw new ApiError('INVALID_RESPONSE')
    return data
  },
  async plansTree(projectId: string, path = ''): Promise<TreeResponse> {
    const suffix = path ? `&path=${encodeURIComponent(path)}` : ''
    const data = await request<unknown>(`/plans/tree?project_id=${encodeURIComponent(projectId)}${suffix}`)
    if (!validPlansTree(data)) throw new ApiError('INVALID_RESPONSE')
    return data
  },
  async plansFile(projectId: string, path: string): Promise<FileResponse> {
    const data = await request<unknown>(`/plans/file?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`)
    if (!validPlansFile(data)) throw new ApiError('INVALID_RESPONSE')
    return data
  },
  async fileRaw(projectId: string, path: string): Promise<Blob> {
    // Dedicated transport: returns a Blob, not the JSON envelope data.
    // request() unwraps {ok,data,meta} and would lose the raw byte stream.
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const headers = new Headers()
      headers.set('Accept', 'application/json')
      const token = window.localStorage.getItem('mission-control-token')
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const response = await fetch(
        `${API_ROOT}/file/raw?project_id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
        { headers, signal: controller.signal },
      )
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw safeError(response, payload)
      const data = unwrap<unknown>(response, payload)
      if (!validFileRaw(data)) throw new ApiError('INVALID_RESPONSE')
      const binaryString = atob(data.contentBase64)
      const bytes = new Uint8Array(binaryString.length)
      for (let index = 0; index < binaryString.length; index += 1) bytes[index] = binaryString.charCodeAt(index)
      return new Blob([bytes], { type: data.contentType })
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (error instanceof DOMException && error.name === 'AbortError')
        throw new ApiError('TIMEOUT', 'The request timed out.')
      throw new ApiError('NETWORK')
    } finally {
      window.clearTimeout(timer)
    }
  },
}
