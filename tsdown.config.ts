import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('@ljcscp/dsh-fare-meter', [
  'src/index.ts',
  'src/invariant.ts',
], {
  lib: {
    // The host half resolves cordis, the credentials seam, the web-server
    // route seam, the session-projection registry, the storage-domain
    // facility, the session/llm SDK types, and zod at runtime from the dsh
    // profile tree, not from this repo's install. Their built declarations
    // carry .ts-suffixed relative imports rolldown cannot follow, so they
    // stay external.
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-storage-domain',
      'zod',
    ],
  },
})
