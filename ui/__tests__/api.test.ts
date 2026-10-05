import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import {
  ApiError,
  projectsApi,
  validCommitDetail,
  validFileRaw,
  validPullRequestDetail,
  validIssue,
  validPullRequest,
  validPlansFile,
  validPlansTree,
  validSnapshot,
} from '../api.ts'

const browser = new Window({ url: 'http://localhost/mc-project-plugin' })
Object.assign(globalThis, { window: browser, DOMException: browser.DOMException })

const commitDetail = {
  hash: 'a'.repeat(40),
  subject: 'Initial',
  author: 'Test',
  date: '2026-09-14T10:00:00Z',
  files: [{ path: 'src/app.ts', additions: 1, deletions: 0, binary: false }],
  diff: 'diff --git a/src/app.ts b/src/app.ts',
}
const pullRequestDetail = {
  number: 1,
  title: 'Fix route',
  url: 'https://github.com/example/repo/pull/1',
  description: 'Details',
  author: 'davide',
  labels: [],
  reviewers: [],
  assignees: [],
  head: 'feature/ui',
  base: 'main',
  head_repository: 'example/repo',
  base_repository: 'example/repo',
  checks: [],
  created_at: '2026-09-14T10:00:00Z',
  updated_at: '2026-09-14T11:00:00Z',
  draft: false,
}
const snapshot = { project: { repository: 'example/repo' }, snapshotId: 'snap-1' } as never
const ok = (data: unknown) =>
  new Response(
    JSON.stringify({
      ok: true,
      data,
      meta: { schemaVersion: 1, requestId: 'test-request', observedAt: '2026-09-14T10:00:00+00:00' },
    }),
    { status: 200 },
  )
const snapshotFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../tests/fixtures/contracts/snapshot-real-backend.json', import.meta.url)),
    'utf8',
  ),
).data

test('Plans validators accept only safe Markdown tree entries and complete bounded Markdown files', () => {
  const tree = {
    path: '',
    entries: [
      { name: 'subplans', path: 'subplans', type: 'dir' },
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'overview.markdown', path: 'overview.markdown', type: 'file' },
    ],
    truncated: false,
  }
  assert.equal(validPlansTree(tree), true)
  assert.equal(validPlansTree({ ...tree, entries: [...tree.entries, { name: '.hidden.md', path: '.hidden.md', type: 'file' }] }), false)
  assert.equal(validPlansTree({ ...tree, entries: [{ name: 'notes.txt', path: 'notes.txt', type: 'file' }] }), false)
  assert.equal(validPlansTree({ ...tree, entries: [{ name: 'private', path: '.private', type: 'dir' }] }), false)
  const markdown = { path: 'README.md', size: 2, content: '# ok', truncated: false, binary: false }
  assert.equal(validPlansFile(markdown), true)
  assert.equal(validPlansFile({ ...markdown, path: 'notes.txt' }), false)
  assert.equal(validPlansFile({ ...markdown, binary: true }), false)
  assert.equal(validPlansFile({ ...markdown, truncated: true }), false)
  assert.equal(validPlansFile({ ...markdown, size: 262145 }), false)
  assert.equal(validPlansFile({ ...markdown, content: 'x'.repeat(262145) }), false)
})

test('Plans API methods call their dedicated read-only endpoints and validate payloads', async () => {
  const originalFetch = globalThis.fetch
  try {
    const requests: string[] = []
    globalThis.fetch = async (input) => {
      const url = String(input)
      requests.push(url)
      return ok(url.includes('/plans/tree?')
        ? { path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file' }], truncated: false }
        : { path: 'README.md', size: 2, content: '# ok', truncated: false, binary: false })
    }
    assert.equal((await projectsApi.plansTree('demo')).entries[0].name, 'README.md')
    assert.equal((await projectsApi.plansFile('demo', 'README.md')).content, '# ok')
    assert.match(requests[0], /\/projects\/plans\/tree\?project_id=demo$/)
    assert.match(requests[1], /\/projects\/plans\/file\?project_id=demo&path=README.md$/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('detail validators reject unknown, malformed, and unbounded payloads', () => {
  assert.equal(validCommitDetail(commitDetail), true)
  assert.equal(validCommitDetail({ ...commitDetail, extra: true }), false)
  assert.equal(
    validCommitDetail({ ...commitDetail, files: [{ path: '../escape', additions: 1, deletions: 0, binary: false }] }),
    false,
  )
  assert.equal(
    validCommitDetail({ ...commitDetail, files: [{ path: 'src/app.ts', additions: 1, deletions: 0 }] }),
    false,
  )
  assert.equal(
    validCommitDetail({ ...commitDetail, files: [{ path: 'src/app.ts', additions: 1, deletions: 0, binary: 'yes' }] }),
    false,
  )
  assert.equal(
    validCommitDetail({ ...commitDetail, files: [{ path: 'src/app.ts', additions: 0, deletions: 0, binary: true }] }),
    true,
  )
  assert.equal(validPullRequestDetail(pullRequestDetail, 'example/repo'), true)
  assert.equal(validPullRequestDetail({ ...pullRequestDetail, description: '' }, 'example/repo'), true)
  assert.equal(validPullRequestDetail({ ...pullRequestDetail, description: 0 }, 'example/repo'), false)
  assert.equal(
    validPullRequestDetail({ ...pullRequestDetail, description: 'x'.repeat(64 * 1024 + 1) }, 'example/repo'),
    false,
  )
  assert.equal(
    validPullRequestDetail({ ...pullRequestDetail, url: 'https://evil.example/example/repo/pull/1' }, 'example/repo'),
    false,
  )
  assert.equal(validPullRequestDetail({ ...pullRequestDetail, extra: 'reject' }, 'example/repo'), false)
  assert.equal(
    validPullRequestDetail(
      { ...pullRequestDetail, checks: [{ name: 'ci', status: 'completed', extra: true }] },
      'example/repo',
    ),
    false,
  )
})

test('list validators reject unsafe or mismatched GitHub links while allowing absent URLs', () => {
  const pull = {
    number: 7,
    title: 'PR',
    url: 'https://github.com/example/repo/pull/7',
    repository: 'example/repo',
    created_at: '2026-09-14T10:00:00Z',
  }
  const issue = {
    number: 8,
    title: 'Issue',
    url: 'https://github.com/example/repo/issues/8',
    repository: 'example/repo',
    created_at: '2026-09-14T10:00:00Z',
  }
  assert.equal(validPullRequest(pull), true)
  assert.equal(validIssue(issue), true)
  assert.equal(validPullRequest({ ...pull, url: 'https://evil.example/example/repo/pull/7' }), false)
  assert.equal(validPullRequest({ ...pull, url: 'https://github.com/example/repo/issues/7' }), false)
  assert.equal(validPullRequest({ ...pull, url: 'https://github.com/other/repo/pull/7' }), false)
  assert.equal(validPullRequest({ ...pull, url: 'https://github.com/example/repo/pull/8' }), false)
  assert.equal(validIssue({ ...issue, url: 'https://github.com/example/repo/issues/8#unsafe' }), false)
  assert.equal(validIssue({ ...issue, url: undefined }), true)
  assert.equal(validPullRequest({ ...pull, repository: undefined }), false)
})

test('detail API methods reject malformed responses as INVALID_RESPONSE', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      return ok(url.includes('/commit?') ? { ...commitDetail, extra: true } : { ...pullRequestDetail, title: '' })
    }
    await assert.rejects(
      projectsApi.commit('demo', commitDetail.hash, snapshot),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    await assert.rejects(
      projectsApi.pullRequest('demo', 1, snapshot),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('snapshot API preserves capability observedAt during sanitization', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ok(snapshotFixture)
    const loaded = await projectsApi.snapshot('demo')
    assert.equal(loaded.capabilities.branchLogs.observedAt, '2026-09-14T10:00:00+00:00')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('snapshot API preserves staleSince null and rejects invalid stale metadata or oversized diffs', async () => {
  assert.equal(validSnapshot(snapshotFixture, 'demo'), true)
  assert.equal(snapshotFixture.capabilities.branchLogs.staleSince, null)
  const invalid = structuredClone(snapshotFixture)
  invalid.capabilities.branchLogs.staleSince = 'not-a-timestamp'
  assert.equal(validSnapshot(invalid, 'demo'), false)
  const oversized = structuredClone(snapshotFixture)
  oversized.fileDiffs['src/app.ts'] = 'x'.repeat(1024 * 1024 + 1)
  assert.equal(validSnapshot(oversized, 'demo'), false)
  const warnings = structuredClone(snapshotFixture)
  warnings.warnings = ['OUTPUT_LIMIT', 'BRANCH_LOGS_TRUNCATED']
  assert.equal(validSnapshot(warnings, 'demo'), true)
})

test('detail API methods validate and clean accepted responses', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async (input) => ok(String(input).includes('/commit?') ? commitDetail : pullRequestDetail)
    const commit = await projectsApi.commit('demo', commitDetail.hash, snapshot)
    const pull = await projectsApi.pullRequest('demo', 1, snapshot)
    assert.deepEqual(commit, commitDetail)
    assert.deepEqual(pull, pullRequestDetail)
  } finally {
    globalThis.fetch = originalFetch
  }
})

const catalogEntry = (extra: Record<string, unknown> = {}) => ({
  project_id: 'demo',
  name: 'Demo',
  enabled: true,
  remote: 'origin',
  default_branch: 'main',
  ...extra,
})

async function withCatalog<T>(data: unknown, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ok(data)
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('catalog accepts the legacy 5-key envelope without repository (#25)', async () => {
  const projects = await withCatalog([catalogEntry()], () => projectsApi.catalog())
  assert.equal(projects.length, 1)
  assert.equal(projects[0].remote, 'origin')
  assert.equal(projects[0].repository, undefined)
})

test('catalog propagates repository for both owner/repo and null (#25)', async () => {
  const projects = await withCatalog(
    [
      catalogEntry({ repository: 'imbundle/mc-project-plugin' }),
      catalogEntry({ project_id: 'other', repository: null }),
    ],
    () => projectsApi.catalog(),
  )
  assert.deepEqual(
    projects.map(({ project_id, remote, repository }) => ({ project_id, remote, repository })),
    [
      { project_id: 'demo', remote: 'origin', repository: 'imbundle/mc-project-plugin' },
      { project_id: 'other', remote: 'origin', repository: null },
    ],
  )
})

test('catalog rejects a foreign key and a non-string repository (#25)', async () => {
  await assert.rejects(
    withCatalog([catalogEntry({ injected: 'x' })], () => projectsApi.catalog()),
    (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
  )
  await assert.rejects(
    withCatalog([catalogEntry({ repository: 42 })], () => projectsApi.catalog()),
    (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
  )
})

test('catalog still requires a non-empty remote (#25 regression guard)', async () => {
  await assert.rejects(
    withCatalog([catalogEntry({ remote: '' })], () => projectsApi.catalog()),
    (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
  )
})

// ---------------------------------------------------------------------------
// tree / readFile (#27)
// ---------------------------------------------------------------------------

const treeFixture = {
  path: 'ui',
  entries: [
    { name: 'api.ts', path: 'ui/api.ts', type: 'file' },
    { name: 'components', path: 'ui/components', type: 'dir' },
  ],
  truncated: false,
}

test('#27 tree API accepts a valid tree envelope and returns it', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ok(treeFixture)
    const tree = await projectsApi.tree('demo')
    assert.deepEqual(tree, treeFixture)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#27 tree API rejects an oversized entries array (beyond MAX_FILES)', async () => {
  const originalFetch = globalThis.fetch
  try {
    const huge = structuredClone(treeFixture)
    huge.entries = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}`, path: `ui/f${i}`, type: 'file' }))
    globalThis.fetch = async () => ok(huge)
    await assert.rejects(
      projectsApi.tree('demo'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#27 tree API rejects an entry with an unknown type', async () => {
  const originalFetch = globalThis.fetch
  try {
    const badType = structuredClone(treeFixture)
    badType.entries[0].type = 'link'
    globalThis.fetch = async () => ok(badType)
    await assert.rejects(
      projectsApi.tree('demo'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

const fileFixture = {
  path: 'ui/api.ts',
  size: 10,
  content: 'export const',
  truncated: false,
  binary: false,
}

test('#27 readFile API accepts a valid file envelope', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ok(fileFixture)
    const file = await projectsApi.readFile('demo', 'ui/api.ts')
    assert.deepEqual(file, fileFixture)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#27 readFile API accepts binary without content and truncated content at the cap boundary', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      ok({ path: 'bin.dat', size: 64, truncated: false, binary: true })
    const binary = await projectsApi.readFile('demo', 'bin.dat')
    assert.equal(binary.binary, true)
    assert.equal(binary.content, undefined)

    const capped = {
      path: 'big.txt',
      size: 262_144,
      content: 'x'.repeat(262_144),
      truncated: true,
      binary: false,
    }
    globalThis.fetch = async () => ok(capped)
    const file = await projectsApi.readFile('demo', 'big.txt')
    assert.equal(file.truncated, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#27 readFile API rejects content beyond the byte cap and a negative size', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      ok({ path: 'big.txt', size: 262_145, content: 'x'.repeat(262_145), truncated: false, binary: false })
    await assert.rejects(
      projectsApi.readFile('demo', 'big.txt'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
    globalThis.fetch = async () =>
      ok({ path: 'a.txt', size: -1, content: 'x', truncated: false, binary: false })
    await assert.rejects(
      projectsApi.readFile('demo', 'a.txt'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#27 readFile API rejects a response missing truncation/binary flags', async () => {
  const originalFetch = globalThis.fetch
  try {
    const partial = structuredClone(fileFixture)
    delete (partial as Record<string, unknown>).binary
    globalThis.fetch = async () => ok(partial)
    await assert.rejects(
      projectsApi.readFile('demo', 'ui/api.ts'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// fileRaw (#34)
// ---------------------------------------------------------------------------

const fileRawFixture = {
  path: 'img.png',
  contentType: 'image/png',
  size: 4,
  contentBase64: Buffer.from('test', 'utf8').toString('base64'),
  truncated: false,
}

test('#34 validFileRaw accepts an exact valid payload', () => {
  assert.equal(validFileRaw(fileRawFixture), true)
})

test('#34 validFileRaw rejects truncated, extra, negative size, and invalid base64', () => {
  assert.equal(validFileRaw({ ...fileRawFixture, truncated: true }), false)
  assert.equal(validFileRaw({ ...fileRawFixture, extra: true }), false)
  assert.equal(validFileRaw({ ...fileRawFixture, size: -1 }), false)
  assert.equal(validFileRaw({ ...fileRawFixture, size: 262_145 }), false)
  assert.equal(validFileRaw({ ...fileRawFixture, contentBase64: '' }), false)
  assert.equal(validFileRaw({ ...fileRawFixture, contentBase64: 42 }), false)
  assert.equal(validFileRaw({ ...fileRawFixture, path: '../escape.png' }), false)
})

test('#34 fileRaw returns a Blob with the declared content type and bytes', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ok(fileRawFixture)
    const blob = await projectsApi.fileRaw('demo', 'img.png')
    assert.equal(blob.type, 'image/png')
    const decoded = new TextDecoder().decode(await blob.arrayBuffer())
    assert.equal(decoded, 'test')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#34 fileRaw surfaces HTTP errors as ApiError with codes', async () => {
  const originalFetch = globalThis.fetch
  try {
    const errorEnvelope = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status })
    globalThis.fetch = async () => errorEnvelope(413, { error: 'PAYLOAD_TOO_LARGE' })
    await assert.rejects(
      projectsApi.fileRaw('demo', 'big.bin'),
      (error: unknown) => error instanceof ApiError && error.code === 'PAYLOAD_TOO_LARGE',
    )
    globalThis.fetch = async () => errorEnvelope(404, { error: 'NOT_FOUND' })
    await assert.rejects(
      projectsApi.fileRaw('demo', 'missing.bin'),
      (error: unknown) => error instanceof ApiError && error.code === 'NOT_FOUND',
    )
    globalThis.fetch = async () => errorEnvelope(403, { error: 'NOT_ALLOWED' })
    await assert.rejects(
      projectsApi.fileRaw('demo', 'node_modules/x'),
      (error: unknown) => error instanceof ApiError && error.code === 'NOT_ALLOWED',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#34 fileRaw rejects a malformed envelope as INVALID_RESPONSE', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ok({ ...fileRawFixture, contentBase64: 42 })
    await assert.rejects(
      projectsApi.fileRaw('demo', 'img.png'),
      (error: unknown) => error instanceof ApiError && error.code === 'INVALID_RESPONSE',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
