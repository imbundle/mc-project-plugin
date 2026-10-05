import React from 'react'
import { ApiError } from '../api'
import type { FileResponse } from '../types'
import { MarkdownPreview } from './MarkdownPreview'

export function PlansViewer({
  path,
  file,
  loading,
  error,
}: {
  path?: string
  file?: FileResponse
  loading: boolean
  error?: ApiError
}) {
  return (
    <section data-testid="plans-viewer" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {loading ? (
        <div data-testid="plans-viewer-state" data-state="loading" role="status" className="cp-11 p-4 text-text-muted">
          Loading plan…
        </div>
      ) : error ? (
        <div data-testid="plans-viewer-state" data-state="error" role="status" className="cp-11 p-4 text-warning">
          Unable to load this plan.
        </div>
      ) : file?.content !== undefined ? (
        <div data-testid="plans-content" data-path={path} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <MarkdownPreview content={file.content} />
        </div>
      ) : (
        <div data-testid="plans-viewer-state" data-state="no-selection" role="status" className="cp-11 p-4 text-text-muted">
          Select a plan to read it.
        </div>
      )}
    </section>
  )
}
