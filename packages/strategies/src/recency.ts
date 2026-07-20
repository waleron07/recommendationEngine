import { exponentialDecay, identity, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { type FeatureRef, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface RecencyStrategyOptions extends StrategyOptions {
  /** Age of the item, in the same unit as `halfLife`. Default `item_age`. */
  readonly ageFeature?: FeatureRef
  /** Age at which freshness halves. Default 30 (days, if that is the age unit). */
  readonly halfLife?: number
  /** Emit a reason when the decayed freshness is at least this. Default 0.5. */
  readonly reasonThreshold?: number
}

/**
 * Freshness of the item itself. Turns an age into a [0..1] weight with an exponential
 * decay whose one parameter — the half-life — is a claim a human can check ("interest
 * halves every 30 days"), not a magic `λ` (see core's `exponentialDecay`).
 *
 * No `applicable` gate: freshness is a cold-start-safe fallback like popularity. The
 * decay already returns 1 for a negative age, so a clock skew that makes an item look
 * slightly "future" cannot push its score above a brand-new one. `item_age` must be
 * produced in the same unit as `halfLife` — an extractor reporting seconds against a
 * half-life of 30 would rank every item as ancient.
 */
export function recencyStrategy(options: RecencyStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'recency')
  const ageKey = toKey(options.ageFeature ?? 'item_age')
  const halfLife = options.halfLife ?? 30
  const threshold = options.reasonThreshold ?? 0.5

  return {
    id,
    requires: [ageKey],
    normalizer: options.normalizer ?? identity,
    score: (view: ScoringView) => {
      const age = view.items.column(ageKey)
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const a = age[row] as number
          const freshness = exponentialDecay(a, halfLife)
          raw[row] = freshness
          if (freshness >= threshold) {
            add(row, {
              code: 'fresh',
              polarity: 'positive',
              strength: freshness,
              params: { age: Math.round(a) },
            })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
