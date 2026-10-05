import React from 'react'
import { ApiError, projectsApi } from '../api'
import type { TreeResponse } from '../types'
import { CodeTree } from './CodeTree'

type PlansApi = Pick<typeof projectsApi, 'plansTree'>
type RootState =
  | { status: 'loading' | 'unlinked' | 'empty' | 'error' }
  | { status: 'ready'; tree: TreeResponse }

export function PlansTree({
  projectId,
  selectedPath,
  onSelectFile,
  api = projectsApi,
}: {
  projectId: string
  selectedPath?: string
  onSelectFile: (path: string) => void
  api?: PlansApi
}) {
  const [root, setRoot] = React.useState<RootState>({ status: 'loading' })
  React.useEffect(() => {
    let active = true
    setRoot({ status: 'loading' })
    api
      .plansTree(projectId)
      .then((tree) => {
        if (!active) return
        setRoot(tree.entries.length === 0 ? { status: 'empty' } : { status: 'ready', tree })
      })
      .catch((error: unknown) => {
        if (!active) return
        setRoot(error instanceof ApiError && error.status === 404 ? { status: 'unlinked' } : { status: 'error' })
      })
    return () => {
      active = false
    }
  }, [api, projectId])
  const treeApi = React.useMemo(
    () => ({
      tree: (id: string, path = '') =>
        path === '' && root.status === 'ready' ? Promise.resolve(root.tree) : api.plansTree(id, path),
    }),
    [api, root],
  )
  return (
    <div data-testid="plans-tree" className="min-w-0">
      {root.status !== 'ready' && (
        <div data-testid="plans-state" data-state={root.status} role="status" className="cp-11 text-text-muted px-2 py-1">
          {root.status === 'loading'
            ? 'Loading plans…'
            : root.status === 'unlinked'
              ? 'No plans folder is linked to this project.'
              : root.status === 'empty'
                ? 'No plans yet.'
                : 'Unable to load plans.'}
        </div>
      )}
      {root.status === 'ready' && (
        <CodeTree
          projectId={projectId}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          api={treeApi}
        />
      )}
    </div>
  )
}
