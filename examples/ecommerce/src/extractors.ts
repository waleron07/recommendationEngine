import {
  type FeatureDescriptor,
  type FeatureExtractor,
  featureKey,
  type HistoryIndex,
} from '@recoengine/core'
import { byId, INTENT_WEIGHT, type Interaction, type Product } from './catalogue.js'

/**
 * The domain extractors — the whole of the e-commerce-specific code. Note how little of it
 * there is, and that it is a mirror of `examples/music/extractors.ts` on different fields:
 * brand instead of artist, sales instead of plays, "already purchased" instead of "already
 * played". Everything they feed — the strategies, the modifier, the diversifier — is the
 * same code that ranked music. That is the abstraction not leaking, made concrete.
 */

const numeric = (key: string, owner: string, description: string): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description,
  owner,
  ownerVersion: '1.0.0',
})

const DAY = 86_400_000

/** `salesCount` → `popularity_global`. */
export const popularityExtractor: FeatureExtractor<Product> = {
  id: 'shop-popularity',
  version: '1.0.0',
  provides: [numeric('popularity_global', 'shop-popularity', 'lifetime units sold')],
  extract: async (set, out) => {
    const column = out.columnMut(featureKey('popularity_global'))
    for (let row = 0; row < set.size; row++) column[row] = set.at(row).item.payload.salesCount
  },
}

/** `item_age` in days from the listing date and `ctx.now`. Feeds recency. */
export const itemAgeExtractor: FeatureExtractor<Product> = {
  id: 'shop-age',
  version: '1.0.0',
  provides: [numeric('item_age', 'shop-age', 'days since the product was listed')],
  extract: async (set, out, ctx) => {
    const column = out.columnMut(featureKey('item_age'))
    for (let row = 0; row < set.size; row++) {
      column[row] = (ctx.now - set.at(row).item.payload.addedAt) / DAY
    }
  },
}

/**
 * Sums an intent-weighted affinity over the history, grouped by a product attribute:
 * a purchase counts far more than a glance (§`INTENT_WEIGHT`). This is the e-commerce
 * nuance music did not have — buying is a much stronger signal than looking — and it lives
 * entirely in the domain extractor, invisible to the strategy that consumes the column.
 */
function weightedAffinity(
  history: HistoryIndex,
  memoKey: string,
  keyOf: (product: Product) => string,
): Map<string, number> {
  const touched = history.aggregate(memoKey, (event) => event.itemId)
  const byGroup = new Map<string, number>()
  for (const itemId of touched.keys()) {
    const product = byId.get(itemId)
    if (product === undefined) continue
    const group = keyOf(product)
    for (const event of history.eventsFor(itemId)) {
      byGroup.set(group, (byGroup.get(group) ?? 0) + INTENT_WEIGHT[event.type as Interaction])
    }
  }
  return byGroup
}

const affinityColumn = (
  byGroup: Map<string, number>,
  groupOf: (p: Product) => string,
  size: number,
  at: (row: number) => Product,
): Float64Array => {
  let max = 0
  for (const value of byGroup.values()) if (value > max) max = value
  const column = new Float64Array(size)
  for (let row = 0; row < size; row++) {
    const group = groupOf(at(row))
    column[row] = max === 0 ? 0 : (byGroup.get(group) ?? 0) / max
  }
  return column
}

/** `affinity_brand`: intent-weighted affinity to the product's brand, in [0..1]. */
export const brandAffinityExtractor: FeatureExtractor<Product> = {
  id: 'shop-affinity-brand',
  version: '1.0.0',
  provides: [numeric('affinity_brand', 'shop-affinity-brand', 'weighted affinity to the product brand')],
  extract: async (set, out, ctx) => {
    const byBrand = weightedAffinity(ctx.history, 'shop:item', (product) => product.brandId)
    const values = affinityColumn(
      byBrand,
      (p) => p.brandId,
      set.size,
      (row) => set.at(row).item.payload,
    )
    out.columnMut(featureKey('affinity_brand')).set(values)
  },
}

/** `affinity_category`: intent-weighted affinity to the product's category, in [0..1]. */
export const categoryAffinityExtractor: FeatureExtractor<Product> = {
  id: 'shop-affinity-category',
  version: '1.0.0',
  provides: [
    numeric('affinity_category', 'shop-affinity-category', 'weighted affinity to the product category'),
  ],
  extract: async (set, out, ctx) => {
    const byCategory = weightedAffinity(ctx.history, 'shop:item', (product) => product.categoryId)
    const values = affinityColumn(
      byCategory,
      (p) => p.categoryId,
      set.size,
      (row) => set.at(row).item.payload,
    )
    out.columnMut(featureKey('affinity_category')).set(values)
  },
}

/** `brand_group`: a categorical hash of the brand, for the "≤ N per brand" quota. */
export const brandGroupExtractor: FeatureExtractor<Product> = {
  id: 'shop-brand-group',
  version: '1.0.0',
  provides: [
    {
      key: featureKey('brand_group'),
      kind: 'categorical',
      defaultValue: 0,
      description: 'hash of the brand id, for quota grouping',
      owner: 'shop-brand-group',
      ownerVersion: '1.0.0',
    },
  ],
  extract: async (set, out) => {
    const column = out.columnMut(featureKey('brand_group'))
    for (let row = 0; row < set.size; row++) column[row] = hash(set.at(row).item.payload.brandId)
  },
}

/** FNV-1a 32-bit — equal strings give equal numbers. */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
