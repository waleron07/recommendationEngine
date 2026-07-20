import { identity, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { clamp01, type FeatureRef, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface SimilarityStrategyOptions extends StrategyOptions {
  /** Similarity to the last few interactions. Default `sim_to_recent`. */
  readonly recentFeature?: FeatureRef
  /** Similarity to the whole-history taste centroid. Default `sim_to_profile`. */
  readonly profileFeature?: FeatureRef
  /** Weight on `sim_to_recent` in the blend, [0..1]. Default 0.5. */
  readonly recentWeight?: number
  /** Below this many events there is nothing to be similar to. Default 1. */
  readonly minHistory?: number
  /** Emit a reason when the blended similarity reaches this. Default 0.6. */
  readonly reasonThreshold?: number
}

/**
 * How well a candidate follows the session and the profile — the content-based signal.
 * Both inputs are cosine-style closeness in [0..1] (see `similarity.ts` in core), so the
 * blend stays in [0..1] and `identity` is the right normalizer.
 *
 * The two are kept separate rather than pre-blended by one extractor because they answer
 * different questions: `sim_to_recent` is "does this fit what you're doing right now",
 * `sim_to_profile` is "does this fit who you are". `recentWeight` is where a caller trades
 * responsiveness against stability.
 */
export function similarityStrategy(options: SimilarityStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'similarity')
  const recentKey = toKey(options.recentFeature ?? 'sim_to_recent')
  const profileKey = toKey(options.profileFeature ?? 'sim_to_profile')
  const recentWeight = clamp01(options.recentWeight ?? 0.5)
  const minHistory = options.minHistory ?? 1
  const threshold = options.reasonThreshold ?? 0.6

  return {
    id,
    requires: [recentKey, profileKey],
    normalizer: options.normalizer ?? identity,
    applicable: (ctx) => ctx.history.size >= minHistory,
    score: (view: ScoringView) => {
      const recent = view.items.column(recentKey)
      const profile = view.items.column(profileKey)
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const value =
            recentWeight * clamp01(recent[row] as number) +
            (1 - recentWeight) * clamp01(profile[row] as number)
          raw[row] = value
          if (value >= threshold) {
            add(row, { code: 'similar_to_taste', polarity: 'positive', strength: value })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
