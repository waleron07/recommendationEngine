import { type EventType, exponentialDecay, type FeatureExtractor } from '@recoengine/core'
import { type FeatureRef, numericFeature, toKey } from './internal.js'

export interface InteractionCountOptions {
  readonly id?: string
  /** The feature to write. Default `interaction_count` — what `historyStrategy` reads. */
  readonly feature?: FeatureRef
  /** Count only interactions of this type (e.g. `'play'`). Default: all types. */
  readonly eventType?: EventType
}

/**
 * How many times the user has interacted with each candidate — straight from
 * `ctx.history`, never from the payload. That is what makes it domain-neutral and
 * reusable: music counts plays, a shop counts purchases, and this extractor counts
 * neither — it counts events keyed by `ItemId`, which is a core type.
 *
 * Pairs with `interactionRecencyExtractor` to supply everything `historyStrategy` requires,
 * so a host gets repeat-interaction scoring without writing a line of domain code.
 */
export function interactionCountExtractor(options: InteractionCountOptions = {}): FeatureExtractor {
  const id = options.id ?? 'interaction-count'
  const key = toKey(options.feature ?? 'interaction_count')
  const eventType = options.eventType

  return {
    id,
    version: '1.0.0',
    provides: [numericFeature(key, id, 'how many times the user interacted with this item')],
    extract: async (set, out, ctx) => {
      const column = out.columnMut(key)
      for (let row = 0; row < set.size; row++) {
        column[row] = ctx.history.countFor(set.at(row).item.id, eventType)
      }
    },
  }
}

export interface InteractionRecencyOptions {
  readonly id?: string
  /** The feature to write. Default `interaction_recency` — what `historyStrategy` reads. */
  readonly feature?: FeatureRef
  readonly eventType?: EventType
  /** Elapsed time (in `timeScale` units) that halves the recency weight. Default 30. */
  readonly halfLife?: number
  /** Milliseconds per time unit for `halfLife`. Default 86_400_000 (one day). */
  readonly timeScale?: number
}

/**
 * How recently the user last touched each candidate, as a [0..1] weight: 1 for just now,
 * decaying by half every `halfLife` (§decay — the half-life is a claim a human can check,
 * not an opaque rate). An item the user never touched gets 0 — no interaction, no recency.
 *
 * Also domain-neutral: `ctx.history.lastAtFor(id)` and `ctx.now`, no payload. `halfLife`
 * is stated in `timeScale` units (days by default), so "interest halves every 30 days"
 * reads as `halfLife: 30`.
 */
export function interactionRecencyExtractor(options: InteractionRecencyOptions = {}): FeatureExtractor {
  const id = options.id ?? 'interaction-recency'
  const key = toKey(options.feature ?? 'interaction_recency')
  const eventType = options.eventType
  const halfLife = options.halfLife ?? 30
  const timeScale = options.timeScale ?? 86_400_000

  return {
    id,
    version: '1.0.0',
    provides: [numericFeature(key, id, 'decayed recency of the last interaction, 1 = just now')],
    extract: async (set, out, ctx) => {
      const column = out.columnMut(key)
      for (let row = 0; row < set.size; row++) {
        const lastAt = ctx.history.lastAtFor(set.at(row).item.id, eventType)
        // Never touched → 0. Untouched is not "infinitely stale" (which decay would round
        // to ~0 anyway) but categorically "no interaction", and 0 says exactly that.
        column[row] = lastAt === undefined ? 0 : exponentialDecay((ctx.now - lastAt) / timeScale, halfLife)
      }
    },
  }
}
