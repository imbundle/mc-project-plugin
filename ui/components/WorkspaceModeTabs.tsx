import React from 'react'

export type WorkspaceMode = 'git' | 'code' | 'plans'

const ITEMS: { value: WorkspaceMode; label: string }[] = [
  { value: 'git', label: 'Git' },
  { value: 'code', label: 'Code' },
  { value: 'plans', label: 'Plans' },
]

export function WorkspaceModeTabs({
  mode,
  onChange,
}: {
  mode: WorkspaceMode
  onChange: (mode: WorkspaceMode) => void
}) {
  const select = (value: WorkspaceMode) => {
    if (value !== mode) onChange(value)
  }
  const onKeyDown = (event: React.KeyboardEvent, value: WorkspaceMode) => {
    const index = ITEMS.findIndex((item) => item.value === value)
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      select(ITEMS[(index + 1) % ITEMS.length].value)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      select(ITEMS[(index - 1 + ITEMS.length) % ITEMS.length].value)
    } else if (event.key === 'Home') {
      event.preventDefault()
      select(ITEMS[0].value)
    } else if (event.key === 'End') {
      event.preventDefault()
      select(ITEMS[ITEMS.length - 1].value)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(value)
    }
  }
  return (
    <div
      data-testid="workspace-mode-tabs"
      role="tablist"
      aria-label="Workspace mode"
      className="flex items-center gap-1 rounded-md px-1"
    >
      {ITEMS.map((item) => {
        const active = item.value === mode
        return (
          <div
            key={item.value}
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            data-mode={item.value}
            onClick={() => select(item.value)}
            onKeyDown={(event) => onKeyDown(event, item.value)}
            className={`focus-visible:ring-accent cp-12 cursor-pointer rounded px-2 py-0.5 outline-none select-none focus-visible:ring-1 focus-visible:ring-inset ${
              active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-surface-sunken/60 hover:text-text'
            }`}
          >
            {item.label}
          </div>
        )
      })}
    </div>
  )
}
