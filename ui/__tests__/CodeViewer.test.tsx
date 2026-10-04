import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { CodeViewer } from '../components/CodeViewer'
import { languageForPath } from '../components/codeLanguages'
import { ApiError } from '../api'

function installDom(): Window {
  const window = new Window({ url: 'http://localhost/mc-project-plugin' })
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const computed = window.getComputedStyle(this)
    const height =
      Number.parseFloat(computed.minHeight) || Number.parseFloat(computed.height) || 400
    const width = Number.parseFloat(computed.minWidth) || Number.parseFloat(computed.width) || 800
    return {
      ...originalRect.call(this),
      width,
      height,
      right: width,
      bottom: height,
      toJSON: () => ({ width, height }),
    } as never as DOMRect
  }
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 400
    },
  })
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 800
    },
  })
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function renderCodeViewer(props: {
  path?: string
  file?: { path: string; size: number; content?: string; truncated: boolean; binary: boolean }
  loading: boolean
  error?: ApiError
}) {
  const window = installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(CodeViewer, { projectId: 'demo', ...props }))
    await wait(600)
  })
  return { window, host, root }
}

function okEnvelope(data: unknown) {
  return new Response(
    JSON.stringify({
      ok: true,
      data,
      meta: { schemaVersion: 1, requestId: 'test-request', observedAt: '2026-09-18T10:00:00+00:00' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

test('#35 CodeMirror renders file content with highlighted lines in dark theme', async () => {
  const { host, root } = await renderCodeViewer({
    path: 'src/app.ts',
    file: { path: 'src/app.ts', size: 17, content: 'export const a = 1\n', truncated: false, binary: false },
    loading: false,
  })
  try {
    assert.ok(host.querySelector('[data-testid="code-content"]'))
    assert.ok(host.querySelector('[data-testid="code-content"] .cm-content'))
    assert.ok(host.querySelectorAll('[data-testid="code-content"] .cm-line').length > 0)
    const content = host.querySelector('[data-testid="code-content"] .cm-content')?.textContent ?? ''
    assert.ok(content.includes('export const a = 1'))
    assert.ok(host.querySelectorAll('[data-testid="code-content"] .cm-line span').length > 0)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#35 CodeMirror renders multiple Python lines with tokens', async () => {
  const { host, root } = await renderCodeViewer({
    path: 'main.py',
    file: { path: 'main.py', size: 22, content: 'def foo():\n    return 1\n', truncated: false, binary: false },
    loading: false,
  })
  try {
    assert.ok(host.querySelectorAll('[data-testid="code-content"] .cm-line').length >= 2)
    assert.ok(host.querySelectorAll('[data-testid="code-content"] .cm-line span').length > 0)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#35 loading state is preserved', async () => {
  const { host, root } = await renderCodeViewer({ loading: true })
  try {
    assert.match(host.textContent ?? '', /Loading file/)
    assert.equal(host.querySelector('[data-testid="code-content"]'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#35 error state is preserved', async () => {
  const { host, root } = await renderCodeViewer({
    loading: false,
    error: new ApiError('NOT_FOUND', 'missing'),
  })
  try {
    assert.match(host.textContent ?? '', /Unable to load file/)
    assert.equal(host.querySelector('[data-testid="code-content"]'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#36 image file mounts the binary viewer with a blob fetched via fileRaw', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const originalCreate = URL.createObjectURL
  try {
    globalThis.fetch = async (input) => {
      calls.push(String(input))
      return okEnvelope({
        path: 'img.png',
        contentType: 'image/png',
        size: 4,
        contentBase64: Buffer.from('test', 'utf8').toString('base64'),
        truncated: false,
      })
    }
    const { host, root } = await renderCodeViewer({
      path: 'img.png',
      file: { path: 'img.png', size: 4, truncated: false, binary: true },
      loading: false,
    })
    try {
      await wait(50)
      assert.ok(calls.some((url) => url.includes('/file/raw?') && url.includes('img.png')))
      const viewer = host.querySelector('[data-testid="code-binary-viewer"]')
      assert.ok(viewer)
      assert.equal(viewer.tagName, 'IMG')
    } finally {
      await act(async () => root.unmount())
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#36 unsupported binary does not mount the editor and shows explicit state', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalled = false
  try {
    globalThis.fetch = async () => {
      fetchCalled = true
      return okEnvelope({})
    }
    const { host, root } = await renderCodeViewer({
      path: 'data.bin',
      file: { path: 'data.bin', size: 10, truncated: false, binary: true },
      loading: false,
    })
    try {
      assert.ok(host.querySelector('[data-testid="code-binary-unsupported"]'))
      assert.match(host.textContent ?? '', /No preview available for this file type/)
      assert.equal(fetchCalled, false)
    } finally {
      await act(async () => root.unmount())
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#35 truncated banner is preserved when content is truncated', async () => {
  const { host, root } = await renderCodeViewer({
    path: 'big.txt',
    file: { path: 'big.txt', size: 300000, content: 'x'.repeat(500), truncated: true, binary: false },
    loading: false,
  })
  try {
    assert.ok(host.querySelector('[data-testid="code-truncated"]'))
    assert.match(host.textContent ?? '', /File truncated/)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#35 empty state is preserved without content', async () => {
  const { host, root } = await renderCodeViewer({ loading: false })
  try {
    assert.match(host.textContent ?? '', /Select a file from the tree/)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#41 Markdown file renders directly without Preview toggle or CodeMirror', async () => {
  const { host, root } = await renderCodeViewer({
    path: 'README.md',
    file: { path: 'README.md', size: 22, content: '# README\n\nBody text.\n', truncated: false, binary: false },
    loading: false,
  })
  try {
    const preview = host.querySelector('[data-testid="md-preview"]')
    assert.ok(preview?.querySelector('h1'))
    assert.equal(host.querySelector('[data-testid="md-preview-toggle"]'), null)
    assert.equal(host.querySelector('.cm-editor'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#41 .markdown extension also renders directly without CodeMirror', async () => {
  const { host, root } = await renderCodeViewer({
    path: 'docs/guide.markdown',
    file: { path: 'docs/guide.markdown', size: 20, content: '## Guide\n\nDetails.\n', truncated: false, binary: false },
    loading: false,
  })
  try {
    const preview = host.querySelector('[data-testid="md-preview"]')
    assert.ok(preview?.querySelector('h2'))
    assert.equal(host.querySelector('[data-testid="md-preview-toggle"]'), null)
    assert.equal(host.querySelector('.cm-editor'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#35 languageForPath maps extensions and defaults to plain text', () => {
  assert.ok(languageForPath('src/app.ts'))
  assert.ok(languageForPath('main.py'))
  assert.ok(languageForPath('data.json'))
  assert.ok(languageForPath('README.md'))
  assert.ok(languageForPath('config.yml'))
  assert.ok(languageForPath('style.css'))
  assert.ok(languageForPath('index.html'))
  assert.ok(languageForPath('file.xml'))
  assert.deepEqual(languageForPath('notes.txt'), [])
  assert.deepEqual(languageForPath(undefined), [])
})
