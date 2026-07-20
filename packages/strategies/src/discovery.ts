import { gaussianDecay, identity, minmax, type ScoringStrategy, type ScoringView } from '@recoengine/core'
import { clamp01, type FeatureRef, type StrategyOptions, sparseReasons, toId, toKey } from './internal.js'

export interface DiscoveryStrategyOptions extends StrategyOptions {
  /** How far the item sits from the user's taste centroid. Default `distance_from_profile`. */
  readonly feature?: FeatureRef
  /**
   * The sweet-spot distance to reward. When set, items *near* this distance score
   * highest and both the too-familiar and the too-alien fall away — the "controlled" in
   * "controlled step outside taste" (§11.3). When omitted, farther simply scores higher.
   */
  readonly target?: number
  /** Width of the band around `target`. Default `target / 2` (or 0.25 when `target` is 0). */
  readonly scale?: number
  /** Below this many events there is no taste to step away from. Default 1. */
  readonly minHistory?: number
  /** Emit a reason when the discovery score reaches this. Default 0.5. */
  readonly reasonThreshold?: number
}

/**
 * A controlled step outside the user's comfort zone. With no `target` it is a monotone
 * reward for distance, `minmax`-normalized so the farthest available candidate anchors
 * the top. With a `target` it becomes a band: a Gaussian centred on the sweet-spot
 * distance, so items that are *a bit* new win over items that are either already familiar
 * or so alien they read as noise — which is the difference between discovery and a random
 * feed.
 *
 * Gated on history: with no profile there is no "outside" to step to, so the column is
 * dropped and its weight reflows.
 */
export function discoveryStrategy(options: DiscoveryStrategyOptions = {}): ScoringStrategy {
  const id = toId(options.id ?? 'discovery')
  const key = toKey(options.feature ?? 'distance_from_profile')
  const target = options.target
  const scale = options.scale ?? (target === undefined ? 0 : target === 0 ? 0.25 : target / 2)
  const minHistory = options.minHistory ?? 1
  const threshold = options.reasonThreshold ?? 0.5
  const banded = target !== undefined

  return {
    id,
    requires: [key],
    // A raw-distance column has no natural [0..1] bound, so rescale it; a Gaussian band
    // already lands in [0..1], so leave it alone.
    normalizer: options.normalizer ?? (banded ? identity : minmax),
    applicable: (ctx) => ctx.history.size >= minHistory,
    score: (view: ScoringView) => {
      const distance = view.items.column(key)
      const raw = new Float64Array(view.items.rows)

      const reasons = sparseReasons((add) => {
        for (let row = 0; row < raw.length; row++) {
          const d = distance[row] as number
          const value = banded ? gaussianDecay(Math.abs(d - (target as number)), scale) : Math.max(0, d)
          raw[row] = value
          const strength = banded ? clamp01(value) : clamp01(d)
          if (strength >= threshold) {
            add(row, {
              code: 'outside_comfort_zone',
              polarity: 'neutral',
              strength,
              params: { distance: Math.round(d * 100) / 100 },
            })
          }
        }
      })

      return { strategyId: id, raw, reasons }
    },
  }
}
