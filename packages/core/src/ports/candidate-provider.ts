import type { Item } from '../domain/entities.js'
import type { Criticality, RequestContext, RetrievalBudget } from './context.js'

/**
 * Stage 1. Where candidates come from: a query, an index, an ANN lookup, a static list.
 *
 * One of the two places in the engine allowed to touch the network — and therefore
 * obliged to pass `ctx.signal` down into the driver. Without it a cancelled request
 * leaves the connection held, and `limits.timeoutMs` protects the caller while the pool
 * drains anyway.
 */
export interface CandidateProvider<P = unknown> extends Criticality {
  readonly id: string
  readonly version: string
  provide(ctx: RequestContext, budget: RetrievalBudget): Promise<readonly Item<P>[]>
}
