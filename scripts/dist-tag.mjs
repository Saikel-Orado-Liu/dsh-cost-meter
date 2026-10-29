#!/usr/bin/env node
/**
 * Release dist-tag policy for this plugin package.
 *
 * DSH ships two release lines on npm at once: `@deepseek-ai/dsh` names the
 * current line under `latest` and the upcoming one under `next`. A plugin
 * version only runs on the line whose runtime its `@deepseek-ai/dsh*` peer
 * ranges accept — the same check dsh-app-boot performs before it loads a
 * bundle. The community market installs the bare package name, i.e. whatever
 * `latest` names, so tagging every stable-numbered release `latest` hands
 * visitors a build their runtime may refuse to load.
 *
 * `resolve` picks the dist-tag for the version in package.json (print-only;
 * publish.yml feeds it to `npm publish --tag`). `reconcile` re-points every
 * tag at the newest published version that supports it, which also repairs
 * tags written by an older release process. `pairs` prints the whole table
 * without changing anything, and `whoami` reports the credential the write
 * path would use.
 *
 * Writing a tag needs a registry credential, and npm performs its
 * trusted-publishing OIDC exchange only inside the publish path — a repository
 * that publishes without a stored token has none here. The exchange is a plain
 * package-scoped POST, so this script repeats it and hands npm the result
 * through a private userconfig, keeping the token off every command line.
 *
 * Usage:
 *   node scripts/dist-tag.mjs resolve
 *   node scripts/dist-tag.mjs reconcile [--dry-run] [--wait-for <version>]
 *   node scripts/dist-tag.mjs pairs
 *   node scripts/dist-tag.mjs whoami
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = '@deepseek-ai/dsh'
/** DSH release lines a plugin tag can mirror, most preferred first. */
const LINES = ['latest', 'next']
/** Tag a version carries when the plugin itself marks it prerelease. */
const PRERELEASE_TAG = 'alpha'
/** Registry the package publishes to; also the OIDC audience and the auth key. */
const REGISTRY = 'https://registry.npmjs.org/'

/**
 * Run npm and return its trimmed stdout, keeping its stderr visible. The comment
 * is a command string rather than an argv list so one path covers Windows, where
 * npm is a .cmd shim node refuses to spawn without a shell. Callers pass only
 * package names, versions, and flags — nothing a shell could reinterpret.
 */
function npm(args) {
  return execSync(`npm ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

/** Run npm with --json and parse the answer, tolerating leading notices. */
function npmJson(args, online = false) {
  const text = npm([...args, ...(online ? ['--prefer-online'] : []), '--json'])
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error(`npm ${args.join(' ')} returned no JSON: ${text}`)
  return JSON.parse(text.slice(start))
}

/** npm answers a single requested version as a one-element list. */
function unwrap(value) {
  return Array.isArray(value) ? value[0] : value
}

/** The `_authToken` config key npm reads for this registry. */
function authTokenKey() {
  const url = new URL(REGISTRY)
  return `//${url.host}${url.pathname}:_authToken`
}

/**
 * Exchange this run's GitHub OIDC token for a package-scoped npm token.
 *
 * Returns undefined outside GitHub Actions or without `id-token: write`; throws
 * when the environment offered a token the identity provider or the registry
 * refused, because that failure must not look like a successful reconcile.
 */
async function exchangeOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (requestUrl === undefined || requestToken === undefined) return undefined
  const url = new URL(requestUrl)
  url.searchParams.append('audience', `npm:${new URL(REGISTRY).hostname}`)
  const issued = await fetch(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${requestToken}` },
  })
  if (!issued.ok) throw new Error(`GitHub answered the id_token request with ${issued.status}`)
  const { value: idToken } = await issued.json()
  if (typeof idToken !== 'string' || idToken === '') throw new Error('the GitHub id_token response carried no token')
  const exchanged = await fetch(
    new URL(`/-/npm/v1/oidc/token/exchange/package/${manifest.name.replace('/', '%2F')}`, REGISTRY),
    { method: 'POST', headers: { authorization: `Bearer ${idToken}` } },
  )
  if (!exchanged.ok) throw new Error(`the npm token exchange answered ${exchanged.status}`)
  const { token } = await exchanged.json()
  if (typeof token !== 'string' || token === '') throw new Error('the npm token exchange carried no token')
  return token
}

/**
 * Hand the write path a credential: an explicit NPM_TOKEN wins, otherwise the
 * trusted-publishing exchange. The token reaches npm through a private
 * userconfig, never as an argument.
 */
async function authenticate() {
  const stored = process.env.NPM_TOKEN
  const token = stored !== undefined && stored !== '' ? stored : await exchangeOidcToken()
  if (token === undefined) {
    console.error('dist-tag: no NPM_TOKEN and no GitHub OIDC request token; relying on npm\'s own configuration')
    return
  }
  const file = join(mkdtempSync(join(tmpdir(), 'dsh-dist-tag-')), '.npmrc')
  writeFileSync(file, `registry=${REGISTRY}\n${authTokenKey()}=${token}\n`)
  process.env.NPM_CONFIG_USERCONFIG = file
  console.error(stored !== undefined && stored !== '' ? 'dist-tag: using NPM_TOKEN' : 'dist-tag: exchanged the GitHub OIDC token')
}

/** The peers the runtime gate evaluates: @deepseek-ai/dsh and its subpackages. */
function dshPeers(manifest) {
  const peers = manifest.peerDependencies ?? {}
  return Object.entries(peers).filter(([name]) => name === DSH || name.startsWith(`${DSH}-`))
}

/** Whether every declared dsh peer accepts a runtime version. */
function supports(peers, runtimeVersion) {
  return peers.every(([, range]) => typeof range === 'string'
    && semver.satisfies(runtimeVersion, range, { includePrerelease: true }))
}

/** The runtime version serving each DSH line, from the registry's own dist-tags. */
function dshLines() {
  const tags = unwrap(npmJson(['view', DSH, 'dist-tags']))
  return Object.fromEntries(LINES
    .filter(line => typeof tags[line] === 'string')
    .map(line => [line, tags[line]]))
}

/**
 * The dist-tag one version belongs on, or null when no DSH line accepts it.
 * A `-next.` prerelease belongs on the next channel (the branch that tracks
 * DSH's upcoming line); every other prerelease is an alpha build.
 */
function tagOf(manifest, lines) {
  const prerelease = semver.prerelease(manifest.version)
  if (prerelease !== null) {
    return prerelease.some(part => String(part).toLowerCase() === 'next') ? 'next' : PRERELEASE_TAG
  }
  const peers = dshPeers(manifest)
  for (const line of LINES) {
    const runtime = lines[line]
    if (runtime !== undefined && supports(peers, runtime)) return line
  }
  return null
}

/** Every published version of the package, in registry order. */
function publishedVersions(name, online = false) {
  const versions = npmJson(['view', name, 'versions'], online)
  return Array.isArray(versions) ? versions : [versions]
}

/**
 * Wait until the registry reports a just-published version. npm publish
 * returns before the package is readable through the packument, so a
 * reconcile started immediately after publish can otherwise tag the OLD
 * newest version as latest. `--prefer-online` bypasses npm's metadata cache.
 * @param name - package name.
 * @param version - version the publish just added.
 * @param timeoutMs - maximum wait.
 * @throws when the version never appears.
 */
async function waitForPublishedVersion(name, version, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (publishedVersions(name, true).includes(version)) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${name}@${version} to appear on the registry`)
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
}

/** One published version's manifest fields (npm answers as an object or a list). */
function manifestOf(name, version, online = false) {
  const manifest = unwrap(npmJson(['view', `${name}@${version}`, 'version', 'peerDependencies'], online))
  // npm answers a version with no peerDependencies as a bare version string
  // (sometimes a one-element array) instead of an object.
  return typeof manifest === 'string' ? { version: manifest } : manifest
}

/** version → tag for every published version, plus the lines it was judged against. */
function table(name, lines, online = false) {
  return publishedVersions(name, online).map((version) => {
    const manifest = manifestOf(name, version, online)
    return { version: typeof manifest.version === 'string' ? manifest.version : version, tag: tagOf(manifest, lines) }
  })
}

/** The newest version per tag; unsupported versions are reported and left alone. */
function newestPerTag(rows) {
  const newest = new Map()
  for (const { version, tag } of rows) {
    if (tag === null) continue
    const current = newest.get(tag)
    if (current === undefined || semver.gt(version, current)) newest.set(tag, version)
  }
  return newest
}

const [command = 'pairs', ...flags] = process.argv.slice(2)
/** Reconcile can wait for a version that `npm publish` has just added. */
const waitFor = flags.find(flag => flag.startsWith('--wait-for='))?.slice('--wait-for='.length)
const dryRun = flags.includes('--dry-run')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const lines = dshLines()

if (command === 'resolve') {
  const tag = tagOf(manifest, lines)
  if (tag === null) {
    console.error(`dist-tag: ${manifest.name}@${manifest.version} supports no DSH line (${JSON.stringify(lines)}); refusing to publish untagged`)
    process.exit(1)
  }
  console.error(`dist-tag: ${manifest.name}@${manifest.version} -> ${tag} (DSH lines ${JSON.stringify(lines)})`)
  process.stdout.write(tag + '\n')
} else if (command === 'whoami') {
  await authenticate()
  console.error(`dist-tag: npm whoami -> ${npm(['whoami'])}`)
} else if (command === 'pairs' || command === 'reconcile') {
  if (waitFor !== undefined && command === 'reconcile') await waitForPublishedVersion(manifest.name, waitFor)
  const rows = table(manifest.name, lines, waitFor !== undefined)
  for (const { version, tag } of rows) console.error(`dist-tag: ${version} -> ${tag ?? 'unsupported (left alone)'}`)
  if (command === 'pairs') process.exit(0)
  const newest = newestPerTag(rows)
  if (!dryRun) await authenticate()
  for (const [tag, version] of newest) {
    if (dryRun) {
      console.error(`dist-tag: would set ${tag} -> ${version}`)
      continue
    }
    npm(['dist-tag', 'add', `${manifest.name}@${version}`, tag])
    console.error(`dist-tag: ${tag} -> ${version}`)
  }
} else {
  console.error(`dist-tag: unknown command ${JSON.stringify(command)}; expected resolve, reconcile, pairs, or whoami`)
  process.exit(2)
}