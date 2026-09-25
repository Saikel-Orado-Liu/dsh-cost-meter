/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 *
 * This list mirrors the shell's own seed table (`getStaticModules` in
 * `dsh-web-frontend`): DSH 0.1.7 seeds the snapshot-store engine as a platform
 * singleton and adds the dock kit, while `dsh-client-web-react` and
 * `dsh-client-schema-form` are no longer seeded at all. A specifier that is not
 * in this list would be inlined into a plugin bundle — a duplicate runtime
 * instance for anything with identity — so the table is copied verbatim.
 * @module @deepseek-ai/dsh-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
