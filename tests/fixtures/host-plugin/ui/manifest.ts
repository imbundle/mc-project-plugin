import type { HostPluginManifest } from './types.ts'

const manifest: HostPluginManifest = {
  id: 'mc-project-plugin',
  name: 'Projects',
  routePath: '/mc-project-plugin',
  endpoints: [
    { method: 'GET', path: '/mc-project-plugin/projects/catalog', handler: 'listProjects', authRequired: true },
    { method: 'GET', path: '/mc-project-plugin/projects/snapshot', handler: 'getSnapshot', authRequired: true },
    { method: 'GET', path: '/mc-project-plugin/projects/commit', handler: 'getCommitDetail', authRequired: true },
    {
      method: 'GET',
      path: '/mc-project-plugin/projects/pull-request',
      handler: 'getPullRequestDetail',
      authRequired: true,
    },
    { method: 'POST', path: '/mc-project-plugin/projects/branch/switch', handler: 'switchBranch', authRequired: true },
    { method: 'POST', path: '/mc-project-plugin/projects/branch/create', handler: 'createBranch', authRequired: true },
    { method: 'GET', path: '/mc-project-plugin/projects/tree', handler: 'listTree', authRequired: true },
    { method: 'GET', path: '/mc-project-plugin/projects/file', handler: 'readFile', authRequired: true },
    { method: 'GET', path: '/mc-project-plugin/projects/file/raw', handler: 'readFileRaw', authRequired: true },
    { method: 'GET', path: '/mc-project-plugin/projects/plans/tree', handler: 'listPlansTree', authRequired: true },
    { method: 'GET', path: '/mc-project-plugin/projects/plans/file', handler: 'readPlanFile', authRequired: true },
  ],
}

export default manifest
