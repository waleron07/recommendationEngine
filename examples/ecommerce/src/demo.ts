import { itemId } from '@recoengine/core'
import { buildShopEngine, shopRequest } from './engine.js'

/**
 * Run with `pnpm --filter @recoengine/example-ecommerce demo` (after `pnpm build`).
 *
 * Prints a product feed with its reasons, then asks the engine why a specific product is
 * where it is — including one the "already purchased" filter removed.
 */
async function main(): Promise<void> {
  const engine = buildShopEngine()
  const { recommendations, diagnostics } = await engine.recommend(shopRequest())

  console.log('— Recommendations —')
  for (const rec of recommendations) {
    const product = rec.item.payload
    console.log(`${rec.rank}. ${product.name} — ${product.brandName}  (${rec.score})`)
    for (const reason of rec.explanation.reasons.slice(0, 3)) {
      console.log(`      · ${reason.code}`)
    }
  }

  console.log(
    `\nretrieved ${diagnostics.retrieved}, filtered ${diagnostics.filtered}, ${diagnostics.warnings.length} warning(s)\n`,
  )

  console.log('— Why is "AeroRun Sneakers" (already bought) not shown? —')
  const why = await engine.explain(itemId('p1'), shopRequest())
  console.log(`status: ${why.status}${why.lostAt ? ` (lost at ${why.lostAt})` : ''}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
