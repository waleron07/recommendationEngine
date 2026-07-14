#!/usr/bin/env node
/**
 * Architecture guard. Runs in CI before build.
 *
 * The design doc makes three promises that prose cannot keep on its own. A promise
 * a machine does not check is a promise that expires the first busy afternoon, so
 * each one is asserted here:
 *
 *   1. @recoengine/core has zero runtime dependencies.            (ARCHITECTURE.md §2)
 *   2. Dependencies only ever point left: core <- plugins <- meta. (§4)
 *   3. core imports no Node API, so it runs on Bun, Deno and in
 *      the browser. tsconfig `types: []` is the first line of
 *      defence; this catches `node:*` specifiers it cannot see.   (§23.5)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG_DIR = join(ROOT, 'packages')

/** Who may depend on whom. A package may only depend on packages listed here. */
const ALLOWED_DEPS = {
  '@recoengine/core': [],
  '@recoengine/features': ['@recoengine/core'],
  '@recoengine/strategies': ['@recoengine/core'],
  '@recoengine/modifiers': ['@recoengine/core'],
  '@recoengine/diversity': ['@recoengine/core'],
  '@recoengine/testing': ['@recoengine/core'],
  recoengine: [
    '@recoengine/core',
    '@recoengine/features',
    '@recoengine/strategies',
    '@recoengine/modifiers',
    '@recoengine/diversity',
  ],
}

const errors = []

function fail(message) {
  errors.push(message)
}

/** Every .ts file under a directory, tests included. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') out.push(...walk(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

const packageNames = readdirSync(PKG_DIR).filter((d) => statSync(join(PKG_DIR, d)).isDirectory())

for (const dir of packageNames) {
  const manifestPath = join(PKG_DIR, dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const name = manifest.name
  const allowed = ALLOWED_DEPS[name]

  if (allowed === undefined) {
    fail(`packages/${dir}: "${name}" is not listed in ALLOWED_DEPS. Add it to scripts/check-arch.mjs first.`)
    continue
  }

  const deps = Object.keys(manifest.dependencies ?? {})

  // Rule 1: the core's zero-dependency promise.
  if (name === '@recoengine/core' && deps.length > 0) {
    fail(`@recoengine/core must have zero runtime dependencies, found: ${deps.join(', ')}`)
  }

  // Rule 2: dependencies point left only.
  for (const dep of deps) {
    if (!allowed.includes(dep)) {
      fail(`${name} must not depend on "${dep}". Allowed: ${allowed.join(', ') || '(none)'}`)
    }
  }

  // A published package may never depend on an example.
  for (const dep of deps) {
    if (dep.startsWith('@recoengine/domain-')) {
      fail(`${name} depends on "${dep}". Domain packages are examples and are never published.`)
    }
  }
}

// Rule 3: no Node API inside the core.
// tsconfig `types: []` already removes process/Buffer/__dirname from the type space,
// but a bare `import 'node:fs'` still type-checks. This closes that gap.
const NODE_IMPORT = /\bfrom\s+['"]node:|\brequire\(\s*['"]node:|\bimport\(\s*['"]node:/
const BARE_NODE_BUILTIN =
  /\bfrom\s+['"](fs|path|crypto|os|util|stream|worker_threads|child_process|http|https|net|zlib|buffer)['"]/

for (const file of walk(join(PKG_DIR, 'core', 'src'))) {
  const source = readFileSync(file, 'utf8')
  const where = relative(ROOT, file)
  if (NODE_IMPORT.test(source)) {
    fail(`${where}: imports a node:* builtin. @recoengine/core must run on Bun, Deno and in the browser.`)
  }
  if (BARE_NODE_BUILTIN.test(source)) {
    fail(`${where}: imports a Node builtin. @recoengine/core must run on Bun, Deno and in the browser.`)
  }
}

if (errors.length > 0) {
  console.error('\n  Architecture check FAILED\n')
  for (const error of errors) console.error(`  ✗ ${error}`)
  console.error(`\n  ${errors.length} violation(s). See ARCHITECTURE.md §2, §4, §23.5.\n`)
  process.exit(1)
}

console.log(`  ✓ Architecture check passed (${packageNames.length} packages)`)
