import { CandidateSetBuilder } from '../../domain/candidate.js'
import type { Item } from '../../domain/entities.js'
import { RecoError } from '../../kernel/errors.js'
import type { CandidateProvider } from '../../ports/candidate-provider.js'
import type { RequestContext, RetrievalBudget } from '../../ports/context.js'
import { degradeOrThrow, type PolicyContext, warn } from '../policy.js'
import { deadlineOf } from '../request.js'

/**
 * Stage 1. Where candidates come from.
 *
 * Providers run concurrently through `Promise.all` and nothing else: no worker threads,
 * no pool. Real parallelism is the adapter's business, because the moment the core spawns
 * a thread it stops running in a browser (§23.4). What is here is I/O concurrency, which
 * is the only kind that matters when every provider is a query.
 */
export async function retrieve<P>(
  ctx: RequestContext,
  providers: readonly CandidateProvider<P>[],
  policy: PolicyContext,
): Promise<CandidateSetBuilder<P>> {
  const builder = new CandidateSetBuilder<P>()
  if (providers.length === 0) return builder

  const maxCandidates = ctx.config.limits.maxCandidates
  const budget = budgetFor(providers.length, maxCandidates, ctx)

  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        return { provider, items: await provider.provide(ctx, budget) }
      } catch (error) {
        degradeOrThrow(policy, provider, error, `provider "${provider.id}" failed`)
        return { provider, items: undefined }
      }
    }),
  )

  const survivors = results.filter((result) => result.items !== undefined)
  if (survivors.length === 0) {
    // Both policies agree here, and it is the one place they do: there is nothing to
    // recommend from. An empty feed would report this outage as a success.
    throw new RecoError(
      'PORT_FAILED',
      `Every candidate provider failed (${providers.map((p) => p.id).join(', ')}). ` +
        `There is nothing to recommend from, so this is a failed request rather than an empty one.`,
    )
  }

  for (const { provider, items } of survivors) {
    enforce(provider, items as readonly Item<P>[], budget, policy)
    builder.add(provider.id, items as readonly Item<P>[])
  }

  return trim(builder, maxCandidates, policy)
}

/**
 * Splits the ceiling between providers rather than handing each the whole of it.
 *
 * Three providers with `maxCandidates: 5000` each are not a 5000-row ceiling, they are a
 * 15000-row one — and the ceiling exists to bound what one request may cost the database.
 * The cost of the split is real and accepted: if two of the three return nothing, the
 * third fills only its third of the page. Retrieval over-fetches anyway (that is what
 * ranking is for), and a ceiling that multiplies by however many plugins are installed
 * is not a ceiling.
 */
function budgetFor(providerCount: number, maxCandidates: number, ctx: RequestContext): RetrievalBudget {
  return {
    maxItems: Math.max(1, Math.floor(maxCandidates / providerCount)),
    deadline: deadlineOf(ctx),
  }
}

/**
 * The second line of defence, and it says so out loud.
 *
 * A provider that ignored `budget.maxItems` already did the damage: the query ran, the
 * rows were read, the memory was allocated. Trimming here protects this response and
 * nothing else, so it is a warning about a broken provider rather than a mechanism.
 */
function enforce<P>(
  provider: CandidateProvider<P>,
  items: readonly Item<P>[],
  budget: RetrievalBudget,
  policy: PolicyContext,
): void {
  if (items.length <= budget.maxItems) return

  warn(policy, {
    stage: 'retrieval',
    port: provider.id,
    code: 'degraded',
    message:
      `"${provider.id}" was given a budget of ${budget.maxItems} and returned ${items.length}. ` +
      `The engine trims, but the database already paid: translate budget.maxItems into your source's LIMIT.`,
  })
}

/** Union over budget: the same fault, one level up. Trim, and name it. */
function trim<P>(
  builder: CandidateSetBuilder<P>,
  maxCandidates: number,
  policy: PolicyContext,
): CandidateSetBuilder<P> {
  if (builder.size <= maxCandidates) return builder

  warn(policy, {
    stage: 'retrieval',
    port: 'engine',
    code: 'degraded',
    message: `Providers returned ${builder.size} candidates after dedup, over limits.maxCandidates of ${maxCandidates}.`,
  })
  // Deterministic: first come, first kept. Retrieval order is the providers' registration
  // order, so the same request keeps the same candidates rather than a fresh arbitrary set.
  return builder.filter((_candidate, row) => row < maxCandidates)
}
