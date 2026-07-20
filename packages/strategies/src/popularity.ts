import { identity, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { type FeatureRef, percentiles, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface PopularityStrategyOptions extends StrategyOptions {
  /** Global popularity, e.g. lifetime plays. Default `popularity_global`. */
  readonly globalFeature?: FeatureRef
  /**
   * Popularity within the user's cohort. Default `popularity_cohort`. Pass `null` to
   * score on global popularity alone (a setup with no cohort model).
   */
  readonly cohortFeature?: FeatureRef | null
  /** Weight on cohort popularity in the blend, [0..1]. Default 0.5. */
  readonly cohortWeight?: number
  /** Emit a reason at or above this percentile, [0..1]. Default 0.9. */
  readonly reasonPercentile?: number
}

/**
 * Popularity, global and within the cohort — the strongest cold-start signal, which is
 * why it carries no `applicable` gate: a brand-new user with every other strategy stood
 * down still gets a sensible list from this one.
 *
 * The two inputs are play counts on *different* scales (the cohort's counts are far
 * smaller than the world's), so blending the raw numbers would let whichever column
 * happens to be larger dominate. Instead each is converted to a percentile first and the
 * percentiles are blended — the same reasoning that makes the README's single-column
 * popularity ask for `rank`, generalised to two columns. The blend is already in [0..1],
 * so the normalizer is `identity`.
 */
export function popularityStrategy(options: PopularityStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'popularity')
  const globalKey = toKey(options.globalFeature ?? 'popularity_global')
  const cohortKey =
    options.cohortFeature === null ? null : toKey(options.cohortFeature ?? 'popularity_cohort')
  const cohortWeight = cohortKey === null ? 0 : Math.min(1, Math.max(0, options.cohortWeight ?? 0.5))
  const cut = options.reasonPercentile ?? 0.9

  return {
    id,
    requires: cohortKey === null ? [globalKey] : [globalKey, cohortKey],
    normalizer: options.normalizer ?? identity,
    score: (view: ScoringView) => {
      const globalPct = percentiles(view.items.column(globalKey))
      const cohortPct = cohortKey === null ? null : percentiles(view.items.column(cohortKey))
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const g = globalPct[row] as number
          const value =
            cohortPct === null ? g : (1 - cohortWeight) * g + cohortWeight * (cohortPct[row] as number)
          raw[row] = value
          if (value >= cut) {
            add(row, {
              code: 'popular',
              polarity: 'positive',
              strength: value,
              params: { percentile: Math.round(value * 100) },
            })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
