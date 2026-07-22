import {
  type CandidateProvider,
  CLOCK,
  type Clock,
  createEngine,
  eventId,
  itemId,
  type PreFilter,
  type RecommendationEngine,
  timestamp,
  userId,
} from '@recoengine/core'
import { attributeQuotaDiversifier } from '@recoengine/diversity'
import { interactionCountExtractor, interactionRecencyExtractor } from '@recoengine/features'
import {
  affinityStrategy,
  historyStrategy,
  popularityStrategy,
  recencyStrategy,
} from '@recoengine/strategies'
import { CATALOGUE, HISTORY, NOW, type Product, type ShopEvent } from './catalogue.js'
import {
  brandAffinityExtractor,
  brandGroupExtractor,
  categoryAffinityExtractor,
  itemAgeExtractor,
  popularityExtractor,
} from './extractors.js'

/**
 * A product recommender — the second half of the architecture's acceptance test (§22, §10).
 *
 * Line it up against `examples/music/engine.ts`: the imports from `@recoengine/*` are
 * *identical*, only the domain extractors and one prefilter differ. Two domains, one engine,
 * no changes to the core between them. If e-commerce had needed to touch `core`, the
 * abstraction would have leaked — and this file would not type-check against it.
 */
export function buildShopEngine(now: number = NOW): RecommendationEngine<Product> {
  const clock: Clock = { now: () => timestamp(now) }

  const provider: CandidateProvider<Product> = {
    id: 'catalogue',
    version: '1.0.0',
    provide: async (_ctx, budget) =>
      CATALOGUE.slice(0, budget.maxItems).map((entry) => ({
        id: itemId(entry.id),
        type: 'product',
        payload: entry.product,
      })),
  }

  // Don't recommend what they already bought — the e-commerce rule music had no use for.
  // Fail-closed: if the check throws, the item is withheld, never shown by accident.
  const notPurchased: PreFilter<Product> = {
    id: 'not-purchased',
    failClosed: true,
    approve: (candidate, ctx) => ctx.history.countFor(candidate.item.id, 'purchase') === 0,
  }

  return (
    createEngine<Product>()
      .provide(CLOCK, clock)
      .use(provider)
      .use(notPurchased)
      // Domain: turns products into numbers.
      .use(popularityExtractor)
      .use(itemAgeExtractor)
      .use(brandAffinityExtractor)
      .use(categoryAffinityExtractor)
      .use(brandGroupExtractor)
      // Domain-neutral, off the shelf — the same two as music.
      .use(interactionCountExtractor())
      .use(interactionRecencyExtractor({ halfLife: 14 }))
      // The same strategies that ranked tracks now rank products.
      .use(affinityStrategy({ id: 'brand', feature: 'affinity_brand' }))
      .use(affinityStrategy({ id: 'category', feature: 'affinity_category' }))
      .use(popularityStrategy({ cohortFeature: null }))
      .use(recencyStrategy({ halfLife: 120 }))
      .use(historyStrategy())
      // No more than two products of one brand in the feed.
      .use(attributeQuotaDiversifier({ feature: 'brand_group', max: 2 }))
      .configure({
        limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 },
        weights: { brand: 0.9, category: 0.6, popularity: 0.4, recency: 0.3, history: 0.8 },
      })
      .build()
  )
}

/** Turns the catalogue's compact history into the engine's `History` shape. */
export function historyOf(events: readonly ShopEvent[] = HISTORY, now: number = NOW) {
  const DAY = 86_400_000
  return {
    userId: userId('shopper'),
    events: events.map((event, i) => ({
      id: eventId(`e${i}`),
      userId: userId('shopper'),
      itemId: itemId(event.itemId),
      type: event.type,
      at: timestamp(now - event.daysAgo * DAY),
    })),
  }
}

/** A ready-to-run request for the example shopper. */
export function shopRequest(now: number = NOW) {
  return {
    user: { id: userId('shopper'), payload: {} as Product },
    history: historyOf(HISTORY, now),
    limit: 10,
    explain: 'reasons' as const,
  }
}
