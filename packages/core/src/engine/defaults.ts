import { contributionOf, ScoreBoardBuilder } from '../domain/score.js'
import { topK } from '../math/heap.js'
import { NORMALIZERS } from '../math/normalize.js'
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

/** Fills a slot only if nobody claimed it, so `.use(myRanker)` never fights the default. */
export function fillSlot<T>(claimed: T | undefined, fallback: T): T {
  return claimed ?? fallback
}
