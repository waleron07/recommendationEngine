/**
 * Cross-runtime smoke test. Runs under Node, Bun and Deno (see .github/workflows/ci.yml).
 *
 * It does not test behaviour — the vitest suite does that. It tests that the built
 * artifact *loads and works* outside Node, which is the one thing a Node-only test
 * runner can never tell us. A `node:*` import that slipped past check-arch.mjs, or
 * an ESM export map typo, surfaces here and nowhere else.
 *
 * Deliberately dependency-free and assertion-library-free: it must run identically
 * on three runtimes with zero install.
 */

import { RecoError } from '../packages/core/dist/index.js'

const failures = []

function check(what, condition) {
  if (condition) return
  failures.push(what)
}

const err = new RecoError('INVALID_CONFIG', 'smoke')

check('RecoError is constructible', err instanceof Error)
check('RecoError carries its code', err.code === 'INVALID_CONFIG')
check('RecoError carries its message', err.message === 'smoke')

if (failures.length > 0) {
  console.error('smoke test FAILED:')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  throw new Error(`${failures.length} smoke check(s) failed`)
}

console.log('  ✓ @recoengine/core loads and works on this runtime')
