import {
  type CandidateSet,
  contributionOf,
  type EventType,
  exponentialDecay,
  type MutableScoreBoard,
  type RequestContext,
  type ScoreModifier,
  strategyId,
} from '@recoengine/core'
import { saturationOf } from './internal.js'

export interface NoveltyModifierOptions {
  readonly id?: string
  /** Count only interactions of this type when measuring saturation/familiarity. */
  readonly eventType?: EventType
  /** How hard a fully-saturated profile pushes toward the unfamiliar. Default 0.5. */
  readonly weight?: number
  /** Interactions that halve an item's unfamiliarity. Default 3. */
  readonly familiarityHalfLife?: number
}

/**
 * Novelty: a multiplicative *boost* (≥ 1) toward unfamiliar items, and — the self-
 * regulating part of §15 — its strength scales with how saturated the profile is, so a
 * user stuck on three tracks gets a strong push toward the new while a user with broad
 * taste gets almost none, without anyone tuning a per-user knob.
 *
 * ```
 * factor = 1 + saturation × weight × unfamiliarity(i)
 * unfamiliarity(i) = 2^(−count(i) / familiarityHalfLife)   // unseen → 1, well-worn → 0
 * ```
 *
 * `saturation` is the evenness of the history's item distribution (`saturationOf`), so
 * this modifier — like fatigue — needs nothing but `ctx.history`. §11.3 also offers
 * novelty as a *scoring strategy* (`noveltyStrategy`): that one adds a column the weights
 * balance; this one multiplies the finished score. Same intent, different fold — pick by
 * whether novelty should compete for weight or reshape the result.
 */
export function noveltyModifier(options: NoveltyModifierOptions = {}): ScoreModifier {
  const sid = strategyId(options.id ?? 'novelty')
  const eventType = options.eventType
  const weight = options.weight ?? 0.5
  const familiarityHalfLife = options.familiarityHalfLife ?? 3

  return {
    id: options.id ?? 'novelty',
    kind: 'multiplicative',
    apply(board: MutableScoreBoard, set: CandidateSet, ctx: RequestContext) {
      const saturation = saturationOf(ctx.history, eventType)
      if (saturation <= 0) return // Broad taste (or no history): no push to give.

      for (let row = 0; row < set.size; row++) {
        const count = ctx.history.countFor(set.at(row).item.id, eventType)
        const unfamiliarity = exponentialDecay(count, familiarityHalfLife)
        const factor = 1 + saturation * weight * unfamiliarity
        if (factor <= 1) continue

        board.add(
          row,
          contributionOf(sid, 'multiplicative', unfamiliarity, factor, 1, [
            {
              code: 'novelty_boost',
              polarity: 'positive',
              strength: factor - 1,
              params: { saturation: Math.round(saturation * 100) / 100 },
            },
          ]),
        )
      }
    },
  }
}
