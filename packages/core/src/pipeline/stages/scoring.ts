import type { CandidateSet } from '../../domain/candidate.js'
import type { StrategyId } from '../../domain/ids.js'
import type { ScoreColumn } from '../../domain/score.js'
import { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import { type AnyScoringStrategy, isDomainStrategy, type ScoringView } from '../../ports/scoring-strategy.js'
import { type PolicyContext, rethrowIfAborted, warn } from '../policy.js'

export interface ScoredColumn {
  readonly column: ScoreColumn
  readonly weight: number
  readonly strategy: AnyScoringStrategy
}

/**
 * Stage 5. Every strategy produces one column of raw numbers.
 *
 * Nothing here is concurrent, and that is not an oversight: `score()` is synchronous by
 * contract (§23.2), so there is no I/O to overlap. `Promise.all` over a list of
 * synchronous calls would buy nothing and suggest that an `async score()` might one day
 * be welcome. It will not be.
 */
export function score<P>(
  strategies: readonly AnyScoringStrategy<P>[],
  set: CandidateSet<P>,
  view: ScoringView,
  ctx: RequestContext,
  degradedProfile: ReadonlySet<string>,
  policy: PolicyContext,
): readonly ScoredColumn[] {
  const columns: ScoredColumn[] = []

  for (const strategy of strategies) {
    ctx.signal.throwIfAborted()

    const standDown = reasonToStandDown(strategy, ctx, degradedProfile)
    if (standDown !== undefined) {
      // No column, no weight, no contribution. §11.2 normalises on Σ weights, so the
      // remaining strategies re-weight themselves and a threshold like `score > 80 → push`
      // keeps meaning what it meant. Cold start costs nothing and needs no `if` in the core.
      warn(policy, { stage: 'scoring', port: strategy.id, code: 'not_applicable', message: standDown })
      continue
    }

    const weight = ctx.config.weights.get(strategy.id as StrategyId) ?? 1
    try {
      const column = isDomainStrategy(strategy) ? strategy.score(view, set) : strategy.score(view)
      columns.push({ column, weight, strategy: strategy as AnyScoringStrategy })
    } catch (error) {
      rethrowIfAborted(error)
      if (policy.errorPolicy === 'strict') {
        throw new RecoError('PORT_FAILED', `scoring: strategy "${strategy.id}" failed`, { cause: error })
      }
      // Dropping a column is safe for exactly the reason standing down is: the weight
      // leaves both sums together. Strategies have no `criticality` because this is the
      // one degradation that cannot skew the scale.
      warn(policy, {
        stage: 'scoring',
        port: strategy.id,
        code: 'degraded',
        message: `strategy "${strategy.id}" threw; its column was dropped and the weights redistributed.`,
        cause: error,
      })
    }
  }

  return columns
}

/**
 * Whether this strategy has anything to say about this request.
 *
 * Deliberately not `supports()`/`canHandle()`: schema compatibility was settled at
 * `build()`, and re-asking it per request would move a startup error into production.
 * This asks a different question — is the *request* one this strategy can speak to — and
 * the answer changes per user, not per deploy.
 */
function reasonToStandDown<P>(
  strategy: AnyScoringStrategy<P>,
  ctx: RequestContext,
  degradedProfile: ReadonlySet<string>,
): string | undefined {
  // A profile feature that degraded is not zero, it is unknown. A strategy built on a
  // taste centroid that was never computed would score confidently on nothing.
  const missing = (strategy.requiresProfile ?? []).filter((key) => degradedProfile.has(key))
  if (missing.length > 0) {
    return `"${strategy.id}" needs profile features that could not be computed (${missing.join(', ')}), so it stood down.`
  }

  if (strategy.applicable?.(ctx) === false) {
    return `"${strategy.id}" does not apply to this request; its weight was redistributed.`
  }

  return undefined
}
