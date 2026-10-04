import test from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { MarkdownPreview } from '../components/MarkdownPreview'

function installDom(): Window {
  const window = new Window({ url: 'http://localhost/mc-project-plugin' })
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

async function render(content: string) {
  const window = installDom()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(MarkdownPreview, { content }))
  })
  return { window, host, root }
}

test('#41 MarkdownPreview renders a readable heading hierarchy and representative GFM content', async () => {
  const content = [
    '# Title',
    '',
    '## Section',
    '',
    'Paragraph with **strong text** and `inline code`.',
    '',
    '> Quoted text',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    '- first item',
    '- second item',
    '',
    '| Name | Value |',
    '|---|---|',
    '| answer | 42 |',
  ].join('\n')
  const { host, root } = await render(content)
  try {
    const preview = host.querySelector('[data-testid="md-preview"]')
    assert.equal(preview?.querySelector('h1')?.textContent, 'Title')
    assert.equal(preview?.querySelector('h2')?.textContent, 'Section')
    assert.ok(preview?.querySelector('p strong'))
    assert.ok(preview?.querySelector('p code'))
    assert.equal(preview?.querySelector('blockquote')?.textContent?.trim(), 'Quoted text')
    assert.equal(preview?.querySelector('pre code')?.textContent?.trim(), 'const answer = 42')
    assert.ok(preview?.querySelectorAll('li').length >= 2)
    assert.ok(preview?.querySelector('table'))
  } finally {
    await act(async () => root.unmount())
  }
})

test('#36 html inside markdown is NOT executed (no rehype-raw)', async () => {
  const window = installDom()
  window.__pwned = undefined as never
  const { window: w, host, root } = await render('before\n\n<script>window.__pwned = 1</script>\n\nafter')
  try {
    assert.equal(w.__pwned, undefined)
    assert.equal((w as unknown as { __pwned?: number }).__pwned, undefined)
    assert.ok(host.querySelector('[data-testid="md-preview"]'))
    assert.equal(host.querySelector('[data-testid="md-preview"] script'), null)
  } finally {
    await act(async () => root.unmount())
  }
})

test('#36 external links open in a new tab; relative links render as text', async () => {
  const { host, root } = await render('[Docs](https://docs.example.com/a)\n\n[Local](./README.md)\n')
  try {
    const external = host.querySelector('a[href="https://docs.example.com/a"]')
    assert.ok(external)
    assert.equal(external.getAttribute('target'), '_blank')
    assert.equal(external.getAttribute('rel'), 'noreferrer')
    const local = host.querySelector('a[href="./README.md"]')
    assert.equal(local, null)
  } finally {
    await act(async () => root.unmount())
  }
})
