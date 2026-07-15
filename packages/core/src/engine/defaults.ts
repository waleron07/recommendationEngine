import { contributionOf, ScoreBoardBuilder } from '../domain/score.js'
import { RecoError } from '../kernel/errors.js'
import { topK } from '../math/heap.js'
import { NORMALIZERS } from '../math/normalize.js'
import { RRF_K, reciprocalRankNormalized } from '../math/rrf.js'
import { toPresentation } from '../pipeline/stages/explanation.js'
import type { Explainer } from '../ports/explainer.js'
import type { Ranker } from '../ports/ranker.js'
import type { ScoreCombiner } from '../ports/score-combiner.js'
import type { NormalizedColumn, ScoreNormalizer } from '../ports/score-normalizer.js'

/**
 * Weighted sum: `base = Σ(weight × normalized) / Σ weight` (§11.2).
 *
 * The division is what keeps weights honest. Without it, adding a ninth strategy silently
 * rescales every score and a tuned threshold like `score > 80 → push` starts meaning
 * something else. It is also what makes a skipped strategy free.
 *
 * The fold itself lives in `ScoreBoardBuilder`; this combiner only says which
 * contributions go in. That is the whole of it, and it is the reason a weighted sum
 * survives the stage-8 rebuild unchanged.
 */
export const weightedSum: ScoreCombiner = {
  id: 'weighted-sum',
  combine: (columns) => {
    const rows = columns[0]?.normalized.length ?? 0
    const builder = new ScoreBoardBuilder(rows)

    for (const column of columns) {
      for (let row = 0; row < rows; row++) {
        builder.add(
          row,
          contributionOf(
            column.strategyId,
            'additive',
            column.raw[row] as number,
            column.normalized[row] as number,
            column.weight,
            reasonsFor(column, row),
          ),
        )
      }
    }

    return builder.build()
  },
}

const reasonsFor = (column: NormalizedColumn, row: number) => column.reasons.get(row) ?? []

/**
 * Fuses columns by position instead of by value.
 *
 * For rankers you cannot calibrate against each other: a cosine and a BM25 both normalize
 * into [0..1] and are *still* not comparable, because min-max only says where each sat
 * within its own column. RRF reads "you were third", which means the same in every column.
 *
 * It re-ranks from `raw`, not from `normalized`, and that is not an oversight — RRF's
 * whole point is that it does not trust the values. Stage 6 still runs (its checks are
 * worth having either way) and this simply ignores the result.
 *
 * Expressed as additive contributions, so it survives the stage-8 rebuild: `Σ weight ×
 * rrf / Σ weight` is a weighted mean of reciprocal ranks, and the denominator is identical
 * for every row, so the order is exactly Σ weight × rrf. Explainability is intact —
 * `contributions` still names who put each candidate where.
 */
export function rrfCombiner(k: number = RRF_K): ScoreCombiner {
  return {
    id: k === RRF_K ? 'rrf' : `rrf:${k}`,
    combine: (columns) => {
      const rows = columns[0]?.normalized.length ?? 0
      const builder = new ScoreBoardBuilder(rows)

      for (const column of columns) {
        const fused = reciprocalRankNormalized(column.raw, k)
        for (let row = 0; row < rows; row++) {
          builder.add(
            row,
            contributionOf(
              column.strategyId,
              'additive',
              column.raw[row] as number,
              fused[row] as number,
              column.weight,
              reasonsFor(column, row),
            ),
          )
        }
      }

      return builder.build()
    },
  }
}

/**
 * The default: rank everything.
 *
 * A full sort, deliberately, even though §22 puts a top-K heap in the maths and the heap
 * is genuinely faster. The heap is only faster when K is much smaller than n, and *what K
 * may be is not the ranker's decision to make*: whatever it keeps is all that
 * diversification and exploration will ever see. Cut to the page and MMR has nothing to
 * swap in; cut to the top few hundred and a `discover` bucket can no longer reach the
 * long tail it exists to surface.
 *
 * So the engine ranks the lot and leaves the pool to whoever knows what it is for. Use
 * `topKRanker(pool)` when that is you. The tension is real and its owner is the diversity
 * package, which is where it will be settled.
 *
 * Ties break on the row index rather than arbitrarily. `Array.sort` is stable in every
 * runtime the matrix names, but relying on that would leave the guarantee unstated: two
 * candidates with identical scores must come back in the same order on every request, or
 * a golden test measures the sort's mood.
 */
export const sortRanker: Ranker = {
  id: 'sort',
  rank: (board) => {
    const rows = Array.from({ length: board.rows }, (_, row) => row)
    rows.sort((a, b) => board.final(b) - board.final(a) || a - b)
    return rows
  },
}

/**
 * Ranking that keeps only the best `pool` candidates.
 *
 * O(n log pool) and an array of `pool` rather than of n — the right answer once you know
 * what the pool is for. That number is yours to choose because only you know what runs
 * after ranking: it must cover the page, plus whatever diversification will reject, plus
 * whatever exploration wants to reach for. A pool equal to the page means MMR can only
 * permute what it was given.
 */
export function topKRanker(pool: number): Ranker {
  return {
    id: `top-${pool}`,
    rank: (board) => topK(board.rows, pool, (row) => board.final(row)),
  }
}

/**
 * The default explanation: the contributions, and the reasons worth mentioning.
 *
 * The policy here is deliberately plain — every reason from every contribution that moved
 * the score, strongest first. Anything cleverer (a noise floor, a cap, hiding negatives)
 * is a product decision, and this port exists precisely so that product decisions do not
 * live in the core.
 */
export const defaultExplainer: Explainer = {
  id: 'default',
  explain: (row, board) => {
    const contributions = board.contributions(row)
    const reasons = contributions
      .filter((contribution) => contribution.contribution !== 0)
      .flatMap((contribution) => contribution.reasons)
      .sort((a, b) => b.strength - a.strength)

    return {
      score: toPresentation(board.final(row)),
      baseScore: toPresentation(board.base(row)),
      contributions,
      reasons,
    }
  },
}

/**
 * Built-in normalizers, by id. What `normalization.default` resolves against.
 *
 * All of §12's are here, so `normalization: { default: 'rank' }` works with nothing
 * registered. `minmax` stays the default: it is the one whose behaviour you can predict
 * from the data, and its weakness (outliers) is visible rather than subtle.
 */
export const DEFAULT_NORMALIZERS: ReadonlyMap<string, ScoreNormalizer> = new Map(
  NORMALIZERS.map((normalizer) => [normalizer.id, normalizer]),
)

/**
 * Built-in combiners, by id. What `combiner.id` resolves against.
 *
 * This map is why `configure({ combiner: { id: 'rrf' } })` does anything at all. Until it
 * existed the key was documented in §10, carried a default, and was read by nobody: the
 * pipeline took the combiner from the registry slot and never looked at the config. Every
 * engine combined by weighted sum, whatever it had been told — a setting that silently
 * does nothing, which is the exact failure this codebase rejects everywhere else.
 */
export const DEFAULT_COMBINERS: ReadonlyMap<string, ScoreCombiner> = new Map([
  [weightedSum.id, weightedSum],
  ['rrf', rrfCombiner()],
])

/**
 * The combiner this request should use: the claimed slot, else the configured id.
 *
 * A slot wins over the config because it is the more specific statement — `use(myCombiner)`
 * hands over an object, `combiner.id` names one of ours. A typo in the id is refused
 * either way (see `assertCombinerId`), so the config cannot quietly mean nothing even when
 * a slot makes it moot.
 */
export function combinerFor(
  claimed: ScoreCombiner | undefined,
  configuredId: string,
  combiners: ReadonlyMap<string, ScoreCombiner>,
): ScoreCombiner {
  if (claimed !== undefined) return claimed

  const combiner = combiners.get(configuredId)
  // Not `as ScoreCombiner`. build() checks the configured id, but `request.overrides` can
  // replace it per call, and the cast turned that into a TypeError from inside the
  // combiner's own catch block — a platform error with no code, naming nothing.
  if (combiner === undefined) assertCombinerId(configuredId, combiners)
  return combiner as ScoreCombiner
}

/** Refuses a `combiner.id` naming nothing, at build() rather than at 3am. */
export function assertCombinerId(configuredId: string, combiners: ReadonlyMap<string, ScoreCombiner>): void {
  if (combiners.has(configuredId)) return
  throw new RecoError(
    'INVALID_CONFIG',
    `combiner.id is "${configuredId}", which names no registered combiner. ` +
      `Known: ${[...combiners.keys()].join(', ')}. Register it with use(), or fix the id.`,
  )
}

/** Fills a slot only if nobody claimed it, so `.use(myRanker)` never fights the default. */
export function fillSlot<T>(claimed: T | undefined, fallback: T): T {
  return claimed ?? fallback
}
