/**
 * The e-commerce example, end to end — stage 10's acceptance criterion: **0 changes to core**.
 *
 * This is the architecture's headline claim under test. Every `@recoengine/*` import here is
 * byte-for-byte the same as in `examples/music`; only the domain extractors and one prefilter
 * differ. If a second, unrelated domain rides the same engine with the core untouched, the
 * separation of "domain knows the fields, engine knows the maths" held. `git status
 * packages/core/` is empty on this commit — the proof is mechanical, not rhetorical.
 */
import { itemId } from '@recoengine/core'
import { describe, expect, it } from 'vitest'
import { byId } from './catalogue.js'
import { buildShopEngine, shopRequest } from './engine.js'

const brandOf = (id: string) => byId.get(id)?.brandId

describe('e-commerce recommendations', () => {
  it('leads with the brand the shopper is actively engaging (carted/viewed)', async () => {
    const { recommendations } = await buildShopEngine().recommend(shopRequest())
    // Volt audio was viewed and carted in the last days; intent-weighted brand affinity puts
    // a Volt product on top, and it explains itself with affinity + recent interaction.
    expect(recommendations[0]?.item.payload.brandId).toBe('volt')
    const codes = recommendations[0]?.explanation.reasons.map((r) => r.code) ?? []
    expect(codes).toContain('high_affinity')
  })

  it('never recommends an already-purchased product (the prefilter)', async () => {
    const engine = buildShopEngine()
    const { recommendations, diagnostics } = await engine.recommend(shopRequest())
    // p1 (AeroRun) was purchased. It must not appear, and the count reflects one removal.
    expect(recommendations.some((r) => r.item.id === 'p1')).toBe(false)
    expect(diagnostics.retrieved).toBe(8)
    expect(diagnostics.filtered).toBe(1)
  })

  it('explains a purchased product as filtered, at the prefilter', async () => {
    const why = await buildShopEngine().explain(itemId('p1'), shopRequest())
    expect(why.status).toBe('filtered')
    expect(why.lostAt).toBe('prefilter')
    expect(why.item?.id).toBe('p1') // retrieved, then filtered — so the product is known
    expect(why.explanation).toBeUndefined() // never scored
  })

  it('caps the feed at two products per brand', async () => {
    const { recommendations } = await buildShopEngine().recommend(shopRequest())
    for (const [brand, count] of countByBrand(recommendations)) {
      expect(count, `brand ${brand}`).toBeLessThanOrEqual(2)
    }
    // Volt has three eligible products; the quota keeps two.
    expect(recommendations.filter((r) => r.item.payload.brandId === 'volt')).toHaveLength(2)
  })

  it('weights buying over looking: a carted item outranks an un-touched one of similar stats', async () => {
    const { recommendations } = await buildShopEngine().recommend(shopRequest())
    const jacket = recommendations.findIndex((r) => r.item.id === 'p4') // Nova, carted
    const coat = recommendations.findIndex((r) => r.item.id === 'p5') // Nova, untouched
    expect(jacket).toBeGreaterThanOrEqual(0)
    expect(jacket).toBeLessThan(coat) // the carted jacket ranks above the un-touched coat
  })

  it('is deterministic across runs', async () => {
    const engine = buildShopEngine()
    const a = await engine.recommend(shopRequest())
    const b = await engine.recommend(shopRequest())
    expect(a.recommendations.map((r) => r.item.id)).toEqual(b.recommendations.map((r) => r.item.id))
  })

  it('scores everything with no warnings', async () => {
    const { recommendations, diagnostics } = await buildShopEngine().recommend(shopRequest())
    expect(diagnostics.warnings).toEqual([])
    for (const rec of recommendations) {
      expect(rec.score).toBeGreaterThanOrEqual(0)
      expect(rec.score).toBeLessThanOrEqual(100)
      expect(brandOf(rec.item.id as string)).toBeDefined()
    }
  })
})

function countByBrand(recs: readonly { item: { payload: { brandId: string } } }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const rec of recs) {
    const b = rec.item.payload.brandId
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  return counts
}
