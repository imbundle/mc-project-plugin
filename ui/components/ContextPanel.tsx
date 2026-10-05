import React, { useState } from 'react'
import { ArrowUp, Clock3, FileText, GitCommitHorizontal, UserRound } from 'lucide-react'
import { Diff, Hunk, parseDiff } from 'react-diff-view'
import type { CommitDetail, Focus, Snapshot } from '../types'
import { GitLogTerminal } from './GitLogTerminal'
import { StatusStates } from './StatusStates'
import 'react-diff-view/style/index.css'
import './ContextPanel.css'

const MONO =
  '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  const abs = Math.abs(diff)
  const minutes = Math.round(abs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 min ago'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

function countChanges(hunks: readonly { changes: readonly { type: string }[] }[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type === 'insert') added += 1
      else if (change.type === 'delete') deleted += 1
    }
  }
  return { added, deleted }
}

function formatPath(file: { oldPath?: string; newPath?: string }): string {
  if (file.newPath) return file.newPath
  if (file.oldPath) return file.oldPath
  return ''
}

interface DiffBlock {
  file: ReturnType<typeof parseDiff>[number]
  raw: string
}

/** Split a raw git diff into per-file blocks, each carrying its parsed file plus the raw block text. */
function splitDiffBlocks(diff: string): DiffBlock[] {
  return diff
    .split(/^(?=diff --git)/m)
    .filter((block) => block.trim().length > 0)
    .map((raw) => ({ raw, file: parseDiff(raw)[0] }))
    .filter((block) => block.file)
}

/** True when a parsed file has hunks: only binary files and mode changes end up hunk-less. */
function isHunkless(file: ReturnType<typeof parseDiff>[number]): boolean {
  return file.hunks.length === 0
}

function noHunkLabel(block: DiffBlock): string {
  const { file, raw } = block
  if (/Binary files/.test(raw)) return 'binary file'
  if (/old mode|new mode/.test(raw)) return 'mode change'
  if (file.oldMode !== file.newMode) return 'mode change'
  return 'no diff content'
}

function DiffFileList({ blocks, onSelect }: { blocks: DiffBlock[]; onSelect: (block: DiffBlock) => void }) {
  return (
    <div data-testid="diff-file-list" className="border-border-subtle bg-surface sticky top-0 z-20 border-b px-2 py-1">
      {blocks.map((block) => {
        const file = block.file
        const path = formatPath(file)
        const { added, deleted } = countChanges(file.hunks)
        return (
          <div
            key={path || file.oldPath || file.newPath}
            role="button"
            tabIndex={0}
            data-testid="diff-file-list-item"
            data-file-path={path}
            onClick={() => onSelect(block)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(block)
              }
            }}
            className="cp-11 text-text-muted hover:bg-surface-raised hover:text-text flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left font-mono leading-tight"
          >
            <span className="min-w-0 flex-1 truncate">{path}</span>
            {isHunkless(file) ? (
              <span className="cp-10 text-text-subtle shrink-0">{noHunkLabel(block)}</span>
            ) : (
              <span className="cp-10 shrink-0 font-mono">
                <span className="text-positive">+{added}</span>
                <span className="text-negative ml-2">-{deleted}</span>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function HunklessSection({ block }: { block: DiffBlock }) {
  const file = block.file
  return (
    <div
      data-testid="diff-file-section"
      data-file-path={formatPath(file)}
      className="border-border-subtle border-b last:border-b-0"
    >
      <div className="cp-11 text-text flex items-center gap-2 px-2 py-1 font-mono leading-tight">
        <span data-testid="diff-file-section-path" className="min-w-0 flex-1 truncate">
          {formatPath(file)}
        </span>
        <span className="cp-10 text-text-subtle shrink-0 font-mono tracking-[0.08em] uppercase">
          {noHunkLabel(block)}
        </span>
      </div>
    </div>
  )
}

function ScrollTopFab({
  scroller,
  onScroll,
  className,
}: {
  scroller: HTMLElement | null
  onScroll: () => void
  className?: string
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="diff-scroll-top"
      aria-label="Torna in cima"
      title="Torna in cima"
      onClick={onScroll}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onScroll()
        }
      }}
      className={
        className ??
        'border-accent/30 bg-accent/15 text-accent hover:bg-accent/25 absolute right-3 bottom-3 z-30 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border shadow-lg backdrop-blur hover:shadow-xl'
      }
    >
      <ArrowUp size={16} />
    </div>
  )
}

function DiffView({
  diff,
  viewType = 'unified',
  onViewTypeChange,
  compact,
}: {
  diff: string
  viewType?: 'unified' | 'split'
  onViewTypeChange?: (view: 'unified' | 'split') => void
  compact?: boolean
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [showTop, setShowTop] = React.useState(false)
  let blocks: DiffBlock[] = []
  try {
    blocks = splitDiffBlocks(diff)
  } catch {
    /* keep empty so the fallback shows raw text */
  }

  const renderHunks = (hunks: ReturnType<typeof parseDiff>[number]['hunks']) => (hs: typeof hunks) =>
    hs.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)

  const scrollToFile = (block: DiffBlock) => {
    const path = formatPath(block.file)
    const scroller = containerRef.current
    const target = scroller?.querySelector<HTMLElement>(
      `[data-testid="diff-file-section"][data-file-path="${path.replace(/"/g, '\\"')}"]`,
    )
    if (!scroller || !target) return
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: target.offsetTop - scroller.offsetTop, behavior: 'smooth' })
    }
  }

  const scrollToTop = () => {
    const scroller = containerRef.current
    if (scroller && typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (blocks.length === 0) {
    return (
      <pre
        data-testid={compact ? undefined : 'context-diff'}
        tabIndex={compact ? undefined : 0}
        className={
          compact
            ? 'rdv-scope cp-11 cp-leading-tight text-text-muted m-0 min-w-0 px-2 py-1 break-all whitespace-pre-wrap'
            : 'rdv-scope cp-11 cp-leading-tight text-text-muted m-0 min-w-max overflow-x-auto overflow-y-scroll px-2 py-1 whitespace-pre'
        }
      >
        {diff}
      </pre>
    )
  }

  if (compact) {
    return (
      <div ref={containerRef} className="rdv-scope relative max-w-full min-w-0 overflow-x-auto">
        {blocks.map((block) => {
          const file = block.file
          const path = formatPath(file)
          if (isHunkless(file)) return <HunklessSection key={path || file.oldPath} block={block} />
          return (
            <div
              key={path || file.oldPath}
              data-testid="diff-file-section"
              data-file-path={path}
              className="border-border-subtle border-b last:border-b-0"
            >
              <div className="border-border-subtle bg-surface cp-11 text-text flex items-center gap-2 border-b px-2 py-1 font-mono leading-tight">
                <span data-testid="diff-file-section-path" className="min-w-0 flex-1 truncate">
                  {path}
                </span>
                <span className="cp-10 text-positive shrink-0 font-mono">+{countChanges(file.hunks).added}</span>
                <span className="cp-10 text-negative shrink-0 font-mono">-{countChanges(file.hunks).deleted}</span>
              </div>
              <Diff viewType={viewType} diffType={file.type ?? 'modify'} hunks={file.hunks} className="rdv-root">
                {renderHunks(file.hunks)}
              </Diff>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="rdv-scope bg-surface relative flex min-h-0 max-w-full min-w-0 flex-1 flex-col">
      <div
        ref={containerRef}
        data-testid="context-diff"
        tabIndex={0}
        onScroll={() => {
          const el = containerRef.current
          setShowTop(Boolean(el && el.scrollTop > 300))
        }}
        className="flex min-h-0 max-w-full min-w-0 flex-1 flex-col overflow-x-auto overflow-y-scroll overscroll-contain px-1.5 py-1"
      >
        {blocks.length > 1 && <DiffFileList blocks={blocks} onSelect={scrollToFile} />}
        {blocks.map((block) => {
          const file = block.file
          const path = formatPath(file)
          if (isHunkless(file)) return <HunklessSection key={path || file.oldPath} block={block} />
          return (
            <div
              key={path || file.oldPath}
              data-testid="diff-file-section"
              data-file-path={path}
              className="border-border-subtle border-b last:border-b-0"
            >
              <div className="border-border-subtle bg-surface cp-11 text-text flex items-center gap-2 border-b px-2 py-1 font-mono leading-tight">
                <span data-testid="diff-file-section-path" className="min-w-0 flex-1 truncate">
                  {path}
                </span>
                <span className="cp-10 text-positive shrink-0 font-mono">+{countChanges(file.hunks).added}</span>
                <span className="cp-10 text-negative shrink-0 font-mono">-{countChanges(file.hunks).deleted}</span>
              </div>
              <Diff viewType={viewType} diffType={file.type ?? 'modify'} hunks={file.hunks} className="rdv-root">
                {renderHunks(file.hunks)}
              </Diff>
            </div>
          )
        })}
      </div>
      {showTop && <ScrollTopFab scroller={containerRef.current} onScroll={scrollToTop} />}
    </div>
  )
}

function CommitDetailView({ detail, loading }: { detail?: unknown; loading?: boolean }) {
  if (loading)
    return (
      <div
        data-testid="context-commit-inspector"
        className="bg-surface-sunken text-text-muted flex min-h-0 flex-1 flex-col overflow-hidden p-3 font-mono text-xs"
        role="status"
      >
        Loading commit detail…
      </div>
    )
  if (!detail || typeof detail !== 'object')
    return (
      <div
        data-testid="context-commit-inspector"
        className="bg-surface-sunken text-text-muted flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden p-3 text-center"
      >
        <GitCommitHorizontal size={22} className="text-accent" />
        <p className="text-xs">Select a commit to inspect its details.</p>
      </div>
    )
  const commit = detail as CommitDetail
  const [showCommitTop, setShowCommitTop] = React.useState(false)
  const commitScrollRef = React.useRef<HTMLDivElement>(null)
  const scrollCommitToFile = (path: string) => {
    const inspector = document.querySelector<HTMLElement>('[data-testid="context-commit-inspector"]')
    const target = inspector?.querySelector<HTMLElement>(
      `[data-testid="diff-file-section"][data-file-path="${path.replace(/"/g, '\\"')}"]`,
    )
    if (target && typeof target.scrollIntoView === 'function')
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const scrollCommitTop = () => {
    const scroller = commitScrollRef.current
    if (scroller && typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: 0, behavior: 'smooth' })
  }
  return (
    <div
      data-testid="context-commit-inspector"
      className="bg-surface-sunken relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div
        ref={commitScrollRef}
        data-testid="context-commit-scroll"
        tabIndex={0}
        onScroll={() => {
          const el = commitScrollRef.current
          setShowCommitTop(Boolean(el && el.scrollTop > 300))
        }}
        className="min-h-0 flex-1 space-y-2 overflow-x-hidden overflow-y-auto px-3 py-2"
      >
        <div data-testid="context-commit-detail">
          <h3 className="text-text text-sm leading-snug font-semibold break-words">{commit.subject}</h3>
          <dl data-testid="commit-meta-grid" className="mt-2 grid grid-cols-1 gap-1.5">
            <div className="flex items-center gap-2.5">
              <dt className="cp-10 text-text-subtle flex w-24 shrink-0 items-center gap-1.5 font-semibold tracking-[0.08em] uppercase">
                <UserRound size={14} className="text-text-subtle shrink-0" />
                Autore
              </dt>
              <dd className="cp-12 text-text min-w-0" title={commit.author}>
                {commit.author}
              </dd>
            </div>
            <div className="flex items-center gap-2.5">
              <dt className="cp-10 text-text-subtle flex w-24 shrink-0 items-center gap-1.5 font-semibold tracking-[0.08em] uppercase">
                <Clock3 size={14} className="text-text-subtle shrink-0" />
                Data
              </dt>
              <dd className="cp-12 text-text min-w-0">
                <time dateTime={commit.date} title={commit.date}>
                  {relativeTime(commit.date)}
                </time>
              </dd>
            </div>
            <div className="flex items-center gap-2.5">
              <dt className="cp-10 text-text-subtle flex w-24 shrink-0 items-center gap-1.5 font-semibold tracking-[0.08em] uppercase">
                <GitCommitHorizontal size={14} className="text-text-subtle shrink-0" />
                Hash
              </dt>
              <dd className="cp-11 text-accent min-w-0 font-mono break-all" title={commit.hash}>
                {commit.hash.slice(0, 7)}
              </dd>
            </div>
          </dl>
        </div>
        <section>
          <div className="cp-10 text-text-muted mb-1 flex items-center gap-1.5 font-semibold tracking-[0.14em] uppercase">
            <FileText size={12} />
            Changed files <span className="text-text-subtle">{commit.files.length}</span>
          </div>
          <div className="divide-border-subtle divide-y">
            {commit.files.length === 0 ? (
              <p className="text-text-muted px-1 py-2 text-xs">No file changes reported.</p>
            ) : (
              commit.files.map((file) =>
                file.binary ? (
                  <div key={file.path} className="cp-11 flex items-center justify-between gap-3 px-1 py-1">
                    <span className="text-text min-w-0 truncate font-mono" title={file.path}>
                      {file.path}
                    </span>
                    <span className="cp-10 text-text-subtle shrink-0 font-mono">binary</span>
                  </div>
                ) : (
                  <div
                    key={file.path}
                    role="button"
                    tabIndex={0}
                    data-testid="commit-file-link"
                    data-file-path={file.path}
                    onClick={() => scrollCommitToFile(file.path)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        scrollCommitToFile(file.path)
                      }
                    }}
                    title={`Scroll to ${file.path} in the diff`}
                    className="cp-11 hover:bg-surface-raised flex w-full cursor-pointer items-center justify-between gap-3 px-1 py-1 text-left font-mono"
                  >
                    <span className="text-text hover:text-accent min-w-0 truncate transition-colors duration-100">
                      {file.path}
                    </span>
                    <span className="cp-10 shrink-0 font-mono">
                      <span className="text-positive">+{file.additions}</span>
                      <span className="text-negative ml-2">-{file.deletions}</span>
                    </span>
                  </div>
                ),
              )
            )}
          </div>
        </section>
        {commit.diff && (
          <details className="overflow-hidden" open>
            <summary className="border-border-subtle cp-10 text-text-muted cursor-pointer border-y px-1 py-1 font-semibold tracking-[0.14em] uppercase">
              Diff preview
            </summary>
            <DiffView diff={commit.diff} compact />
          </details>
        )}
      </div>
      {showCommitTop && <ScrollTopFab scroller={commitScrollRef.current} onScroll={scrollCommitTop} />}
    </div>
  )
}

export function ContextBreadcrumb({
  label,
  branch,
  commitMessage,
  commitCount,
  onBranchClick,
  lastUpdated,
  onRefresh,
  fileCount,
  viewType = 'unified',
  onViewTypeChange,
}: {
  label: 'DIFF' | 'HISTORY' | 'COMMIT' | 'CONTEXT'
  branch: string
  commitMessage?: string
  commitCount?: number
  onBranchClick?: () => void
  lastUpdated?: string
  onRefresh?: () => void
  fileCount?: number
  viewType?: 'unified' | 'split'
  onViewTypeChange?: (view: 'unified' | 'split') => void
}) {
  return (
    <div
      data-testid="context-breadcrumb"
      className="border-border-subtle cp-11 flex h-8 max-h-8 min-h-8 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b px-2 font-mono leading-none"
    >
      <span className="text-accent shrink-0 font-semibold tracking-[0.1em]">{label}</span>
      <span className="text-text-subtle">/</span>
      {onBranchClick ? (
        <span
          data-testid="context-breadcrumb-branch"
          role="link"
          tabIndex={0}
          onClick={onBranchClick}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onBranchClick()
            }
          }}
          className="text-text-muted hover:text-text min-w-0 cursor-pointer truncate text-left hover:underline focus-visible:underline"
          title={branch}
        >
          {branch}
        </span>
      ) : (
        <span className="text-text-muted min-w-0 truncate" title={branch}>
          {branch}
        </span>
      )}
      {commitMessage && (
        <>
          <span className="text-text-subtle">/</span>
          <span
            data-testid="context-breadcrumb-message"
            className="text-text-muted min-w-0 truncate"
            title={commitMessage}
          >
            {commitMessage}
          </span>
        </>
      )}
      {(commitCount !== undefined || fileCount !== undefined) && (
        <span className="text-text-subtle ml-auto shrink-0">
          {commitCount !== undefined
            ? `${commitCount} commits`
            : fileCount !== undefined
              ? `${fileCount} file${fileCount === 1 ? '' : 's'}`
              : ''}
        </span>
      )}
      {onViewTypeChange ? (
        <button
          data-testid="diff-view-toggle"
          type="button"
          onClick={() => onViewTypeChange(viewType === 'unified' ? 'split' : 'unified')}
          className="border-border cp-10 text-text-muted hover:bg-surface-raised hover:text-text shrink-0 rounded-md border px-1.5 py-0.5"
          aria-pressed={viewType === 'split'}
        >
          {viewType === 'unified' ? 'Split' : 'Unified'}
        </button>
      ) : (
        <span className="border-border cp-10 text-text-muted shrink-0 rounded-md border px-1.5 py-0.5">Unified</span>
      )}
      {lastUpdated && <span className="cp-11 text-text-subtle shrink-0 font-sans">Last updated {lastUpdated}</span>}
      {onRefresh && (
        <button
          data-testid="route-refresh"
          type="button"
          onClick={onRefresh}
          className="border-border cp-11 text-text-muted hover:text-text shrink-0 rounded-md border px-2 py-0.5"
        >
          ↻ Refresh
        </button>
      )}
    </div>
  )
}

export function ContextPanel({
  focus,
  snapshot,
  detail,
  loading,
  selectedCommitHash,
  onSelectCommit,
  lastUpdated,
  onRefresh,
  fileCount,
}: {
  focus: Focus | null
  snapshot: Snapshot
  detail?: unknown
  loading?: boolean
  selectedCommitHash?: string
  onSelectCommit?: (hash?: string) => void
  lastUpdated?: string
  onRefresh?: () => void
  fileCount?: number
}) {
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified')
  const isFile = focus?.kind === 'file'
  const isBranch = focus?.kind === 'branch'
  const isCommit = focus?.kind === 'commit'

  const contextual = isFile ? snapshot.fileDiffs[focus.value] : isBranch ? snapshot.branchLogs[focus.value] : detail
  const branchCapability = isBranch ? snapshot.capabilities.branchLogs : undefined
  const branchEntries = isBranch && Array.isArray(contextual) ? contextual : undefined
  const showingBranchCommit = Boolean(
    isBranch && selectedCommitHash && branchEntries?.some((entry) => entry.hash === selectedCommitHash),
  )
  const selectedBranchCommit = branchEntries?.find((entry) => entry.hash === selectedCommitHash)
  const selectedBranchHash =
    (selectedCommitHash && branchEntries?.some((entry) => entry.hash === selectedCommitHash)
      ? selectedCommitHash
      : undefined) ??
    branchEntries?.find((entry) => entry.hash === snapshot.head)?.hash ??
    branchEntries?.[0]?.hash
  const rightLabel = focus?.value ?? snapshot.project_id

  const branchCommitDetail = Boolean(isBranch && showingBranchCommit)
  const detailSubject = detail && typeof detail === 'object' && 'subject' in detail ? String(detail.subject) : undefined
  const label: 'DIFF' | 'HISTORY' | 'COMMIT' | 'CONTEXT' = isFile
    ? 'DIFF'
    : isCommit || branchCommitDetail
      ? 'COMMIT'
      : isBranch
        ? 'HISTORY'
        : 'CONTEXT'
  const breadcrumbBranch = isFile
    ? focus.value
    : isCommit
      ? detail && typeof detail === 'object' && 'hash' in detail
        ? String(detail.hash).slice(0, 7)
        : rightLabel
      : isBranch
        ? focus.value
        : rightLabel
  const breadcrumbMessage = isCommit ? detailSubject : branchCommitDetail ? selectedBranchCommit?.subject : undefined

  const logUnavailable = branchCapability?.status === 'error' || branchCapability?.status === 'unavailable'
  const logEmpty = branchEntries === undefined || branchEntries.length === 0

  return (
    <section
      data-testid="context-section"
      className="bg-surface flex min-h-0 min-w-0 flex-col overflow-hidden md:h-full"
    >
      <ContextBreadcrumb
        label={label}
        branch={breadcrumbBranch}
        commitMessage={breadcrumbMessage}
        commitCount={label === 'HISTORY' ? branchEntries?.length : undefined}
        onBranchClick={branchCommitDetail ? () => onSelectCommit?.(undefined) : undefined}
        lastUpdated={lastUpdated ? relativeTime(lastUpdated) : undefined}
        onRefresh={onRefresh}
        fileCount={fileCount}
        viewType={viewType}
        onViewTypeChange={setViewType}
      />

      <div data-testid="context-body" className="bg-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {isCommit || branchCommitDetail ? (
          <CommitDetailView detail={detail} loading={loading} />
        ) : isFile && typeof contextual === 'string' && contextual.length > 0 ? (
          <DiffView diff={contextual} viewType={viewType} onViewTypeChange={setViewType} />
        ) : isFile ? (
          <div data-testid="context-file-unavailable" className="text-text-muted p-4 font-mono text-xs" role="status">
            No diff preview is available for {focus.value}. The file may be missing, unreadable, or over the preview
            limit.
          </div>
        ) : isBranch ? (
          <div data-testid="context-branch-log" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {logUnavailable ? (
              <div className="p-4">
                <StatusStates state="error" label="branch log" />
              </div>
            ) : logEmpty ? (
              <div className="p-4">
                <StatusStates state="empty" label="branch log" />
              </div>
            ) : (
              <>
                {branchCapability?.status === 'stale' && (
                  <div role="status" className="border-warning/40 bg-warning/10 cp-11 text-warning border-b px-3 py-2">
                    Branch history is stale; showing last-known-good data.
                  </div>
                )}
                <GitLogTerminal
                  branch={focus.value}
                  commits={branchEntries}
                  selectedHash={selectedBranchHash}
                  onSelectCommit={onSelectCommit ?? (() => undefined)}
                />
              </>
            )}
          </div>
        ) : loading ? (
          <div className="text-text-muted p-4 font-mono text-xs" role="status">
            Loading detail…
          </div>
        ) : contextual !== undefined ? (
          <pre
            data-testid="context-detail"
            className="text-text-muted m-0 min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
          >
            {typeof contextual === 'string' ? contextual : JSON.stringify(contextual, null, 2)}
          </pre>
        ) : (
          <div className="text-text-muted p-4 font-mono text-xs" role="status">
            No context data is available for this selection.
          </div>
        )}
      </div>
    </section>
  )
}
