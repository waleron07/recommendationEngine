/**
 * The e-commerce domain: a product catalogue and a shopping history.
 *
 * Deliberately shaped nothing like `examples/music` on the surface — products, brands,
 * categories, sales, and events that are `view` / `add_to_cart` / `purchase` rather than
 * plays. What is *identical* is everything downstream: the same strategies, modifiers and
 * diversifiers rank this, with the core untouched. That sameness is the whole point.
 */

export interface Product {
  readonly name: string
  readonly brandId: string
  readonly brandName: string
  readonly categoryId: string
  readonly categoryName: string
  /** Lifetime units sold — the raw popularity signal. */
  readonly salesCount: number
  /** When the product was listed, ms epoch. Feeds `item_age` → recency. */
  readonly addedAt: number
}

export interface CatalogueEntry {
  readonly id: string
  readonly product: Product
}

const DAY = 86_400_000
export const NOW = 1_700_000_000_000

const p = (
  id: string,
  name: string,
  brandId: string,
  brandName: string,
  categoryId: string,
  categoryName: string,
  salesCount: number,
  ageDays: number,
): CatalogueEntry => ({
  id,
  product: { name, brandId, brandName, categoryId, categoryName, salesCount, addedAt: NOW - ageDays * DAY },
})

/** Eight products, three brands, three categories. */
export const CATALOGUE: readonly CatalogueEntry[] = [
  p('p1', 'AeroRun Sneakers', 'acme', 'Acme', 'shoes', 'Shoes', 42_000, 400),
  p('p2', 'TrailGrip Boots', 'acme', 'Acme', 'shoes', 'Shoes', 18_000, 300),
  p('p3', 'CloudStep Sandals', 'acme', 'Acme', 'shoes', 'Shoes', 9_000, 120),
  p('p4', 'FlexFit Jacket', 'nova', 'Nova', 'apparel', 'Apparel', 55_000, 200),
  p('p5', 'StormShell Coat', 'nova', 'Nova', 'apparel', 'Apparel', 12_000, 150),
  p('p6', 'PulseBuds Earphones', 'volt', 'Volt', 'audio', 'Audio', 80_000, 90),
  p('p7', 'BassCore Speaker', 'volt', 'Volt', 'audio', 'Audio', 25_000, 60),
  p('p8', 'NanoCharge Cable', 'volt', 'Volt', 'audio', 'Audio', 300, 3),
]

/** Fast lookup for history aggregation: an event's `itemId` → its product. */
export const byId: ReadonlyMap<string, Product> = new Map(CATALOGUE.map((e) => [e.id, e.product]))

export type Interaction = 'view' | 'add_to_cart' | 'purchase'

export interface ShopEvent {
  readonly itemId: string
  readonly type: Interaction
  /** Days before `NOW`. */
  readonly daysAgo: number
}

/**
 * A shopper who bought a pair of Acme shoes, keeps eyeing Volt audio, and carted a Nova
 * jacket without buying. Enough to make brand affinity, recency and the "already bought"
 * filter all say something.
 */
export const HISTORY: readonly ShopEvent[] = [
  { itemId: 'p1', type: 'purchase', daysAgo: 20 }, // bought AeroRun — should be filtered out
  { itemId: 'p1', type: 'view', daysAgo: 25 },
  { itemId: 'p6', type: 'view', daysAgo: 2 }, // eyeing PulseBuds
  { itemId: 'p6', type: 'add_to_cart', daysAgo: 1 },
  { itemId: 'p7', type: 'view', daysAgo: 4 },
  { itemId: 'p4', type: 'add_to_cart', daysAgo: 8 }, // carted the jacket, never bought
  { itemId: 'p4', type: 'view', daysAgo: 9 },
]

/** How much each interaction says about intent: buying ≫ carting ≫ looking. */
export const INTENT_WEIGHT: Readonly<Record<Interaction, number>> = {
  purchase: 5,
  add_to_cart: 3,
  view: 1,
}
