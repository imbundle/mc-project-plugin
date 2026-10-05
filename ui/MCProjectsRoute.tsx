import React from 'react'
import { projectsApi } from './api'
import { canMutate, repositoryName } from './models'
import { createRouteController, selectorOptions } from './routeBehavior'
import type { Snapshot } from './types'
import { ProjectSelector } from './components/ProjectSelector'
import { SidebarSections } from './components/SidebarSections'
import { ContextPanel } from './components/ContextPanel'
import { StatusStates } from './components/StatusStates'
import { WorkspaceModeTabs } from './components/WorkspaceModeTabs'
import { CodeTree } from './components/CodeTree'
import { CodeViewer } from './components/CodeViewer'
import { PlansTree } from './components/PlansTree'
import { PlansViewer } from './components/PlansViewer'

function CapabilityNotice({ name, capability }: { name: string; capability?: Snapshot['capabilities'][string] }) {
  if (!capability || capability.status === 'ready' || capability.status === 'empty') return null
  const label =
    capability.status === 'stale'
      ? 'stale; last-known-good data shown'
      : capability.status === 'error'
        ? 'error; capability unavailable'
        : 'unavailable'
  return (
    <div role="status" className="border-warning/40 bg-warning/10 cp-11 text-warning rounded border px-2 py-1">
      {name}: {label}
    </div>
  )
}

export default function MCProjectsRoute() {
  const controller = React.useRef(createRouteController(projectsApi)).current
  const route = React.useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const [branchValue, setBranchValue] = React.useState('')
  const refreshInFlight = React.useRef(false)
  const runRefresh = React.useCallback(() => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    void controller
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        refreshInFlight.current = false
      })
  }, [controller])
  React.useEffect(() => {
    void controller.mount()
    return () => controller.unmount()
  }, [controller])
  React.useEffect(() => {
    if (route.mode !== 'git') return
    let active = true
    const timer = window.setInterval(() => {
      if (active) runRefresh()
    }, 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [route.mode, runRefresh])
  const {
    catalog,
    activeId,
    snapshot,
    focus,
    detail,
    detailLoading,
    loading,
    error,
    selectorOpen,
    mutation,
    mutationBusy,
    mutationMessage,
    selectedCommitHash,
    mode,
    codePath,
    codeFile,
    codeLoading,
    codeError,
    planPath,
    planFile,
    planLoading,
    planError,
  } = route
  const active = catalog.find((project) => project.project_id === activeId)
  const selectProject = controller.selectProject
  const selectFocus = controller.selectFocus
  const mutate = (kind: 'switch' | 'create', value: string) => {
    if (!snapshot || !canMutate(snapshot) || mutationBusy) return
    void controller.mutate(kind, value).then(() => setBranchValue(''))
  }
  const handleBranchSwitch = (name: string) => mutate('switch', name)
  const handleBranchCreate = (name: string) => mutate('create', name)
  if (error && !snapshot)
    return (
      <main className="bg-surface text-text flex h-full min-h-0 w-full flex-col overflow-x-hidden overflow-y-auto">
        <StatusStates state="error" label="projects" />
      </main>
    )
  if (loading && !snapshot)
    return (
      <main className="bg-surface text-text flex h-full min-h-0 w-full flex-col overflow-x-hidden overflow-y-auto">
        <StatusStates state="loading" label="projects" />
      </main>
    )
  if (!active || !snapshot)
    return (
      <main className="bg-surface text-text flex h-full min-h-0 w-full flex-col overflow-x-hidden overflow-y-auto">
        <StatusStates state="empty" label="projects" />
      </main>
    )
  const mutationAllowed = Boolean(snapshot && canMutate(snapshot) && !mutationBusy)
  return (
    <main
      data-testid="mc-projects-route"
      className="bg-surface text-text flex h-full max-h-full min-h-0 w-full max-w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain md:overflow-hidden"
    >
      <header id="mc-project-header" className="workspace-grid min-h-9 shrink-0">
        <ProjectSelector
          active={active}
          projects={selectorOptions(catalog, active.project_id)}
          open={selectorOpen}
          onToggle={controller.toggleSelector}
          onSelect={selectProject}
          activeBranch={snapshot.branches.local.find((b) => b.current)?.name}
          activeChanged={snapshot.workingTree.files?.length}
          activeRepository={repositoryName(snapshot.project.repository ?? '') ?? active.project_id}
        />
        <div className="min-w-0 shrink-0 items-center px-2">
          <WorkspaceModeTabs mode={mode} onChange={controller.setMode} />
        </div>
      </header>
      {loading && (
        <div className="border-border cp-11 text-text-muted shrink-0 border-b px-4 py-1" role="status">
          Refreshing; last-known-good data is shown.
        </div>
      )}
      {error && (
        <div className="border-border cp-11 text-warning shrink-0 border-b px-4 py-1" role="status">
          Refresh unavailable; showing last-known-good data.
        </div>
      )}
      <div className="workspace-grid min-h-0 flex-1 md:overflow-hidden">
        {mode === 'code' ? (
          <>
            <aside
              id="mc-project-sidebar"
              className="min-w-0 space-y-2 border-b p-2 md:min-h-0 md:overflow-y-auto md:border-b-0"
            >
              <CodeTree
                projectId={active.project_id}
                selectedPath={codePath}
                onSelectFile={(path) => void controller.openCodeFile(path)}
              />
            </aside>
            <div id="mc-project-context-column" className="min-h-0 min-w-0 overflow-hidden md:h-full">
              <CodeViewer
                projectId={active.project_id}
                path={codePath}
                file={codeFile}
                loading={codeLoading}
                error={codeError}
              />
            </div>
          </>
        ) : mode === 'plans' ? (
          <>
            <aside
              id="mc-project-sidebar"
              className="min-w-0 space-y-2 border-b p-2 md:min-h-0 md:overflow-y-auto md:border-b-0"
            >
              <PlansTree
                key={active.project_id}
                projectId={active.project_id}
                selectedPath={planPath}
                onSelectFile={(path) => void controller.openPlanFile(path)}
              />
            </aside>
            <div id="mc-project-context-column" className="min-h-0 min-w-0 overflow-hidden md:h-full">
              <PlansViewer path={planPath} file={planFile} loading={planLoading} error={planError} />
            </div>
          </>
        ) : (
          <>
            <aside
              id="mc-project-sidebar"
              className="min-w-0 space-y-2 border-b p-2 md:min-h-0 md:overflow-y-auto md:border-b-0"
            >
              <CapabilityNotice
                name="working tree"
                capability={snapshot.capabilities.workingTree as Snapshot['capabilities'][string]}
              />
              <CapabilityNotice
                name="branches"
                capability={snapshot.capabilities.branches as Snapshot['capabilities'][string]}
              />
              <CapabilityNotice
                name="commits"
                capability={snapshot.capabilities.commits as Snapshot['capabilities'][string]}
              />
              <CapabilityNotice
                name="branch logs"
                capability={snapshot.capabilities.branchLogs as Snapshot['capabilities'][string]}
              />
              <CapabilityNotice
                name="GitHub"
                capability={snapshot.capabilities.github as Snapshot['capabilities'][string]}
              />
              <SidebarSections
                snapshot={snapshot}
                focus={focus}
                mutationMessage={mutationMessage}
                mutationBusy={mutationBusy}
                selectedCommitHash={selectedCommitHash}
                onSelectFile={(path) => void selectFocus({ kind: 'file', value: path })}
                onSelectBranch={(name) => void selectFocus({ kind: 'branch', value: name })}
                onSelectCommit={(hash) => void selectFocus({ kind: 'commit', value: hash })}
                onSwitch={handleBranchSwitch}
                onCreate={handleBranchCreate}
              />
            </aside>
            <div id="mc-project-context-column" className="min-h-0 min-w-0 overflow-hidden md:h-full">
              <ContextPanel
                focus={focus}
                snapshot={snapshot}
                detail={detail}
                loading={detailLoading}
                selectedCommitHash={selectedCommitHash}
                onSelectCommit={(hash) => void controller.selectCommit(hash)}
                lastUpdated={snapshot.observedAt}
                onRefresh={runRefresh}
              />
            </div>
          </>
        )}
      </div>
    </main>
  )
}
