import { identity, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { clamp01, type FeatureRef, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface ContextStrategyOptions extends StrategyOptions {
  /** How well the item fits the request's signals, [0..1]. Default `context_match`. */
  readonly feature?: FeatureRef
  /** Emit a reason when the match reaches this. Default 0.6. */
  readonly reasonThreshold?: number
}

/**
 * Fit to the request's context — time of day, device, weather, mood. The match itself is
 * computed by an extractor that reads `ctx.signals` (the one untyped, domain-specific bag
 * in the contract); this strategy only scores the precomputed `context_match` column.
 *
 * Gated on there being any signals at all: a request that carries no context has nothing
 * to match, so the column is dropped rather than scoring every item at whatever the
 * extractor's neutral default happened to be.
 */
export function contextStrategy(options: ContextStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'context')
  const key = toKey(options.feature ?? 'context_match')
  const threshold = options.reasonThreshold ?? 0.6

  return {
    id,
    requires: [key],
    normalizer: options.normalizer ?? identity,
    applicable: (ctx) => ctx.signals.size >= 1,
    score: (view: ScoringView) => {
      const source = view.items.column(key)
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const value = clamp01(source[row] as number)
          raw[row] = value
          if (value >= threshold) {
            add(row, { code: 'fits_context', polarity: 'positive', strength: value })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
