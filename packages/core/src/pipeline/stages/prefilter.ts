import type { Candidate, CandidateSetBuilder } from '../../domain/candidate.js'
import type { PreFilter } from '../../ports/candidate-filter.js'
import type { RequestContext } from '../../ports/context.js'
import { FilterErrorBudget, type PolicyContext } from '../policy.js'

/**
 * Stage 2. Hard rules decidable from the payload alone, before anything expensive.
 *
 * The fail-closed contract is enforced here rather than trusted: a filter that throws
 * does not get its candidate through. `approve()` is total by design — two outcomes — and
 * an exception is not a third one. What is not explicitly approved does not pass.
 *
 * Note there is no `criticality` to consult. Offering the choice would itself have been
 * the bug: nobody should be able to configure the licence check into `optional`.
 *
 * Takes and returns the builder rather than a built set. Rebuilding the survivors by hand
 * would mean re-adding each candidate under one provider id, and a candidate found by two
 * providers would quietly lose one of them — which is half of its future explanation
 * ("like what you played" *and* "popular with users like you"). `filter()` keeps the
 * sources and renumbers the rows, which is exactly what it was written for.
 */
export function prefilter<P>(
  candidates: CandidateSetBuilder<P>,
  filters: readonly PreFilter<P>[],
  ctx: RequestContext,
  policy: PolicyContext,
): CandidateSetBuilder<P> {
  if (filters.length === 0 || candidates.size === 0) return candidates

  const budget = new FilterErrorBudget(policy, candidates.size, ctx.config.filterErrorBudget)
  return candidates.filter((candidate) => approvedByAll(candidate, filters, ctx, budget))
}

function approvedByAll<P>(
  candidate: Candidate<P>,
  filters: readonly PreFilter<P>[],
  ctx: RequestContext,
  budget: FilterErrorBudget,
): boolean {
  for (const filter of filters) {
    try {
      // Every filter must say yes. One refusal is enough, and the first one ends it —
      // there is nothing to learn from asking the rest about a candidate already out.
      if (!filter.approve(candidate, ctx)) return false
    } catch (error) {
      return budget.refuse(filter.id, candidate.item.id, error)
    }
  }
  return true
}
