import {
  type Candidate,
  type CandidateSet,
  contributionOf,
  type MutableScoreBoard,
  RecoError,
  type RequestContext,
  type ScoreModifier,
  strategyId,
} from '@recoengine/core'

export interface BoostModifierOptions {
  readonly id?: string
  /** Item ids to move. The cheap, common case: an editorial pin or a blocklist. */
  readonly items?: Iterable<string>
  /** Or a predicate, for a rule richer than an id set (e.g. keyed off `ctx.signals`). */
  readonly select?: (candidate: Candidate, ctx: RequestContext) => boolean
  /** Added to the final score. Positive promotes, negative penalises. Default 0.1. */
  readonly amount?: number
  /** Reason code. Default `boosted` for a promotion, `penalized` for a penalty. */
  readonly reasonCode?: string
}

/**
 * A flat additive nudge to a chosen set of items — the modifier behind editorial pins,
 * "less like this" penalties, and business rules that live outside the scoring model.
 *
 * Additive (`kind: 'boost'`), not multiplicative: a pin should lift an item by a fixed
 * amount regardless of where it started, and §11.2 adds boosts after the multiplicative
 * fold, then clamps to [0..1]. Selection is by id set, by predicate, or both; a negative
 * `amount` makes it a penalty. It is *not* a filter — a penalised item stays in the feed,
 * just lower. To remove an item outright, use a `PreFilter`/`PostFilter`, which is the
 * port that owns that decision.
 */
export function boostModifier(options: BoostModifierOptions = {}): ScoreModifier {
  if (options.items === undefined && options.select === undefined) {
    throw new RecoError(
      'INVALID_CONFIG',
      'boostModifier needs something to act on: pass "items", "select", or both. ' +
        'A boost that selects nothing is a no-op that looks like a bug.',
    )
  }

  const sid = strategyId(options.id ?? 'boost')
  const amount = options.amount ?? 0.1
  const ids = options.items === undefined ? undefined : new Set<string>(options.items)
  const select = options.select
  const code = options.reasonCode ?? (amount >= 0 ? 'boosted' : 'penalized')

  return {
    id: options.id ?? 'boost',
    kind: 'boost',
    apply(board: MutableScoreBoard, set: CandidateSet, ctx: RequestContext) {
      if (amount === 0) return

      for (let row = 0; row < set.size; row++) {
        const candidate = set.at(row)
        const chosen = (ids?.has(candidate.item.id) ?? false) || (select?.(candidate, ctx) ?? false)
        if (!chosen) continue

        board.add(
          row,
          contributionOf(sid, 'boost', amount, amount, 1, [
            {
              code,
              polarity: amount >= 0 ? 'positive' : 'negative',
              strength: Math.min(1, Math.abs(amount)),
            },
          ]),
        )
      }
    },
  }
}
