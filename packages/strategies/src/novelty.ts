import { identity, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { clamp01, type FeatureRef, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface NoveltyStrategyOptions extends StrategyOptions {
  /** How saturated the user's taste is, [0..1]. A *profile* feature. Default `profile_saturation`. */
  readonly saturationFeature?: FeatureRef
  /** How familiar this item is to the user, [0..1]. Default `item_familiarity`. */
  readonly familiarityFeature?: FeatureRef
  /** Emit a reason when the novelty score reaches this. Default 0.4. */
  readonly reasonThreshold?: number
}

/**
 * A bonus for the unfamiliar, scaled by how narrow the user's taste has become — the
 * self-regulating half of §15. The score is `saturation × (1 − familiarity)`: a user
 * stuck on three artists (saturation near 1) gets a strong push toward new things, and a
 * user with broad taste (saturation near 0) gets almost none, without anyone tuning a
 * per-user knob.
 *
 * `saturation` is read from the `ProfileVector` — this is the one standard strategy that
 * uses `requiresProfile`, so it needs a `UserFeatureExtractor` to supply that feature or
 * `build()` will reject the engine. `familiarity` is per-item. Both are already in [0..1],
 * hence `identity`.
 *
 * §15 also frames novelty as a stage-8 modifier; here it is a scoring strategy, which is
 * how §11.3 lists it. The difference is fold order — additive column vs multiplicative
 * damp — and both are legitimate; a caller who wants the multiplicative form uses the
 * modifier from `@recoengine/modifiers` instead.
 */
export function noveltyStrategy(options: NoveltyStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'novelty')
  const saturationKey = toKey(options.saturationFeature ?? 'profile_saturation')
  const familiarityKey = toKey(options.familiarityFeature ?? 'item_familiarity')
  const threshold = options.reasonThreshold ?? 0.4

  return {
    id,
    requires: [familiarityKey],
    requiresProfile: [saturationKey],
    normalizer: options.normalizer ?? identity,
    score: (view: ScoringView) => {
      const saturation = clamp01(view.profile.get(saturationKey))
      const familiarity = view.items.column(familiarityKey)
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const value = saturation * (1 - clamp01(familiarity[row] as number))
          raw[row] = value
          if (value >= threshold) {
            add(row, { code: 'fresh_pick', polarity: 'positive', strength: value })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
