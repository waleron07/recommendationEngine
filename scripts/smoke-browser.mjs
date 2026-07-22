/**
 * Browser smoke test. Loads the built `@recoengine/core` ESM in headless Chromium and
 * asserts it works — the browser row of the cross-runtime matrix (ARCHITECTURE §23.5).
 *
 * The `runtimes` CI job already proves the core loads under Node, Bun and Deno. The core's
 * whole isomorphism claim, though, includes the browser, and a claim nobody exercises is
 * one that quietly stops being true — a stray `node:*` import or an export-map typo that
 * the three server runtimes tolerate can still break a bundler or a browser. This closes
 * that gap by importing the real built module as a `<script type="module">` and running
 * the same checks `scripts/smoke.mjs` runs on the server.
 *
 * It is deliberately outside the repo's dependency manifest: `playwright` is installed
 * ephemerally by the CI job, so the lockfile the other jobs pin stays untouched. Run it
 * with `node scripts/smoke-browser.mjs` after `pnpm build`, in an environment where
 * `playwright` and a Chromium build are available.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = 8123

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.map': 'application/json',
}

/** The page that imports the built core and records the same checks the server smoke does. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>pending</title>
<script type="module">
  const failures = []
  const check = (what, ok) => { if (!ok) failures.push(what) }
  try {
    const { RecoError, createEngine } = await import('/packages/core/dist/index.js')
    const err = new RecoError('INVALID_CONFIG', 'smoke')
    check('RecoError is constructible', err instanceof Error)
    check('RecoError carries its code', err.code === 'INVALID_CONFIG')
    check('RecoError carries its message', err.message === 'smoke')
    check('createEngine is a function', typeof createEngine === 'function')
  } catch (error) {
    failures.push('module failed to load: ' + (error && error.message))
  }
  // The runner reads the result off the title — no framework, no globals to agree on.
  document.title = failures.length === 0 ? 'ok' : 'fail:' + failures.join('; ')
</script>`

/** A minimal static server: `/` serves the test page, everything else serves a repo file. */
const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
    return
  }
  const path = normalize(join(ROOT, decodeURIComponent(url)))
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
  createReadStream(path).pipe(res)
})

function fail(message) {
  console.error(`browser smoke test FAILED: ${message}`)
  process.exitCode = 1
}

await new Promise((resolve) => server.listen(PORT, resolve))

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.title !== 'pending', null, { timeout: 10_000 })

  const title = await page.title()
  if (title === 'ok' && consoleErrors.length === 0) {
    console.log('  ✓ @recoengine/core loads and works in a headless browser')
  } else {
    fail(title.startsWith('fail:') ? title.slice(5) : `unexpected title "${title}"`)
    for (const error of consoleErrors) console.error(`  ✗ page error: ${error}`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  await browser.close()
  server.close()
}
