import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ApiError, validMutationResponse, validSnapshot } from '../api.ts'
import { safeHttpsUrl } from '../models.ts'
import {
  branchTabItems,
  closeSelectorAfterSelection,
  createRouteController,
  focusMode,
  retainLastGood,
  routeLayoutContract,
  selectorOptions,
  treeKeyboardAction,
} from '../routeBehavior.ts'

const cap = (value, source = 'local_git') => ({
  status: 'ready',
  stale: false,
  source,
  observedAt: '2026-09-14T00:00:00Z',
  generation: 1,
  value,
})
const commitValue = (index: number) => {
  const hash = String(index + 1).padStart(40, '0')
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject: `Commit ${index}`,
    author: 'Test',
    date: '2026-09-14T00:00:00Z',
    merge: false,
    refs: [],
    parents: [],
  }
}
const snapshot = () => ({
  schemaVersion: 1,
  project_id: 'demo',
  project: { name: 'Demo', repository: 'org/demo' },
  snapshotId: 'snap-1',
  head: 'a'.repeat(40),
  observedAt: '2026-09-14T00:00:00Z',
  lastUpdated: '2026-09-14T00:00:00Z',
  processInstanceId: 'process-1',
  registryEpoch: 1,
  localGeneration: 1,
  contextIdentity: 'context-1',
  localStatus: 'ready',
  warnings: [],
  refreshing: false,
  fingerprints: {
    HEAD: 'a',
    status: 'b',
    'refs/remotes': 'c',
    'refs/heads': 'd',
    currentBranch: 'e',
    workingTree: 'f',
    branches: 'g',
    commits: 'h',
    local: 'i',
  },
  workingTree: { files: [{ path: 'src/app.ts', status: 'M' }] },
  fileDiffs: { 'src/app.ts': 'diff --git a/src/app.ts b/src/app.ts\\n+change' },
  branchLogs: {
    main: [
      {
        hash: 'a'.repeat(40),
        shortHash: 'aaaaaaa',
        subject: 'Initial',
        author: 'Test',
        date: '2026-09-14T00:00:00Z',
        merge: false,
        refs: [],
        parents: [],
      },
    ],
  },
  branches: {
    local: [{ name: 'main', current: true }],
    remote: [{ name: 'origin/main' }],
    remoteAlias: 'origin',
    repository: 'https://github.com/org/demo.git',
  },
  commits: [
    {
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      subject: 'Initial',
      author: 'Test',
      date: '2026-09-14T00:00:00Z',
      merge: false,
      refs: [],
      parents: [],
    },
  ],
  github: {
    status: 'ready',
    pullRequests: [
      {
        number: 1,
        title: 'Fix',
        url: 'https://github.com/org/demo/pull/1',
        repository: 'org/demo',
        head_repository: 'org/demo',
        base_repository: 'org/demo',
        created_at: '2026-09-14T00:00:00Z',
      },
    ],
    issues: [],
  },
  capabilities: {
    workingTree: cap({ files: [{ path: 'src/app.ts', status: 'M' }] }),
    branches: cap({
      local: [{ name: 'main', current: true }],
      remote: [{ name: 'origin/main' }],
      remoteAlias: 'origin',
      repository: 'https://github.com/org/demo.git',
    }),
    commits: cap([
      {
        hash: 'a'.repeat(40),
        shortHash: 'aaaaaaa',
        subject: 'Initial',
        author: 'Test',
        date: '2026-09-14T00:00:00Z',
        merge: false,
        refs: [],
        parents: [],
      },
    ]),
    branchLogs: cap({
      main: [
        {
          hash: 'a'.repeat(40),
          shortHash: 'aaaaaaa',
          subject: 'Initial',
          author: 'Test',
          date: '2026-09-14T00:00:00Z',
          merge: false,
          refs: [],
          parents: [],
        },
      ],
    }),
    github: cap(
      {
        status: 'ready',
        pullRequests: [
          {
            number: 1,
            title: 'Fix',
            url: 'https://github.com/org/demo/pull/1',
            repository: 'org/demo',
            head_repository: 'org/demo',
            base_repository: 'org/demo',
            created_at: '2026-09-14T00:00:00Z',
          },
        ],
        issues: [],
      },
      'github',
    ),
  },
  focusDefaults: { kind: 'file', value: 'src/app.ts' },
})

test('project selector excludes active and closes exactly once after selection', () => {
  const projects = [
    { project_id: 'active', name: 'Active', enabled: true, remote: 'origin', default_branch: 'main' },
    { project_id: 'other', name: 'Other', enabled: true, remote: 'origin', default_branch: 'main' },
    { project_id: 'other', name: 'Duplicate', enabled: true, remote: 'origin', default_branch: 'main' },
  ]
  assert.deepEqual(
    selectorOptions(projects, 'active').map((item) => item.project_id),
    ['other'],
  )
  assert.equal(closeSelectorAfterSelection(true, 'other', projects), false)
})

test('files tree exposes treeitem keyboard actions and expansion semantics', () => {
  const folder = { path: 'src', label: 'src', depth: 0, kind: 'folder' }
  const file = { path: 'src/app.ts', label: 'app.ts', depth: 1, kind: 'file' }
  assert.equal(treeKeyboardAction(folder, 'ArrowRight', false), 'expand')
  assert.equal(treeKeyboardAction(folder, 'ArrowLeft', true), 'collapse')
  assert.equal(treeKeyboardAction(file, 'Enter', true), 'activate')
  assert.equal(treeKeyboardAction(file, 'ArrowDown', true), 'next')
})

test('local and remote branch tabs select only their own items', () => {
  const local = [{ name: 'main' }]
  const remote = [{ name: 'origin/main' }]
  assert.deepEqual(branchTabItems('local', local, remote), local)
  assert.deepEqual(branchTabItems('remote', local, remote), remote)
})

test('focus modes distinguish file diff, branch log, and commit detail', () => {
  assert.equal(focusMode({ kind: 'file', value: 'a.ts' }), 'file-diff')
  assert.equal(focusMode({ kind: 'branch', value: 'main' }), 'branch-log')
  assert.equal(focusMode({ kind: 'commit', value: 'abc' }), 'commit-detail')
})

test('nested capability payloads and focus defaults are validated by key', () => {
  const good = snapshot()
  assert.equal(validSnapshot(good, 'demo'), true)
  const malformed = snapshot()
  malformed.capabilities.branches.value = { local: 'not-an-array', remote: [] }
  assert.equal(validSnapshot(malformed, 'demo'), false)
  const badFocus = snapshot()
  badFocus.focusDefaults = { kind: 'unknown', value: 'x' }
  assert.equal(validSnapshot(badFocus, 'demo'), false)
  const divergent = snapshot()
  divergent.capabilities.branchLogs.value = {}
  assert.equal(validSnapshot(divergent, 'demo'), false)
  const invalidStale = snapshot()
  invalidStale.capabilities.commits.stale = true
  assert.equal(validSnapshot(invalidStale, 'demo'), false)
  const missingObservedAt = snapshot()
  delete missingObservedAt.capabilities.commits.observedAt
  assert.equal(validSnapshot(missingObservedAt, 'demo'), false)
  const badCommit = snapshot()
  badCommit.capabilities.commits.value = [{ hash: 'x', subject: 4 }]
  assert.equal(validSnapshot(badCommit, 'demo'), false)
  for (const name of ['workingTree', 'branches', 'commits', 'branchLogs', 'github']) {
    const bad = snapshot()
    bad.capabilities[name].value =
      name === 'commits' ? [{ unexpected: true }] : { ...bad.capabilities[name].value, unexpected: true }
    assert.equal(validSnapshot(bad, 'demo'), false, `${name} malformed value must be rejected`)
  }
  const badCapability = snapshot()
  badCapability.capabilities.github.unexpected = true
  assert.equal(validSnapshot(badCapability, 'demo'), false)
  const badContext = snapshot()
  badContext.fileDiffs['../secret'] = 'unsafe'
  assert.equal(validSnapshot(badContext, 'demo'), false)
  const badBranchLog = snapshot()
  badBranchLog.branchLogs['../main'] = []
  assert.equal(validSnapshot(badBranchLog, 'demo'), false)
})

test('accepts the exact real backend snapshot fixture and preserves link fields', () => {
  const envelope = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../tests/fixtures/contracts/snapshot-real-backend.json', import.meta.url)),
      'utf8',
    ),
  )
  assert.equal(validSnapshot(envelope.data, 'demo'), true)
  assert.equal(envelope.data.branches.remoteAlias, 'origin')
  assert.equal(envelope.data.project.repository, 'https://github.com/example/repo.git')
})

test('all contract fixtures satisfy the frontend snapshot validator', () => {
  for (const name of ['snapshot-ready.json', 'snapshot-partial.json']) {
    const envelope = JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../tests/fixtures/contracts/${name}`, import.meta.url)), 'utf8'),
    )
    assert.equal(validSnapshot(envelope.data, 'demo'), true, name)
  }
})

test('accepts exact branch and branch-log limits and rejects the next item', () => {
  const exactly = snapshot()
  exactly.branches.local = Array.from({ length: 500 }, (_, index) => ({ name: `branch-${index}` }))
  exactly.capabilities.branches.value.local = exactly.branches.local
  exactly.branchLogs = { main: Array.from({ length: 100 }, (_, index) => commitValue(index)) }
  exactly.capabilities.branchLogs.value = exactly.branchLogs
  assert.equal(validSnapshot(exactly, 'demo'), true)

  const tooManyBranches = structuredClone(exactly)
  tooManyBranches.branches.remote = Array.from({ length: 501 }, (_, index) => ({ name: `origin/branch-${index}` }))
  tooManyBranches.capabilities.branches.value.remote = tooManyBranches.branches.remote
  assert.equal(validSnapshot(tooManyBranches, 'demo'), false)

  const tooManyCommits = structuredClone(exactly)
  tooManyCommits.branchLogs.main = [
    ...tooManyCommits.branchLogs.main,
    { hash: 'f'.repeat(40), subject: 'overflow', parents: [] },
  ]
  tooManyCommits.capabilities.branchLogs.value = tooManyCommits.branchLogs
  assert.equal(validSnapshot(tooManyCommits, 'demo'), false)
})

test('mutation acknowledgements are exact and verified', () => {
  assert.equal(validMutationResponse({ verified: true, generation: 2 }), true)
  assert.equal(validMutationResponse({ verified: false, generation: 2 }), false)
  assert.equal(validMutationResponse({ verified: true, generation: 2, extra: true }), false)
  assert.equal(validMutationResponse({ verified: true, generation: -1 }), false)
})

test('pull request links accept only external HTTPS URLs', () => {
  assert.equal(safeHttpsUrl('https://github.com/org/demo/pull/1'), 'https://github.com/org/demo/pull/1')
  assert.equal(safeHttpsUrl('javascript:alert(1)'), undefined)
  assert.equal(safeHttpsUrl('/internal/pr/1'), undefined)
  assert.equal(safeHttpsUrl('https://user:pass@example.com/pr'), undefined)
})

test('refresh errors retain last-known-good and layout has one route scroll owner', () => {
  const good = snapshot()
  assert.equal(retainLastGood(good, undefined, true), good)
  assert.equal(retainLastGood(good, { ...good, snapshotId: 'snap-2' }, false).snapshotId, 'snap-2')
  assert.deepEqual(routeLayoutContract(), {
    scrollOwner: 'route',
    horizontalOverflow: 'hidden',
    mobileOrder: ['selector', 'files', 'branches', 'commits', 'github', 'mutation', 'context'],
  })
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}
const routeApi = (snapshots, overrides = {}) => ({
  catalog: async () => [
    {
      project_id: 'demo',
      name: 'Demo',
      enabled: true,
      remote: 'origin',
      default_branch: 'main',
      repository: 'imbundle/mc-project-plugin',
    },
    { project_id: 'other', name: 'Other', enabled: true, remote: 'origin', default_branch: 'main', repository: null },
  ],
  snapshot: async (id) => snapshots[id],
  commit: async () => ({ detail: true }),
  pullRequest: async () => ({ detail: true }),
  switchBranch: async () => ({ verified: true, generation: 2 }),
  createBranch: async () => ({ verified: true, generation: 2 }),
  tree: async () => ({ path: '', entries: [], truncated: false }),
  readFile: async () => ({ path: 'x', size: 1, content: 'x', truncated: false, binary: false }),
  plansTree: async () => ({ path: '', entries: [], truncated: false }),
  plansFile: async () => ({ path: 'README.md', size: 1, content: '# plan', truncated: false, binary: false }),
  ...overrides,
})

test('the route controller path performs selection, stale response guarding, focus and last-good refresh', async () => {
  const first = snapshot()
  const second = { ...snapshot(), project_id: 'other', snapshotId: 'other-1' }
  const pending = deferred()
  let demoReads = 0
  const api = routeApi(
    { demo: first, other: second },
    { snapshot: async (id) => (id === 'demo' ? (demoReads++ === 0 ? first : pending.promise) : second) },
  )
  const controller = createRouteController(api)
  await controller.mount()
  assert.equal(controller.getState().activeId, 'demo')
  const staleRefresh = controller.refresh()
  await controller.selectProject('other')
  pending.resolve(first)
  await staleRefresh
  assert.equal(controller.getState().activeId, 'other')
  assert.equal(controller.getState().snapshot?.project_id, 'other')
  await controller.selectFocus({ kind: 'branch', value: 'main' })
  assert.equal(controller.getState().focus?.kind, 'branch')
  const failing = createRouteController(
    routeApi(
      { demo: first },
      {
        snapshot: async () => {
          throw new Error('offline')
        },
      },
    ),
  )
  await failing.mount()
  assert.equal(failing.getState().snapshot, undefined)
  assert.equal(failing.getState().error?.code, 'NETWORK')
})

test('the route controller requires exact mutation acknowledgement and read-back before replacing state', async () => {
  const original = snapshot()
  const updated = { ...original, snapshotId: 'snap-2' }
  let reads = 0
  const badAck = createRouteController(
    routeApi(
      { demo: original },
      {
        switchBranch: async () => ({ verified: true, generation: 2, extra: true }),
        snapshot: async () => {
          reads += 1
          return reads === 1 ? original : updated
        },
      },
    ),
  )
  await badAck.mount()
  await badAck.mutate('switch', 'next')
  assert.equal(reads, 2)
  assert.equal(badAck.getState().snapshot?.snapshotId, 'snap-2')
  assert.match(badAck.getState().mutationMessage, /indeterminate/i)
  let readBackReads = 0
  const readBackFails = createRouteController(
    routeApi(
      { demo: original },
      {
        snapshot: async () => {
          readBackReads += 1
          if (readBackReads === 1) return original
          throw new Error('readback down')
        },
      },
    ),
  )
  await readBackFails.mount()
  await readBackFails.mutate('switch', 'next')
  assert.equal(readBackFails.getState().snapshot?.snapshotId, 'snap-1')
  assert.match(readBackFails.getState().mutationMessage, /indeterminate/i)
})

test('validation errors do not trigger mutation recovery', async () => {
  const original = snapshot()
  let reads = 0
  const rejected = createRouteController(
    routeApi(
      { demo: original },
      {
        snapshot: async () => {
          reads += 1
          return original
        },
        switchBranch: async () => {
          throw new ApiError('INVALID_BRANCH_NAME', 'Invalid branch name.', 400)
        },
      },
    ),
  )
  await rejected.mount()
  await rejected.mutate('switch', 'bad branch')
  assert.equal(reads, 1)
  assert.equal(rejected.getState().mutation, false)
  assert.equal(rejected.getState().mutationBusy, false)
  assert.equal(rejected.getState().error?.code, 'INVALID_BRANCH_NAME')
  assert.equal(rejected.getState().mutationMessage, 'Invalid branch name.')
})

test('server indeterminate mutation errors still trigger recovery', async () => {
  const original = snapshot()
  const recovered = { ...original, snapshotId: 'snap-recovered' }
  let reads = 0
  const indeterminate = createRouteController(
    routeApi(
      { demo: original },
      {
        snapshot: async () => {
          reads += 1
          return reads === 1 ? original : recovered
        },
        switchBranch: async () => {
          throw new ApiError('READBACK_MISMATCH', 'Mutation read-back did not confirm the requested branch.', 409)
        },
      },
    ),
  )
  await indeterminate.mount()
  await indeterminate.mutate('switch', 'next')
  assert.equal(reads, 2)
  assert.equal(indeterminate.getState().snapshot?.snapshotId, 'snap-recovered')
  assert.equal(indeterminate.getState().mutationMessage, 'Mutation indeterminate; state reconciled.')
})

test('same-project refresh generations reject an older response', async () => {
  const original = snapshot()
  const newer = { ...original, snapshotId: 'snap-new' }
  const oldRead = deferred()
  const newRead = deferred()
  let reads = 0
  const controller = createRouteController(
    routeApi(
      { demo: original },
      {
        snapshot: async () => {
          reads += 1
          return reads === 1 ? original : reads === 2 ? oldRead.promise : newRead.promise
        },
      },
    ),
  )
  await controller.mount()
  const older = controller.refresh()
  const latest = controller.refresh()
  newRead.resolve(newer)
  await latest
  oldRead.resolve({ ...original, snapshotId: 'snap-old' })
  await older
  assert.equal(controller.getState().snapshot?.snapshotId, 'snap-new')
})

test('#28 mode defaults to git and setMode switches and clears code state', async () => {
  const controller = createRouteController(routeApi({ demo: snapshot() }))
  await controller.mount()
  assert.equal(controller.getState().mode, 'git')
  controller.setMode('code')
  assert.equal(controller.getState().mode, 'code')
  controller.setMode('git')
  assert.equal(controller.getState().mode, 'git')
  assert.equal(controller.getState().codePath, undefined)
  assert.equal(controller.getState().codeFile, undefined)
})

test('#28 selectProject resets mode to git and discards code state', async () => {
  const first = snapshot()
  const controller = createRouteController(routeApi({ demo: first, other: { ...first, project_id: 'other', snapshotId: 'o' } }))
  await controller.mount()
  controller.setMode('code')
  await controller.openCodeFile('src/app.ts')
  assert.equal(controller.getState().mode, 'code')
  assert.equal(controller.getState().codePath, 'src/app.ts')
  await controller.selectProject('other')
  assert.equal(controller.getState().mode, 'git')
  assert.equal(controller.getState().codePath, undefined)
  assert.equal(controller.getState().codeFile, undefined)
  assert.equal(controller.getState().activeId, 'other')
})

test('#28 openCodeFile loads the file and surfaces errors', async () => {
  const okController = createRouteController(
    routeApi(
      { demo: snapshot() },
      { readFile: async () => ({ path: 'src/app.ts', size: 2, content: 'hi', truncated: false, binary: false }) },
    ),
  )
  await okController.mount()
  okController.setMode('code')
  await okController.openCodeFile('src/app.ts')
  assert.equal(okController.getState().codeFile?.content, 'hi')
  assert.equal(okController.getState().codeLoading, false)
  const failController = createRouteController(
    routeApi(
      { demo: snapshot() },
      {
        readFile: async () => {
          throw new ApiError('NOT_FOUND', 'File not found.', 404)
        },
      },
    ),
  )
  await failController.mount()
  failController.setMode('code')
  await failController.openCodeFile('missing.ts')
  assert.equal(failController.getState().codeError?.code, 'NOT_FOUND')
  assert.equal(failController.getState().codeLoading, false)
})

test('#28 openCodeFile is a no-op without an active project or outside code mode', async () => {
  let calls = 0
  const controller = createRouteController(
    routeApi(
      { demo: snapshot() },
      {
        readFile: async () => {
          calls += 1
          return { path: 'x', size: 1, content: 'x', truncated: false, binary: false }
        },
      },
    ),
  )
  await controller.mount()
  await controller.openCodeFile('src/app.ts')
  assert.equal(calls, 0)
  controller.setMode('code')
  await controller.openCodeFile('src/app.ts')
  assert.equal(calls, 1)
})

test('Plans selection loads a read-only Markdown file and mode/project changes clear it', async () => {
  const original = snapshot()
  const controller = createRouteController(
    routeApi({ demo: original, other: { ...original, project_id: 'other' } }),
  )
  await controller.mount()
  controller.setMode('plans')
  await controller.openPlanFile('plans/README.md')
  assert.equal(controller.getState().mode, 'plans')
  assert.equal(controller.getState().planPath, 'plans/README.md')
  assert.equal(controller.getState().planFile?.content, '# plan')
  controller.setMode('code')
  assert.equal(controller.getState().planPath, undefined)
  assert.equal(controller.getState().planFile, undefined)
  controller.setMode('plans')
  await controller.openPlanFile('plans/README.md')
  await controller.selectProject('other')
  assert.equal(controller.getState().mode, 'git')
  assert.equal(controller.getState().planPath, undefined)
  assert.equal(controller.getState().planFile, undefined)
})

test('a Plans file response from the previous project cannot overwrite the newly selected project', async () => {
  const pending = deferred()
  const first = snapshot()
  const second = { ...first, project_id: 'other', snapshotId: 'other-snapshot' }
  const controller = createRouteController(
    routeApi({ demo: first, other: second }, { plansFile: async () => pending.promise }),
  )
  await controller.mount()
  controller.setMode('plans')
  const inflight = controller.openPlanFile('README.md')
  await controller.selectProject('other')
  pending.resolve({ path: 'README.md', size: 4, content: 'stale', truncated: false, binary: false })
  await inflight
  assert.equal(controller.getState().activeId, 'other')
  assert.equal(controller.getState().mode, 'git')
  assert.equal(controller.getState().planFile, undefined)
})

test('a stale Plans file response cannot repopulate state after leaving Plans mode', async () => {
  const pending = deferred()
  const controller = createRouteController(
    routeApi({ demo: snapshot() }, { plansFile: async () => pending.promise }),
  )
  await controller.mount()
  controller.setMode('plans')
  const inflight = controller.openPlanFile('README.md')
  controller.setMode('git')
  pending.resolve({ path: 'README.md', size: 4, content: 'stale', truncated: false, binary: false })
  await inflight
  assert.equal(controller.getState().mode, 'git')
  assert.equal(controller.getState().planFile, undefined)
})

test('#28 a stale readFile response cannot repopulate code state after switching to git', async () => {
  let resolveRead
  const pending = new Promise((resolve) => {
    resolveRead = resolve
  })
  const controller = createRouteController(
    routeApi(
      { demo: snapshot() },
      {
        readFile: async () =>
          pending.then(() => ({ path: 'src/app.ts', size: 2, content: 'stale', truncated: false, binary: false })),
      },
    ),
  )
  await controller.mount()
  controller.setMode('code')
  const inflight = controller.openCodeFile('src/app.ts')
  controller.setMode('git')
  resolveRead()
  await inflight
  assert.equal(controller.getState().mode, 'git')
  assert.equal(controller.getState().codeFile, undefined)
})
