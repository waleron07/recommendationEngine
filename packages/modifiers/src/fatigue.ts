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

export interface FatigueModifierOptions {
  readonly id?: string
  /** Count only interactions of this type (e.g. `'play'`). Default: all types. */
  readonly eventType?: EventType
  /** Interactions before fatigue starts biting. Default 10. */
  readonly threshold?: number
  /** Interactions past the threshold that halve the damping toward `floor`. Default 10. */
  readonly halfLife?: number
  /** The hardest fatigue can damp a score, [0..1]. Default 0.1. */
  readonly floor?: number
  /**
   * Time of no contact that halves the *effective* count — how fatigue wears off. Default
   * 30, in the units of `timeScale`. A track loved a year ago must be allowed back
   * (§15), or the library shrinks with every listen.
   */
  readonly recoveryHalfLife?: number
  /** Milliseconds per time unit for `recoveryHalfLife`. Default 86_400_000 (one day). */
  readonly timeScale?: number
}

/**
 * Fatigue: a multiplicative damp on items the user has already seen too much of. §15's
 * curve, expressed with the core's decay so both parameters are half-lives a human can
 * state — "damping halves every 10 plays past the threshold", "fatigue halves after 30
 * days of rest" — not opaque rate constants.
 *
 * ```
 * effectiveCount = count × 2^(−daysSinceLastContact / recoveryHalfLife)
 * factor         = floor + (1 − floor) × 2^(−max(0, effectiveCount − threshold) / halfLife)
 * ```
 *
 * Multiplicative, not additive, and that is the whole point (§15): subtracting a penalty
 * leaves a 0.98 track on top after the 300th play; multiplying by 0.1 removes it while
 * the order of everything else survives. Reads only `ctx.history` and `ctx.now` — no
 * features, which is exactly what the modifier port hands it (and cannot hand more).
 */
export function fatigueModifier(options: FatigueModifierOptions = {}): ScoreModifier {
  const sid = strategyId(options.id ?? 'fatigue')
  const eventType = options.eventType
  const threshold = options.threshold ?? 10
  const halfLife = options.halfLife ?? 10
  const floor = options.floor ?? 0.1
  const recoveryHalfLife = options.recoveryHalfLife ?? 30
  const timeScale = options.timeScale ?? 86_400_000

  return {
    id: options.id ?? 'fatigue',
    kind: 'multiplicative',
    apply(board: MutableScoreBoard, set: CandidateSet, ctx: RequestContext) {
      for (let row = 0; row < set.size; row++) {
        const id = set.at(row).item.id
        const count = ctx.history.countFor(id, eventType)
        if (count === 0) continue

        const lastAt = ctx.history.lastAtFor(id, eventType)
        const elapsed = lastAt === undefined ? 0 : Math.max(0, (ctx.now - lastAt) / timeScale)
        const effective = count * exponentialDecay(elapsed, recoveryHalfLife)

        const overuse = effective - threshold
        if (overuse <= 0) continue // Recovered or never past the threshold — no damp.

        const factor = floor + (1 - floor) * exponentialDecay(overuse, halfLife)
        if (factor >= 1) continue

        board.add(
          row,
          contributionOf(sid, 'multiplicative', count, factor, 1, [
            {
              code: 'fatigued',
              polarity: 'negative',
              strength: 1 - factor,
              params: { count, effectiveCount: Math.round(effective * 100) / 100 },
            },
          ]),
        )
      }
    },
  }
}
