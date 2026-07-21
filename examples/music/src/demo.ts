import { itemId } from '@recoengine/core'
import { buildMusicEngine, listenRequest } from './engine.js'

/**
 * Run with `pnpm --filter @recoengine/example-music demo` (after `pnpm build`).
 *
 * Prints a recommendation feed with its reasons, then asks the engine why a specific track
 * landed where it did — the `_explain` that turns the black box into a tool (§16).
 */
async function main(): Promise<void> {
  const engine = buildMusicEngine()
  const { recommendations, diagnostics } = await engine.recommend(listenRequest())

  console.log('— Recommendations —')
  for (const rec of recommendations) {
    const track = rec.item.payload
    console.log(`${rec.rank}. ${track.title} — ${track.artistName}  (${rec.score})`)
    for (const reason of rec.explanation.reasons.slice(0, 3)) {
      console.log(`      · ${reason.code}`)
    }
  }

  console.log(`\nretrieved ${diagnostics.retrieved}, ${diagnostics.warnings.length} warning(s)\n`)

  console.log('— Why is "Yesterday" where it is? —')
  const why = await engine.explain(itemId('t3'), listenRequest())
  console.log(`status: ${why.status}${why.lostAt ? ` (lost at ${why.lostAt})` : ''}, rank ${why.rank ?? '—'}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
