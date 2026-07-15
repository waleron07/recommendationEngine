import { contributionOf, ScoreBoardBuilder } from '../domain/score.js'
import { toPresentation } from '../pipeline/stages/explanation.js'
import type { Explainer } from '../ports/explainer.js'
import type { Ranker } from '../ports/ranker.js'
import type { ScoreCombiner } from '../ports/score-combiner.js'
import type { NormalizedColumn, ScoreNormalizer } from '../ports/score-normalizer.js'

/**
 * Min-max: the honest default, and the one whose failure mode is visible.
 *
 * A flat column (every candidate equally popular) has no spread to normalize, and every
 * answer is a lie of some kind. Zero says "none of these are popular", which at least
 * contributes nothing to the sum; 0.5 or 1 would say "all of these are somewhat popular"
 * and quietly hand the column real influence over the ranking on the strength of no
 * information at all.
 */
export const minmax: ScoreNormalizer = {
  id: 'minmax',
  normalize: (raw) => {
    const out = new Float64Array(raw.length)
    if (raw.length === 0) return out

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const value of raw) {
      if (value < min) min = value
      if (value > max) max = value
    }

    const span = max - min
    if (span === 0) return out
    for (let i = 0; i < raw.length; i++) out[i] = ((raw[i] as number) - min) / span
    return out
  },
}

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
 * Ranking by full sort, for now.
 *
 * §22 puts the top-K heap in stage 4 with the rest of the maths, and a heap is the right
 * answer: ordering 5000 rows to show 20 is 4980 comparisons nobody reads. This is
 * `Array.sort` until then — correct, obvious, and replaceable behind the same port
 * without anything else noticing.
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

/** Built-in normalizers, by id. What `normalization.default` resolves against. */
export const DEFAULT_NORMALIZERS: ReadonlyMap<string, ScoreNormalizer> = new Map([[minmax.id, minmax]])

/** Fills a slot only if nobody claimed it, so `.use(myRanker)` never fights the default. */
export function fillSlot<T>(claimed: T | undefined, fallback: T): T {
  return claimed ?? fallback
}
