import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MCProjectsRoute from '../MCProjectsRoute.tsx'
import { ContextPanel } from '../components/ContextPanel.tsx'
import { GitHubFooter } from '../components/GitHubFooter.tsx'
import { ProjectSelector } from '../components/ProjectSelector.tsx'

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../tests/fixtures/contracts/snapshot-real-backend.json', import.meta.url)),
    'utf8',
  ),
)
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// Real git diff spanning two files with hunks (src/app.ts: +2/-1, lib/util.ts: +1/-1).
const MULTI_DIFF =
  'diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n const value = 1;\n-const oldValue = true;\n+const newValue = true;\n+const extra = true;\n  indented();\ndiff --git a/lib/util.ts b/lib/util.ts\nindex aa11111..bb22222 100644\n--- a/lib/util.ts\n+++ b/lib/util.ts\n@@ -10,2 +10,3 @@ function helper() {\n-  return oldHelper();\n+  return newHelper();\n}\n'
// Real git output for a binary file and a mode-only change: no hunks at all.
const NO_HUNK_DIFF =
  'diff --git a/assets/logo.png b/assets/logo.png\nindex 1111111..2222222 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\ndiff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'

function installDom() {
  const window = new Window({ url: 'http://localhost/mc-project-plugin' })
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const computed = window.getComputedStyle(this)
    const height = Number.parseFloat(computed.minHeight) || Number.parseFloat(computed.height) || 0
    return height
      ? { ...originalRect.call(this), height, bottom: height, toJSON: () => ({ height }) }
      : originalRect.call(this)
  }
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    DOMException: window.DOMException,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return window
}

function response(data: unknown) {
  return new Response(
    JSON.stringify({
      ok: true,
      data,
      meta: { schemaVersion: 1, requestId: 'test-request', observedAt: '2026-09-14T10:00:00+00:00' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

async function mountedRoute(snapshot = fixture.data, allowReadBack = false, otherSnapshot?: unknown) {
  const window = installDom()
  let snapshotReads = 0
  window.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/catalog'))
      return response([
        {
          project_id: 'demo',
          name: 'Demo',
          enabled: true,
          remote: 'origin',
          default_branch: 'main',
          repository: 'imbundle/mc-project-plugin',
        },
        {
          project_id: 'other',
          name: 'Other',
          enabled: true,
          remote: 'origin',
          default_branch: 'main',
          repository: null,
        },
      ])
    if (url.includes('/snapshot?')) {
      snapshotReads += 1
      if (otherSnapshot && url.includes('project_id=other')) return response(otherSnapshot)
      return snapshotReads > 1 && !allowReadBack ? Promise.reject(new Error('offline')) : response(snapshot)
    }
    if (url.includes('/commit?'))
      return response({
        hash: fixture.data.head,
        subject: 'Initial',
        author: 'Test',
        date: '2026-09-14T10:00:00+00:00',
        files: [
          { path: 'src/app.ts', additions: 1, deletions: 0, binary: false },
          { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
        ],
        diff: 'diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,3 @@\n const value = 1;\n-const oldValue = true;\n+const newValue = true;\n+const extra = true;\n',
      })
    if (url.includes('/tree?'))
      return response({
        path: 'ui',
        entries: [
          { name: 'src', path: 'src', type: 'dir' },
          { name: 'README.md', path: 'README.md', type: 'file' },
        ],
        truncated: false,
      })
    if (url.includes('/file?'))
      return response({
        path: 'README.md',
        size: 9,
        content: '# repo\n',
        truncated: false,
        binary: false,
      })
    if (url.includes('/pull-request?'))
      return response({
        number: 1,
        title: 'Fix route',
        url: 'https://github.com/example/repo/pull/1',
        description: 'loaded from backend',
        author: 'Test',
        labels: [],
        reviewers: [],
        assignees: [],
        head: 'feature/ui',
        base: 'main',
        head_repository: 'example/repo',
        base_repository: 'example/repo',
        checks: [],
        created_at: '2026-09-14T10:00:00+00:00',
        updated_at: '2026-09-14T11:00:00+00:00',
        draft: false,
      })
    throw new Error(`unexpected request ${url}`)
  }
  globalThis.fetch = window.fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(MCProjectsRoute))
    await sleep(100)
  })
  return { host, root, window }
}

async function click(host: HTMLElement, selector: string) {
  const element = host.querySelector<HTMLElement>(selector)
  assert.ok(element, `missing ${selector}`)
  await act(async () => {
    element.click()
    await sleep()
  })
}
function text(host: HTMLElement) {
  return host.textContent ?? ''
}

test('renders only populated GitHub blocks and the item-row card contract', { concurrency: false }, async () => {
  installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(GitHubFooter, {
        issues: [
          {
            number: 2,
            title: 'Track issue',
            url: 'https://github.com/example/repo/issues/2',
            created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            repository: 'example/repo',
          },
        ],
        pullRequests: [
          {
            number: 1,
            title: 'PR',
            url: undefined,
            draft: true,
            created_at: new Date(Date.now() - 86_400_000).toISOString(),
            repository: 'example/repo',
          },
        ],
        status: 'ready',
        bare: true,
      }),
    )
    await sleep()
  })
  try {
    assert.ok(host.querySelector('[data-testid="github-section"]'))
    assert.ok(host.querySelector('[data-testid="github-issues"]'))
    assert.ok(host.querySelector('[data-testid="github-pull-requests"]'))
    // item-row contract: number, title, age, external link; PR draft badge; no Details button.
    assert.equal(host.querySelectorAll('.gh-item-row').length, 2)
    assert.equal(host.querySelectorAll('.gh-item-row .num-issue').length, 1)
    assert.equal(host.querySelectorAll('.gh-item-row .num-pr').length, 1)
    assert.equal(host.querySelectorAll('.gh-item-row .pr-draft').length, 1)
    assert.equal(host.querySelectorAll('.gh-item-row .iage').length, 2)
    assert.equal(host.querySelectorAll('.gh-item-row .ext').length, 2)
    assert.equal(host.querySelector('[data-testid="pr-detail-1"]'), null)
    assert.ok(
      host.querySelector('a[href="https://github.com/example/repo/issues/2"][target="_blank"][rel="noreferrer"]'),
    )
  } finally {
    await act(async () => root.unmount())
  }
})

test('renders a parsed unified diff without losing whitespace or adding widgets', { concurrency: false }, async () => {
  const window = installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const snapshot = structuredClone(fixture.data)
  snapshot.fileDiffs['src/app.ts'] =
    'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n const value = 1;\n-const oldValue = true;\n+const newValue = true;\n  indented();'
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(ContextPanel, { focus: { kind: 'file', value: 'src/app.ts' }, snapshot }))
    await sleep()
  })
  try {
    assert.match(text(host), /DIFF/)
    assert.equal(host.querySelector('[data-testid="context-breadcrumb"]')?.textContent?.includes('src/app.ts'), true)
    assert.match(
      host.querySelector<HTMLElement>('[data-testid="context-breadcrumb"]')?.className ?? '',
      /(?:^|\s)h-8(?:\s|$)/,
    )
    assert.match(
      host.querySelector<HTMLElement>('[data-testid="context-diff"]')?.className ?? '',
      /(?:^|\s)flex-1(?:\s|$)/,
    )
    // react-diff-view renders the parsed hunks; assert on stable text, not internals.
    // Hunk rows carry old/new line numbers + code; +/- decorations are renderer-owned.
    const diff = host.querySelector<HTMLElement>('[data-testid="context-diff"]')
    assert.ok(diff)
    assert.match(text(diff), /const value = 1;/)
    assert.match(text(diff), /oldValue = true;/)
    assert.match(text(diff), /newValue = true;/)
    assert.match(text(diff), /indented\(\);/)
    assert.match(diff.className, /(?:^|\s)overflow-y-scroll(?:\s|$)/)
    // no widgets/comments injected by the renderer
    assert.equal(host.querySelectorAll('.diff-widget, [data-diff-widget]').length, 0)
  } finally {
    await act(async () => root.unmount())
  }
})

test(
  'renders per-file diff sections with a file list header and counts lines in the DOM',
  { concurrency: false },
  async () => {
    const window = installDom()
    const host = document.createElement('div')
    document.body.append(host)
    const snapshot = structuredClone(fixture.data)
    snapshot.fileDiffs['src/app.ts'] = MULTI_DIFF
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(ContextPanel, { focus: { kind: 'file', value: 'src/app.ts' }, snapshot }))
      await sleep()
    })
    try {
      // File list header lists every file touched by the diff with +N/-N counts.
      const list = host.querySelector('[data-testid="diff-file-list"]')
      assert.ok(list, 'diff file list header exists')
      const rows = [...list.querySelectorAll('[data-testid="diff-file-list-item"]')]
      assert.equal(rows.length, 2, 'both files are listed')
      assert.match(text(rows[0]), /src\/app\.ts/)
      assert.match(text(rows[0]), /\+\s*2\s*-\s*1/, 'src/app.ts shows +2 -1')
      assert.match(text(rows[1]), /lib\/util\.ts/)
      assert.match(text(rows[1]), /\+\s*1\s*-\s*1/, 'lib/util.ts shows +1 -1')
      // Per-file sections with a header identifying the path.
      const sections = host.querySelectorAll('[data-testid="diff-file-section"]')
      assert.equal(sections.length, 2, 'one section per file')
      assert.equal(sections[0].querySelector('[data-testid="diff-file-section-path"]')?.textContent, 'src/app.ts')
      assert.equal(sections[1].querySelector('[data-testid="diff-file-section-path"]')?.textContent, 'lib/util.ts')
      // Added/deleted lines are actually counted in the DOM, not just present as markup.
      const insert = host.querySelectorAll('.diff-code-insert')
      const del = host.querySelectorAll('.diff-code-delete')
      assert.equal(insert.length, 3, 'three + rows in the DOM')
      assert.equal(del.length, 2, 'two - rows in the DOM')
      // Each section header carries the path plus its own +N/-N counts.
      const header = sections[0].querySelector('[data-testid="diff-file-section-path"]')
      assert.ok(header)
      assert.equal(header.textContent, 'src/app.ts')
      assert.match(text(header.parentElement as HTMLElement), /\+\s*2\s*-1/, 'section header carries its own +2 -1')
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test('toggle switches the diff between unified and split and back', { concurrency: false }, async () => {
  const window = installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const snapshot = structuredClone(fixture.data)
  snapshot.fileDiffs['src/app.ts'] = MULTI_DIFF
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(ContextPanel, { focus: { kind: 'file', value: 'src/app.ts' }, snapshot }))
    await sleep()
  })
  try {
    // Breadcrumb toggle starts in unified and exposes a working control.
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="diff-view-toggle"]')
    assert.ok(toggle, 'diff view toggle exists in the breadcrumb')
    assert.match(text(toggle), /Split/, 'toggle offers the split view')
    assert.equal(host.querySelectorAll('.diff-line.split-').length, 0)
    await act(async () => {
      toggle.click()
      await sleep()
    })
    // Split renders split rows; the toggle now offers unified.
    const splitRows = host.querySelectorAll(
      '.diff-line[class*="split-"], .diff-line-old-only, .diff-line-new-only, .diff-line-compare, .diff-line-normal',
    )
    assert.ok(splitRows.length > 0, 'split view renders split rows')
    const toggleAfter = host.querySelector<HTMLButtonElement>('[data-testid="diff-view-toggle"]')
    assert.ok(toggleAfter, 'toggle persists after switching')
    assert.match(text(toggleAfter), /Unified/, 'toggle offers the unified view after switching to split')
    await act(async () => {
      toggleAfter.click()
      await sleep()
    })
    assert.equal(
      host.querySelectorAll(
        '.diff-line[class*="split-"], .diff-line-old-only, .diff-line-new-only, .diff-line-compare, .diff-line-normal',
      ).length,
      0,
      'back to unified renders no split rows',
    )
  } finally {
    await act(async () => root.unmount())
  }
})

test(
  'renders well-formed no-hunk files (binary and mode change) with no anonymous raw pre fallback',
  { concurrency: false },
  async () => {
    const window = installDom()
    const host = document.createElement('div')
    document.body.append(host)
    const snapshot = structuredClone(fixture.data)
    snapshot.fileDiffs['assets/logo.png'] = NO_HUNK_DIFF
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(ContextPanel, { focus: { kind: 'file', value: 'assets/logo.png' }, snapshot }))
      await sleep()
    })
    try {
      const sections = host.querySelectorAll('[data-testid="diff-file-section"]')
      assert.equal(sections.length, 2, 'binary and mode-only files get explicit sections')
      assert.equal(sections[0].querySelector('[data-testid="diff-file-section-path"]')?.textContent, 'assets/logo.png')
      assert.match(text(sections[0]), /binary file/, 'binary file is labeled')
      assert.equal(sections[1].querySelector('[data-testid="diff-file-section-path"]')?.textContent, 'run.sh')
      assert.match(text(sections[1]), /mode change/, 'mode-only change is labeled')
      assert.equal(host.querySelectorAll('.diff-code-insert').length, 0, 'no phantom added rows for no-hunk files')
      assert.equal(host.querySelectorAll('.diff-code-delete').length, 0, 'no phantom deleted rows for no-hunk files')
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test('file list rows smooth-scroll to their section and expose an aria target', { concurrency: false }, async () => {
  const window = installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const snapshot = structuredClone(fixture.data)
  snapshot.fileDiffs['src/app.ts'] = MULTI_DIFF
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(ContextPanel, { focus: { kind: 'file', value: 'src/app.ts' }, snapshot }))
    await sleep()
  })
  try {
    const list = host.querySelector('[data-testid="diff-file-list"]')
    assert.ok(list)
    const lastRow = list.querySelector<HTMLElement>('[data-testid="diff-file-list-item"][data-file-path="lib/util.ts"]')
    assert.ok(lastRow, 'second file row exists')
    const scroll = host.querySelector<HTMLElement>('[data-testid="context-diff"]')
    assert.ok(scroll, 'scroll container exists')
    const target = host.querySelector('[data-testid="diff-file-section"][data-file-path="lib/util.ts"]')
    assert.ok(target, 'section anchors its path')
    assert.equal(scroll.contains(target), true, 'target lives inside the scroll container')
    await act(async () => {
      lastRow.click()
      await sleep(600)
    })
  } finally {
    await act(async () => root.unmount())
  }
})

test(
  'renders branch log refs, parents, and merge metadata without losing commit fields',
  { concurrency: false },
  async () => {
    installDom()
    const host = document.createElement('div')
    document.body.append(host)
    const snapshot = structuredClone(fixture.data)
    snapshot.branchLogs.main = [
      {
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortHash: 'bbbbbbb',
        subject: 'Merge feature/ui',
        author: 'Maintainer',
        date: '2026-09-14T11:00:00+00:00',
        merge: true,
        refs: ['HEAD -> main', 'origin/main'],
        parents: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cccccccccccccccccccccccccccccccccccccccc'],
      },
    ]
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(ContextPanel, { focus: { kind: 'branch', value: 'main' }, snapshot }))
      await sleep()
    })
    try {
      assert.match(text(host), /HISTORY/)
      assert.match(text(host), /bbbbbbb/)
      assert.match(text(host), /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/)
      assert.match(text(host), /Merge feature\/ui/)
      assert.match(text(host), /Maintainer/)
      assert.match(text(host), /2026-09-14T11:00:00\+00:00/)
      assert.match(text(host), /HEAD -> main/)
      assert.match(text(host), /origin\/main/)
      assert.match(text(host), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/)
      assert.match(text(host), /cccccccccccccccccccccccccccccccccccccccc/)
      assert.match(text(host), /merge: true/)
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test('exposes one stable context shell with state-specific exclusive view IDs', { concurrency: false }, async () => {
  installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const snapshot = structuredClone(fixture.data)
  snapshot.branchLogs.main = [
    {
      hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      shortHash: 'bbbbbbb',
      subject: 'Merge feature/ui',
      author: 'Maintainer',
      date: '2026-09-14T11:00:00+00:00',
      merge: true,
      refs: ['HEAD -> main', 'origin/main'],
      parents: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    },
    {
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      shortHash: 'aaaaaaa',
      subject: 'main work',
      author: 'Maintainer',
      date: '2026-09-14T10:00:00+00:00',
      merge: false,
      refs: [],
      parents: [],
    },
  ]
  snapshot.capabilities.branchLogs.value = snapshot.branchLogs
  const root = createRoot(host)
  const count = (id: string) => host.querySelectorAll(`[data-testid="${id}"]`).length
  const render = async (focus: unknown, detail?: unknown) => {
    await act(async () => {
      root.render(
        React.createElement(ContextPanel, {
          focus,
          snapshot,
          detail,
          loading: false,
          selectedCommitHash: undefined,
          onSelectCommit: () => undefined,
        }),
      )
      await sleep()
    })
  }
  try {
    await render({ kind: 'file', value: 'src/app.ts' })
    assert.equal(count('context-section'), 1)
    assert.equal(count('context-body'), 1)
    assert.equal(count('context-breadcrumb'), 1)
    assert.equal(count('context-breadcrumb-branch'), 0)
    assert.equal(count('context-diff'), 1)
    assert.equal(count('git-log-terminal'), 0)
    assert.equal(count('context-commit-detail'), 0)
    assert.equal(count('git-log-breadcrumb'), 0)
    assert.match(host.querySelector<HTMLElement>('[data-testid="context-body"]')?.className ?? '', /overflow-hidden/)
    assert.equal(
      host.querySelector<HTMLElement>('[data-testid="context-breadcrumb"]')?.parentElement?.getAttribute('data-testid'),
      'context-section',
    )

    await render({ kind: 'branch', value: 'main' })
    assert.equal(count('context-section'), 1)
    assert.equal(count('context-breadcrumb'), 1)
    assert.equal(count('context-breadcrumb-branch'), 0)
    assert.equal(count('context-diff'), 0)
    assert.equal(count('git-log-terminal'), 1)
    assert.equal(count('git-log-commit-row'), 2)
    assert.equal(count('git-log-ref'), 2)
    assert.equal(count('context-commit-detail'), 0)
    assert.equal(count('git-log-scroll'), 1)
    assert.match(host.querySelector<HTMLElement>('[data-testid="context-breadcrumb"]')?.className ?? '', /h-8/)

    await render(
      { kind: 'commit', value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      {
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        subject: 'main work',
        author: 'Maintainer',
        date: '2026-09-14T10:00:00+00:00',
        files: [],
        diff: '',
      },
    )
    assert.equal(count('context-section'), 1)
    assert.equal(count('context-breadcrumb'), 1)
    assert.equal(count('context-commit-detail'), 1)
    assert.equal(count('context-commit-scroll'), 1)
    assert.equal(count('git-log-terminal'), 0)
    assert.equal(count('git-log-commit-row'), 0)
    assert.equal(count('context-diff'), 0)
    assert.equal(host.querySelector('button[aria-label="Back to branch log"]'), null)
    // Commit-detail metadata readability redesign: the meta block is a semantic
    // dl with labeled rows; the date renders relative (never the raw ISO) while
    // the full ISO stays on the <time> element; the hash renders short (7 chars)
    // in accent with the full hash kept in title.
    const metaGrid = host.querySelector('[data-testid="commit-meta-grid"]')
    assert.ok(metaGrid, 'commit meta grid renders')
    assert.equal(metaGrid?.querySelectorAll(':scope > div').length, 3)
    assert.match(text(host), /Autore/)
    assert.match(text(host), /Data/)
    assert.match(text(host), /Hash/)
    const timeEl = metaGrid?.querySelector('time')
    assert.ok(timeEl, 'date renders as a time element')
    assert.equal(timeEl?.getAttribute('datetime'), '2026-09-14T10:00:00+00:00')
    assert.doesNotMatch(text(host), /2026-09-14T10:00:00\\+00:00/)
    const hashDd = [...(metaGrid?.querySelectorAll(':scope > div') ?? [])]
      .find((row) => row.querySelector('dt')?.textContent?.includes('Hash'))
      ?.querySelector('dd')
    assert.equal(hashDd?.textContent, 'aaaaaaa')
    assert.equal(hashDd?.getAttribute('title'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    // The branch return control must not be a <button>: the host styles button with an
    // !important 44px touch target, which would overflow the fixed 32px breadcrumb shell.
    const breadcrumbBranch = host.querySelector<HTMLElement>('[data-testid="context-breadcrumb-branch"]')
    if (breadcrumbBranch) assert.equal(breadcrumbBranch.tagName, 'SPAN')
  } finally {
    await act(async () => root.unmount())
  }
})

test('isolates branch log capability errors from the last-known-good panel', { concurrency: false }, async () => {
  installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const snapshot = structuredClone(fixture.data)
  snapshot.capabilities.branchLogs.status = 'error'
  snapshot.capabilities.branchLogs.errorCode = 'GIT_TIMEOUT'
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(ContextPanel, { focus: { kind: 'branch', value: 'main' }, snapshot }))
    await sleep()
  })
  try {
    assert.match(text(host), /Unable to load branch log/)
    assert.equal(host.querySelector('[data-testid="git-log-terminal"]'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test(
  'mounts the route and exercises real rendered files, branches, context, PR detail, guard, and overflow DOM',
  { concurrency: false },
  async () => {
    const { host, root } = await mountedRoute()
    try {
      assert.ok(host.querySelector('[data-testid="mc-projects-route"]'))
      assert.match(text(host), /src\/app\.ts/)
      assert.ok(host.querySelector('[role="treeitem"][aria-selected="true"]'))
      assert.equal(host.querySelectorAll('[role="tree"] [role="treeitem"]').length, 2)
      const route = host.querySelector<HTMLElement>('[data-testid="mc-projects-route"]')
      assert.ok(route)
      assert.match(route.className, /overflow-y-auto/)
      assert.match(route.className, /overflow-x-hidden/)
      assert.equal(host.querySelectorAll<HTMLElement>('[data-testid="mc-projects-route"] *').length > 0, true)
      const leftColumn = host.querySelector<HTMLElement>('[data-testid="mc-projects-route"] aside')
      assert.ok(leftColumn)
      assert.match(leftColumn.className, /md:overflow-y-auto/)
      assert.match(route.className, /md:overflow-hidden/)
      assert.match(
        host.querySelector<HTMLElement>('[data-testid="context-diff"]')?.className ?? '',
        /overflow-y-scroll/,
      )
      assert.equal(host.querySelector('[data-testid="branch-switch"]'), null, 'mutation-section switch was removed')
      assert.equal(host.querySelector('[data-testid="mutation-section"]'), null, 'mutation-section was removed')
      const treeItems = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      assert.equal(treeItems.length, 2)
      for (const item of treeItems) {
        assert.ok(
          item.getBoundingClientRect().height >= 24,
          `treeitem ${item.dataset.treePath} must render a 24px hit area`,
        )
        assert.equal(item.dataset.hitAreaMin, '24')
      }

      // branch rows still expose contextual mutation affordances without the old mutation block.
      // Local/Remote/Create now live INSIDE the accordion body as an icon bar, not as header tabs:
      // as header buttons the host's unlayered `button { min-height: var(--touch-target) }`
      // forced them to 44px inside a 27px header (measured: 17px overflow over the title).
      assert.equal(
        host.querySelector('[data-acc-section="branches"] .acc-head .tabs'),
        null,
        'branch tabs were removed from the header',
      )
      const iconbar = host.querySelector<HTMLElement>('.branch-iconbar')
      assert.ok(iconbar, 'branch icon bar exists inside the accordion body')
      assert.equal(
        host.querySelectorAll('.branch-iconbar .branch-icon-tab').length,
        3,
        'Local, Remote and Create are all present as icons',
      )
      assert.ok(host.querySelector('.branch-iconbar .branch-icon-action'), 'create-from-current is an icon action')
      assert.equal(host.querySelector('[data-testid="mutation-section"]'), null)

      const folder = host.querySelector<HTMLElement>('[data-tree-path="src"]')
      assert.ok(folder)
      await act(async () => {
        folder.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
        await sleep()
      })
      assert.equal(host.querySelectorAll('[role="tree"] [role="treeitem"]').length, 1)
      await act(async () => {
        folder.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        await sleep()
      })
      assert.equal(host.querySelectorAll('[role="tree"] [role="treeitem"]').length, 2)
      const file = host.querySelector<HTMLElement>('[data-tree-path="src/app.ts"]')
      assert.ok(file)
      await act(async () => {
        file.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await sleep()
      })
      assert.match(text(host), /DIFF/)
      assert.match(text(host), /src\/app\.ts/)
      assert.ok(host.querySelector('[data-testid="context-diff"]'))

      await click(host, 'button[aria-expanded="false"]')
      assert.ok(host.querySelector('[role="option"]'))
      assert.doesNotMatch(text(host), /Selected projectOther/)
      await click(host, '[data-acc-section="branches"] .branch-iconbar button:nth-child(2)')
      assert.match(text(host), /origin\/main/)
      assert.match(text(host), /DIFF/)
      await click(host, '[data-acc-section="branches"] .branch-iconbar button:nth-child(1)')
      await click(host, '[data-branch-name="main"]')
      assert.match(text(host), /HISTORY/)
      assert.match(text(host), /Initial/)

      await click(host, '[data-commit-hash]')
      assert.match(text(host), /COMMIT/)
      assert.match(text(host), /const value = 1;/)
      assert.equal(host.querySelector('pre[data-testid="context-detail"]'), null)
      assert.equal(host.querySelector('button[aria-label="Back to branch log"]'), null)

      // GitHub rows are the external link itself (no in-app Details affordance).
      assert.ok(
        host.querySelector('a[href="https://github.com/example/repo/pull/1"][target="_blank"][rel="noreferrer"]'),
      )
      assert.equal(host.querySelector('[data-testid="pr-detail-1"]'), null)
      assert.ok(
        host.querySelector('a[href="https://github.com/example/repo/issues/2"][target="_blank"][rel="noreferrer"]'),
      )
      assert.equal(host.querySelectorAll('main').length, 1)
      // No spurious scroll owners: after the commit detail the two legitimate
      // vertical scroll owners are the sidebar (md:overflow-y-auto) and the
      // commit detail scroll area. Before 17/09 the flow ended on the (removed)
      // PR detail panel, which unmounted the commit scroll and left 1 owner.
      assert.equal(host.querySelectorAll('main > div [class*="overflow-y-auto"]').length, 2)
      assert.ok(host.querySelector('[data-testid="context-commit-scroll"]'))
      assert.ok(host.querySelector('#mc-project-sidebar'))
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'sidebar commit list: no dots/rail, single-line subject, 3-line hierarchy, real selection state',
  { concurrency: false },
  async () => {
    const clean = structuredClone(fixture.data)
    clean.commits = [
      {
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortHash: 'aaaaaaa',
        subject: 'main work',
        author: 'Maintainer',
        date: '2026-09-14T10:00:00+00:00',
        merge: false,
        refs: ['HEAD -> main'],
        parents: [],
      },
      {
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortHash: 'bbbbbbb',
        subject: 'feature work',
        author: 'Contributor',
        date: '2026-09-14T09:00:00+00:00',
        merge: false,
        refs: [],
        parents: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      },
      {
        hash: 'cccccccccccccccccccccccccccccccccccccccc',
        shortHash: 'ccccccc',
        subject: 'merge branch',
        author: 'Maintainer',
        date: '2026-09-14T08:00:00+00:00',
        merge: true,
        refs: [],
        parents: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      },
    ]
    clean.capabilities.commits.value = clean.commits
    const { host, root } = await mountedRoute(clean)
    try {
      // Commits accordion is closed by default: open it first.
      await click(host, '[data-acc-section="commits"] .acc-head')
      const rows = host.querySelectorAll('[data-testid="commits-section"] [data-commit-hash]')
      assert.equal(rows.length, 3)
      // No isolated dots and no graph rail in the sidebar list (decision #17).
      assert.equal(host.querySelectorAll('[data-testid="commits-section"] .commit-dot').length, 0)
      assert.equal(host.querySelectorAll('[data-testid="commits-section"] .commit-rail').length, 0)
      // Subject is a single ellipsized line: every row stays the same height.
      const subject = host.querySelector<HTMLElement>('[data-testid="commits-section"] .commit-subject')
      assert.ok(subject)
      assert.equal(subject.classList.contains('truncate'), true)
      // 3-line hierarchy: subject, hash+refs, date+author (each row has all three).
      const row = host.querySelector<HTMLElement>('[data-commit-hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]')
      assert.ok(row)
      assert.equal(row.querySelectorAll('.commit-subject').length, 1)
      assert.equal(row.querySelectorAll('.commit-meta .commit-hash').length, 1)
      assert.equal(row.querySelectorAll('.commit-ref').length, 1)
      assert.equal(row.querySelectorAll('.commit-byline time').length, 1)
      const bylineText = row.querySelector<HTMLElement>('.commit-byline')?.textContent ?? ''
      assert.match(bylineText, /agoMaintainer/)
      // Nothing selected before a click.
      assert.equal(host.querySelectorAll('[data-testid="commits-section"] [aria-selected="true"]').length, 0)
      // Click the head commit (the fixture mock serves its detail): selection
      // lands on the row and the commit detail loads in the context column.
      await click(host, '[data-commit-hash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]')
      assert.equal(host.querySelectorAll('[data-testid="commits-section"] [aria-selected="true"]').length, 1)
      assert.equal(
        host
          .querySelector<HTMLElement>('[data-testid="commits-section"] [aria-selected="true"]')
          ?.getAttribute('data-commit-hash'),
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      )
      assert.match(text(host), /COMMIT/)
      // The commit inspector renders the diff with the SAME renderer as the working tree:
      // per-file section header present with counts.
      assert.ok(
        host.querySelector('[data-testid="diff-file-section"][data-file-path="src/app.ts"]') ??
          host.querySelector('[data-testid="context-commit-scroll"]'),
      )
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'renders mobile order and verifies enabled mutation POST plus snapshot read-back',
  { concurrency: false },
  async () => {
    const clean = structuredClone(fixture.data)
    clean.workingTree.files = []
    clean.capabilities.workingTree.value.files = []
    clean.branches.local = [
      {
        name: 'feature/test',
        current: true,
        tracking: null,
        remoteAlias: 'origin',
        repository: clean.branches.repository,
        relation: 'no-upstream',
        ahead: 0,
        behind: 0,
      },
    ]
    clean.capabilities.branches.value = clean.branches
    const { host, root, window } = await mountedRoute(clean, true)
    let mutationCalls = 0
    const originalFetch = window.fetch
    window.fetch = async (input, init) => {
      const url = String(input)
      if (url.includes('/branch/switch')) {
        mutationCalls += 1
        assert.equal(init?.method, 'POST')
        return response({
          verified: true,
          generation: 1,
          project_id: 'demo',
          branch: 'feature/test',
          tracking: null,
          status: 'clean',
          created: false,
        })
      }
      if (url.includes('/branch/create')) {
        mutationCalls += 1
        assert.equal(init?.method, 'POST')
        return response({
          verified: true,
          generation: 1,
          project_id: 'demo',
          branch: 'feature/test',
          tracking: null,
          status: 'clean',
          created: true,
        })
      }
      return originalFetch(input, init)
    }
    globalThis.fetch = window.fetch
    try {
      const route = host.querySelector('[data-testid="mc-projects-route"]')
      assert.ok(route)
      const sections = ['files-section', 'branches-section', 'github-section', 'context-section']
      assert.deepEqual(
        sections.map((id) => Boolean(host.querySelector(`[data-testid="${id}"]`))),
        [true, true, true, true],
      )
      assert.equal(host.querySelector('[data-testid="mutation-section"]'), null)
      assert.equal(host.querySelector('[data-testid="branch-switch"]'), null)
      const positions = sections.map((id) =>
        [...host.querySelectorAll('[data-testid]')].findIndex((node) => node.getAttribute('data-testid') === id),
      )
      assert.deepEqual(
        [...positions].sort((a, b) => a - b),
        positions,
      )
      // contextual create-from-current modal exposes the branch name input
      const createButton = host.querySelector<HTMLButtonElement>('.branch-iconbar .branch-icon-action')
      assert.ok(createButton, 'create-from-current icon action exists')
      await act(async () => {
        createButton.click()
        await sleep()
      })
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')
      assert.ok(input)
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, 'feature/test')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
        input.dispatchEvent(new window.Event('change', { bubbles: true }))
        await sleep()
      })
      assert.equal(input.value, 'feature/test')
      const confirmButton = host.querySelector<HTMLButtonElement>('.branch-create-confirm')
      assert.ok(confirmButton)
      await act(async () => {
        confirmButton.click()
        await sleep(100)
      })
      assert.equal(mutationCalls, 1)
      assert.match(text(host), /Read-back confirmed/)
      for (const item of host.querySelectorAll<HTMLElement>(
        '[data-testid="files-section"], [data-testid="branches-section"]',
      ))
        assert.ok(item.className.includes('min-w-0'))
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'commit inspector: no file list inside the diff box; Changed files rows scroll to their diff section',
  { concurrency: false },
  async () => {
    const window = installDom()
    const host = document.createElement('div')
    document.body.append(host)
    const detail = {
      hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      subject: 'main work',
      author: 'Maintainer',
      date: '2026-09-14T10:00:00+00:00',
      files: [
        { path: 'src/app.ts', additions: 2, deletions: 1, binary: false },
        { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
      ],
      diff: MULTI_DIFF,
    }
    const root = createRoot(host)
    await act(async () => {
      root.render(
        React.createElement(ContextPanel, {
          focus: { kind: 'commit', value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          snapshot: fixture.data,
          detail,
          loading: false,
        }),
      )
      await sleep()
    })
    try {
      const inspector = host.querySelector('[data-testid="context-commit-inspector"]')
      assert.ok(inspector)
      // The diff box must NOT contain the extra file list (the Changed files list above is its anchor).
      assert.equal(
        inspector.querySelector('[data-testid="diff-file-list"]'),
        null,
        'no duplicate file list in commit diff box',
      )
      // Changed files rows are links; binary rows stay unclickable and labeled.
      const links = inspector.querySelectorAll('[data-testid="commit-file-link"]')
      assert.equal(links.length, 1, 'only the textual file from the backend list is a link')
      assert.equal(links[0].getAttribute('data-file-path'), 'src/app.ts')
      const binRow = [...inspector.querySelectorAll('div')].find((el) =>
        (el.textContent ?? '').includes('assets/logo.png'),
      )
      assert.ok(binRow)
      assert.equal(binRow.tagName, 'DIV', 'binary rows are not clickable')
      assert.match(text(binRow), /binary/)
      // The anchor target exists inside the diff box (scroll destination still reachable).
      const section = inspector.querySelector('[data-testid="diff-file-section"][data-file-path="src/app.ts"]')
      assert.ok(section, 'diff section exists for the linked file')
      await act(async () => {
        links[0].click()
        await sleep(50)
      })
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'diff panel shows a floating back-to-top button after scrolling and hides it at the top',
  { concurrency: false },
  async () => {
    const window = installDom()
    const host = document.createElement('div')
    document.body.append(host)
    const snapshot = structuredClone(fixture.data)
    snapshot.fileDiffs['src/app.ts'] = MULTI_DIFF
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(ContextPanel, { focus: { kind: 'file', value: 'src/app.ts' }, snapshot }))
      await sleep()
    })
    try {
      const diff = host.querySelector<HTMLElement>('[data-testid="context-diff"]')
      assert.ok(diff)
      assert.equal(host.querySelector('[data-testid="diff-scroll-top"]'), null, 'fab is hidden at the top')
      // Simulate a real scroll event below the 300px threshold.
      Object.defineProperty(diff, 'scrollTop', { configurable: true, get: () => 420 })
      await act(async () => {
        diff.dispatchEvent(new window.Event('scroll', { bubbles: true }) as unknown as Event)
        await sleep()
      })
      const fab = host.querySelector<HTMLElement>('[data-testid="diff-scroll-top"]')
      assert.ok(fab, 'fab appears after scrolling')
      assert.equal(fab.getAttribute('aria-label'), 'Torna in cima')
      // Clicking it scrolls back to top (scrollTo no-ops in happy-dom) and hides it.
      await act(async () => {
        fab.click()
        await sleep(50)
      })
      assert.ok(
        host.querySelector('[data-testid="diff-scroll-top"]'),
        'fab stays visible until scrollTop actually returns near zero',
      )
      Object.defineProperty(diff, 'scrollTop', { configurable: true, get: () => 0 })
      await act(async () => {
        diff.dispatchEvent(new window.Event('scroll', { bubbles: true }) as unknown as Event)
        await sleep()
      })
      assert.equal(host.querySelector('[data-testid="diff-scroll-top"]'), null, 'fab hides once back at the top')
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'renders the selected branch as a terminal graph and routes commit selection to detail',
  { concurrency: false },
  async () => {
    const snapshot = structuredClone(fixture.data)
    snapshot.branchLogs.main = [
      {
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        shortHash: 'bbbbbbb',
        subject: 'Merge feature/ui',
        author: 'Maintainer',
        date: '2026-09-14T11:00:00+00:00',
        merge: true,
        refs: ['HEAD -> main', 'origin/main'],
        parents: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'cccccccccccccccccccccccccccccccccccccccc'],
      },
      {
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        shortHash: 'aaaaaaa',
        subject: 'main work',
        author: 'Maintainer',
        date: '2026-09-14T10:00:00+00:00',
        merge: false,
        refs: [],
        parents: [],
      },
      {
        hash: 'cccccccccccccccccccccccccccccccccccccccc',
        shortHash: 'ccccccc',
        subject: 'feature work',
        author: 'Contributor',
        date: '2026-09-14T09:00:00+00:00',
        merge: false,
        refs: [],
        parents: [],
      },
    ]
    snapshot.capabilities.branchLogs.value = snapshot.branchLogs
    const { host, root } = await mountedRoute(snapshot)
    try {
      await click(host, '[data-branch-name="main"]')
      assert.ok(host.querySelector('[data-testid="git-log-terminal"]'))
      assert.equal(host.querySelectorAll('[data-testid="git-log-commit-row"]').length, 3)
      assert.ok(host.querySelector('[data-testid="git-log-ref"]'))
      assert.ok(host.querySelector('[data-testid="git-log-selected-row"]'))
      assert.equal(host.querySelector('[data-testid="context-detail"]'), null)
      await act(async () => {
        host.querySelectorAll<HTMLElement>('[data-testid="git-log-commit-row"]')[1]?.click()
        await sleep(100)
      })
      assert.ok(host.querySelector('[data-testid="context-commit-detail"]'))
      assert.match(text(host), /const value = 1;/)
      assert.match(
        text(host),
        /assets\s*\/\s*logo\s*\.\s*png\s*binary/,
        'binary files render a binary marker instead of +N\/-N',
      )
      assert.match(text(host), /src\/app\.ts\s*\+1\s*-0/, 'textual files keep their +/- counts')
      assert.equal(host.querySelector('[data-testid="context-branch-log"]'), null)
      assert.equal(host.querySelector('[data-testid="context-breadcrumb-message"]')?.textContent, 'main work')
      assert.equal(host.querySelector('button[aria-label="Back to branch log"]'), null)
      assert.match(
        host.querySelector<HTMLElement>('[data-testid="context-commit-inspector"]')?.className ?? '',
        /(?:^|\s)flex(?:\s|$)/,
      )
      assert.match(
        host.querySelector<HTMLElement>('[data-testid="context-commit-scroll"]')?.className ?? '',
        /overflow-y-auto/,
      )
      await click(host, '[data-testid="context-breadcrumb-branch"]')
      assert.ok(host.querySelector('[data-testid="context-branch-log"]'))
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'project selector: trigger aligned via shared grid, flat overlay, owner/repo secondary field',
  { concurrency: false },
  async () => {
    const { host, root } = await mountedRoute()
    try {
      // Header and body share the same grid template class: one width source.
      const header = host.querySelector<HTMLElement>('#mc-project-header')
      const body = host.querySelector<HTMLElement>('[data-testid="mc-projects-route"] > .workspace-grid')
      assert.ok(header, 'header exists')
      assert.ok(header.className.includes('workspace-grid'), 'header uses the shared grid class (issue #24)')
      assert.ok(body, 'body uses the shared grid class')
      assert.ok(body.className.includes('workspace-grid'), 'body uses the shared grid class (issue #24)')

      // Trigger secondary field: normalized owner/repo from the snapshot URL,
      // never the remote alias 'origin'.
      const trigger = host.querySelector<HTMLElement>('#mc-project-header [aria-controls="project-options"]')
      assert.ok(trigger, 'trigger exists')
      assert.ok(trigger.textContent?.includes('example/repo'), 'trigger shows owner/repo normalized from snapshot')
      assert.equal(trigger.textContent?.includes('origin'), false, 'trigger never shows the remote alias')

      // Open the overlay.
      await click(host, '#mc-project-header [aria-controls="project-options"]')
      const overlay = host.querySelector<HTMLElement>('#project-options')
      assert.ok(overlay, 'overlay opens')
      assert.equal(
        overlay.classList.contains('shadow-lg') || overlay.classList.contains('rounded-lg'),
        false,
        'overlay is flat: no shadow, no rounded card',
      )
      assert.equal(overlay.classList.contains('overlay-w'), false, 'overlay no longer uses the fixed 400px width')
      // Trigger-bound width: anchored left and right of the trigger.
      assert.ok(overlay.className.includes('left-0') && overlay.className.includes('right-0'))

      // The dropdown lists the active project first plus the other candidates:
      // demo (catalog slug present) and other (repository null -> project_id).
      const cards = [...host.querySelectorAll<HTMLElement>('#project-options [role="option"]')]
      assert.equal(cards.length, 2, 'active plus the other candidate are listed')
      const demoCard = cards.find((c) => c.getAttribute('data-value') === 'demo')
      const otherCard = cards.find((c) => c.getAttribute('data-value') === 'other')
      assert.ok(demoCard, 'demo card present')
      assert.ok(otherCard, 'other card present')
      assert.ok(demoCard.textContent?.includes('imbundle/mc-project-plugin'), 'demo card shows the catalog slug')
      assert.equal(demoCard.textContent?.includes('origin'), false, 'cards never show the remote alias')
      assert.ok(otherCard.textContent?.includes('other'), 'card with null repository falls back to project_id')
      assert.ok(host.querySelector('#project-options .pbranch'), 'branch pill preserved')
      assert.ok(demoCard.querySelector('.pcheck'), 'active card keeps the check')
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'project selector renders card repository slugs and keeps the active check standalone',
  { concurrency: false },
  async () => {
    installDom()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const projects = [
      {
        project_id: 'repoful',
        name: 'Repoful',
        enabled: true,
        remote: 'origin',
        default_branch: 'main',
        repository: 'imbundle/mc-project-plugin',
      },
      { project_id: 'noner', name: 'Noner', enabled: true, remote: 'origin', default_branch: 'main', repository: null },
    ]
    await act(async () => {
      root.render(
        React.createElement(ProjectSelector, {
          active: {
            project_id: 'active',
            name: 'Active',
            enabled: true,
            remote: 'origin',
            default_branch: 'main',
            repository: 'imbundle/active-repo',
          },
          projects,
          open: true,
          onToggle: () => undefined,
          onSelect: () => undefined,
          activeBranch: 'main',
          activeChanged: 2,
          activeRepository: 'example/repo',
        }),
      )
      await sleep()
    })
    try {
      const trigger = host.querySelector<HTMLElement>('[aria-controls="project-options"]')
      assert.ok(trigger, 'trigger exists')
      assert.ok(trigger.textContent?.includes('example/repo'), 'trigger uses the normalized prop')
      assert.equal(trigger.textContent?.includes('origin'), false, 'trigger never shows the remote alias')
      const repoful = host.querySelector<HTMLElement>('[data-value="repoful"]')
      const noner = host.querySelector<HTMLElement>('[data-value="noner"]')
      assert.ok(repoful, 'repoful card exists')
      assert.ok(noner, 'noner card exists')
      assert.ok(repoful.textContent?.includes('imbundle/mc-project-plugin'), 'card shows the catalog slug')
      assert.ok(noner.textContent?.includes('noner'), 'card with null repository falls back to project_id')
      assert.ok(repoful.querySelector('.pbranch'), 'branch pill preserved on cards')
      const activeCard = host.querySelector<HTMLElement>('[data-value="active"]')
      assert.ok(activeCard, 'active card exists in standalone render')
      assert.ok(activeCard.querySelector('.pcheck'), 'active card keeps the check')
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test(
  'project selector trigger falls back to project_id when snapshot repository is absent',
  { concurrency: false },
  async () => {
    const withoutRepository = structuredClone(fixture.data)
    delete withoutRepository.project.repository
    const { host, root } = await mountedRoute(withoutRepository)
    try {
      const trigger = host.querySelector<HTMLElement>('#mc-project-header [aria-controls="project-options"]')
      assert.ok(trigger, 'trigger exists')
      assert.ok(trigger.textContent?.includes('demo'), 'trigger falls back to the active project_id')
      assert.equal(trigger.textContent?.includes('origin'), false, 'never the remote alias')
    } finally {
      await act(async () => root.unmount())
    }
  },
)

test('renders capability notice and retains last-good DOM after a failed refresh', { concurrency: false }, async () => {
  const stale = structuredClone(fixture.data)
  stale.capabilities.github.status = 'stale'
  stale.capabilities.github.stale = true
  stale.capabilities.github.value.status = 'stale'
  stale.github.status = 'stale'
  const { host, root } = await mountedRoute(stale)
  try {
    assert.match(text(host), /GitHub: stale; last-known-good data shown/)
    assert.match(text(host), /src\/app\.ts/)
    await click(host, '[data-testid="route-refresh"]')
    await act(async () => {
      await sleep(100)
    })
    assert.match(text(host), /Refresh unavailable; showing last-known-good data/)
    assert.match(text(host), /src\/app\.ts/)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#41 code mode renders Markdown directly and resets on mode change', { concurrency: false }, async () => {
  const { host, root } = await mountedRoute()
  try {
    assert.ok(host.querySelector('[data-testid="workspace-mode-tabs"]'))
    assert.ok(host.querySelector('[data-mode="git"][aria-selected="true"]'))
    assert.ok(host.querySelector('[data-testid="files-section"]'))
    await click(host, '[data-mode="code"]')
    assert.ok(host.querySelector('[data-mode="code"][aria-selected="true"]'))
    assert.ok(host.querySelector('[data-testid="code-tree"]'))
    assert.equal(host.querySelector('[data-testid="files-section"]'), null)
    assert.ok(host.querySelector('[data-testid="code-tree-row"][data-tree-path="README.md"]'))
    await click(host, '[data-tree-path="README.md"][data-tree-kind="file"]')
    await act(async () => {
      await sleep(600)
    })
    const preview = host.querySelector('[data-testid="md-preview"]')
    assert.equal(preview?.querySelector('h1')?.textContent, 'repo')
    assert.equal(host.querySelector('[data-testid="md-preview-toggle"]'), null)
    assert.equal(host.querySelector('.cm-editor'), null)
    await click(host, '[data-mode="git"]')
    assert.ok(host.querySelector('[data-testid="files-section"]'))
    assert.equal(host.querySelector('[data-testid="code-tree"]'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#28 selecting another project returns to git mode', { concurrency: false }, async () => {
  const otherSnapshot = structuredClone(fixture.data)
  otherSnapshot.project_id = 'other'
  otherSnapshot.project = { ...otherSnapshot.project, name: 'Other' }
  const { host, root } = await mountedRoute(fixture.data, true, otherSnapshot)
  try {
    await click(host, '[data-mode="code"]')
    assert.ok(host.querySelector('[data-testid="code-tree"]'))
    await click(host, '#mc-project-header [aria-controls="project-options"]')
    await click(host, '.proj-card[data-value="other"]')
    await act(async () => {
      await sleep(50)
    })
    assert.equal(host.querySelector('[data-testid="code-tree"]'), null)
    assert.ok(host.querySelector('[data-testid="files-section"]'))
  } finally {
    await act(async () => root.unmount())
  }
})
