import { minmax, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { type FeatureRef, percentiles, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface CoOccurrenceStrategyOptions extends StrategyOptions {
  /** The item-to-item co-occurrence score. Default `cooc_score`. */
  readonly feature?: FeatureRef
  /** Below this many events there are no seed items to co-occur with. Default 1. */
  readonly minHistory?: number
  /** Emit a reason at or above this percentile of the column, [0..1]. Default 0.8. */
  readonly reasonPercentile?: number
}

/**
 * "People who took X also took Y" — item-to-item collaborative filtering. The
 * co-occurrence score is computed by an extractor from the user's seed items against a
 * precomputed model; this strategy only reads the resulting column and states its reasons.
 *
 * `minmax` is the default: co-occurrence counts have no natural ceiling and vary by
 * catalogue, so the column is rescaled to its own range rather than assumed to sit in
 * [0..1]. Reasons are gated by percentile, not raw value, for the same reason.
 */
export function coOccurrenceStrategy(options: CoOccurrenceStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'cooccurrence')
  const key = toKey(options.feature ?? 'cooc_score')
  const minHistory = options.minHistory ?? 1
  const cut = options.reasonPercentile ?? 0.8

  return {
    id,
    requires: [key],
    normalizer: options.normalizer ?? minmax,
    applicable: (ctx) => ctx.history.size >= minHistory,
    score: (view: ScoringView) => {
      const source = view.items.column(key)
      const raw = Float64Array.from(source)
      const pct = percentiles(raw)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const p = pct[row] as number
          if ((raw[row] as number) > 0 && p >= cut) {
            add(row, {
              code: 'often_taken_together',
              polarity: 'positive',
              strength: p,
              params: { percentile: Math.round(p * 100) },
            })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
