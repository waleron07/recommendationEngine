import { identity, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { clamp01, type FeatureRef, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface AffinityStrategyOptions extends StrategyOptions {
  /** The affinity feature to read, e.g. `affinity_artist`. Required. */
  readonly feature: FeatureRef
  /** Reason code emitted for a strong match. Default `high_affinity`. */
  readonly reasonCode?: string
  /** Emit a reason when affinity reaches this. Default 0.5. */
  readonly reasonThreshold?: number
  /** Below this many events there is no taste to be close to. Default 1. */
  readonly minHistory?: number
}

/**
 * Closeness to the user's established taste along one dimension — artist, genre, brand,
 * author. One strategy, parameterised by which affinity feature to read, is what let
 * `ArtistStrategy` / `GenreStrategy` / `PlaylistStrategy` collapse into three lines of
 * config over three extractors (§11.3): the arithmetic is identical, only the feature
 * differs.
 *
 * The affinity extractor is expected to emit a value already in [0..1]; the default
 * normalizer is therefore `identity` (clamp, no rescale). Give a strategy the same `id`
 * twice and they fight over one weight key — pass distinct ids, one per dimension.
 */
export function affinityStrategy(options: AffinityStrategyOptions): ScoringStrategy {
  const key = toKey(options.feature)
  const id = toId(options.id ?? (options.feature as string))
  const code = options.reasonCode ?? 'high_affinity'
  const threshold = options.reasonThreshold ?? 0.5
  const minHistory = options.minHistory ?? 1

  return {
    id,
    requires: [key],
    normalizer: options.normalizer ?? identity,
    applicable: (ctx) => ctx.history.size >= minHistory,
    score: (view: ScoringView) => {
      const source = view.items.column(key)
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const value = clamp01(source[row] as number)
          raw[row] = value
          if (value >= threshold) {
            add(row, {
              code,
              polarity: 'positive',
              strength: value,
              params: { dimension: id, affinity: Math.round(value * 100) / 100 },
            })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
