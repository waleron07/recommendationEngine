import type { CandidateSet, CandidateSetBuilder } from '../../domain/candidate.js'
import type { DenseFeatureMatrix } from '../../domain/matrix.js'
import type { PostFilter } from '../../ports/candidate-filter.js'
import type { RequestContext } from '../../ports/context.js'
import type { ScoringView } from '../../ports/scoring-strategy.js'
import { FilterErrorBudget, type PolicyContext } from '../policy.js'

export interface Filtered<P> {
  readonly candidates: CandidateSetBuilder<P>
  readonly set: CandidateSet<P>
  readonly matrix: DenseFeatureMatrix
}

/**
 * Stage 4b. The rules that could not be decided from the payload alone.
 *
 * Same fail-closed contract as stage 2, and it exists because of the other half of that
 * contract: `approve()` is synchronous, so a rule needing a licence check cannot fetch
 * one — the answer has to already be in a feature. This is where such a rule runs, right
 * after the features exist and still before scoring, because computing a score for a
 * candidate that will not be shown is pure waste.
 *
 * Rebuilds both the set and the matrix when anything is dropped: the row index is the only
 * thing tying a candidate to its features, so a row that outlives its candidate is how
 * one item's affinity ends up on another item's score.
 */
export function postfilter<P>(
  candidates: CandidateSetBuilder<P>,
  set: CandidateSet<P>,
  matrix: DenseFeatureMatrix,
  filters: readonly PostFilter[],
  view: ScoringView,
  ctx: RequestContext,
  policy: PolicyContext,
): Filtered<P> {
  if (filters.length === 0 || set.size === 0) return { candidates, set, matrix }

  const budget = new FilterErrorBudget(policy, set.size, ctx.config.filterErrorBudget)
  const kept: number[] = []

  for (let row = 0; row < set.size; row++) {
    if (approvedByAll(row, filters, view, set.at(row).item.id, budget)) kept.push(row)
  }

  if (kept.length === set.size) return { candidates, set, matrix }

  // A Set, not kept.includes(): the array scan would make this O(candidates²), which at
  // the 5000-row ceiling is 25M comparisons to answer a question about membership.
  const keptRows = new Set(kept)
  const survivors = candidates.filter((_candidate, row) => keptRows.has(row))
  return { candidates: survivors, set: survivors.build(), matrix: matrix.select(kept) }
}

function approvedByAll(
  row: number,
  filters: readonly PostFilter[],
  view: ScoringView,
  itemId: string,
  budget: FilterErrorBudget,
): boolean {
  for (const filter of filters) {
    try {
      if (!filter.approve(row, view)) return false
    } catch (error) {
      return budget.refuse(filter.id, itemId, error)
    }
  }
  return true
}
