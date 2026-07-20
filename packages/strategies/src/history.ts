import { rank, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { clamp01, type FeatureRef, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface HistoryStrategyOptions extends StrategyOptions {
  /** How many times the user touched this item. Default `interaction_count`. */
  readonly countFeature?: FeatureRef
  /** A [0..1] recency weight for the last touch, 1 = just now. Default `interaction_recency`. */
  readonly recencyFeature?: FeatureRef
  /**
   * Below this many events, the user has no history worth scoring, so the column is
   * dropped and its weight reflows to popularity and recency — cold start, expressed as
   * a number (§17.3). Default 1; raise toward 20 to keep new users on the fallbacks
   * longer.
   */
  readonly minHistory?: number
  /** Emit a reason for rows with at least this interaction count. Default 1. */
  readonly reasonThreshold?: number
}

/**
 * Direct interaction with the item itself: how often the user engaged with *this* thing,
 * damped by how long ago. Drives repeat recommendations — the song you keep coming back
 * to — and stands down entirely for a user with no history to speak of.
 */
export function historyStrategy(options: HistoryStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'history')
  const countKey = toKey(options.countFeature ?? 'interaction_count')
  const recencyKey = toKey(options.recencyFeature ?? 'interaction_recency')
  const minHistory = options.minHistory ?? 1
  const threshold = options.reasonThreshold ?? 1

  return {
    id,
    requires: [countKey, recencyKey],
    normalizer: options.normalizer ?? rank,
    applicable: (ctx) => ctx.history.size >= minHistory,
    score: (view: ScoringView) => {
      const count = view.items.column(countKey)
      const recency = view.items.column(recencyKey)
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const c = count[row] as number
          const r = clamp01(recency[row] as number)
          raw[row] = c * r
          if (c >= threshold) {
            add(row, { code: 'interacted_before', polarity: 'positive', strength: r, params: { count: c } })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
