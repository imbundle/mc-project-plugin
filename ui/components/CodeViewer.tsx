import React from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { foldGutter, bracketMatching } from '@codemirror/language'
import { lineNumbers } from '@codemirror/view'
import type { ApiError } from '../api'
import type { FileResponse } from '../types'
import { StatusStates } from './StatusStates'
import { languageForPath } from './codeLanguages'
import { MarkdownPreview } from './MarkdownPreview'
import { CodeBinaryViewer, isBinaryPreviewable } from './CodeBinaryViewer'

function CodeViewerBreadcrumb({ path }: { path?: string }) {
  return (
    <div
      data-testid="code-breadcrumb"
      className="border-border-subtle cp-11 flex h-8 max-h-8 min-h-8 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b px-2 font-mono leading-none"
    >
      <span className="text-accent shrink-0 font-semibold tracking-[0.1em]">CODE</span>
      <span className="text-text-subtle">/</span>
      <span className="text-text-muted min-w-0 truncate" title={path}>
        {path ?? '—'}
      </span>
    </div>
  )
}

function extensionOf(path: string | undefined): string | undefined {
  if (!path) return undefined
  return path.split('.').pop()?.toLowerCase()
}

export function CodeViewer({
  projectId,
  path,
  file,
  loading,
  error,
}: {
  projectId: string
  path?: string
  file?: FileResponse
  loading: boolean
  error?: ApiError
}) {
  const ext = extensionOf(path)
  const isMarkdown = ext === 'md' || ext === 'markdown'
  const isBinaryPreview = isBinaryPreviewable(path)

  return (
    <section data-testid="code-section" className="bg-surface flex min-h-0 min-w-0 flex-col overflow-hidden md:h-full">
      <CodeViewerBreadcrumb path={path} />
      <div data-testid="code-viewer" className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {loading ? (
          <div className="text-text-muted p-4 font-mono text-xs" role="status">
            Loading file…
          </div>
        ) : error ? (
          <div data-testid="code-viewer-error" className="p-4">
            <StatusStates state="error" label="file" />
          </div>
        ) : isBinaryPreview ? (
          <CodeBinaryViewer projectId={projectId} path={path} />
        ) : file?.binary ? (
          <div data-testid="code-binary-unsupported" className="text-text-muted p-4 font-mono text-xs" role="status">
            No preview available for this file type.
          </div>
        ) : file?.content !== undefined ? (
          <div data-testid="code-content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {file.truncated && (
              <div
                data-testid="code-truncated"
                role="status"
                className="border-warning/40 bg-warning/10 cp-11 text-warning border-b px-3 py-2"
              >
                File truncated (first 262144 bytes shown).
              </div>
            )}
            {isMarkdown ? (
              <MarkdownPreview content={file.content} />
            ) : (
              <div className="code-viewer-scroll min-h-0 min-w-0 flex-1 overflow-auto">
                <CodeMirror
                  value={file.content}
                  readOnly
                  theme={oneDark}
                  height="100%"
                  basicSetup={false}
                  extensions={[lineNumbers(), foldGutter(), bracketMatching(), languageForPath(path)]}
                  style={{ height: '100%' }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="text-text-muted p-4 font-mono text-xs" role="status">
            Select a file from the tree.
          </div>
        )}
      </div>
    </section>
  )
}

export { CodeViewerBreadcrumb }
