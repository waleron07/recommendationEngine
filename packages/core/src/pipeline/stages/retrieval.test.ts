import { describe, expect, it, vi } from 'vitest'
import type { Item } from '../../domain/entities.js'
import { itemId, timestamp } from '../../domain/ids.js'
import { ConfigResolver, type ResolvedConfig } from '../../kernel/config.js'
import type { RecoError } from '../../kernel/errors.js'
import type { CandidateProvider } from '../../ports/candidate-provider.js'
import type { RequestContext, RetrievalBudget } from '../../ports/context.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { retrieve } from './retrieval.js'

const NOW = 1_700_000_000_000

const config = (maxCandidates = 5_000): ResolvedConfig =>
  // maxLimit rides below maxCandidates: the resolver rejects a page retrieval can never
  // fill, and these tests deliberately use tiny ceilings.
  new ConfigResolver().resolve(
    { limits: { maxCandidates, maxLimit: Math.min(100, maxCandidates), timeoutMs: 200 } },
    [],
  )

const ctxWith = (maxCandidates = 5_000): RequestContext =>
  ({
    now: timestamp(NOW),
    config: config(maxCandidates),
    signal: new AbortController().signal,
  }) as RequestContext

const policyWith = (errorPolicy: 'strict' | 'degrade' = 'strict'): PolicyContext => ({
  stage: 'retrieval',
  errorPolicy,
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

const tracks = (...ids: string[]): Item[] => ids.map((id) => ({ id: itemId(id), type: 'track', payload: {} }))

const provider = (id: string, items: Item[]): CandidateProvider => ({
  id,
  version: '1.0.0',
  provide: async () => items,
})

const broken = (id: string, criticality?: 'required' | 'optional'): CandidateProvider => ({
  id,
  version: '1.0.0',
  ...(criticality === undefined ? {} : { criticality }),
  provide: async () => {
    throw new Error(`${id} is down`)
  },
})

const failure = async (fn: () => Promise<unknown>): Promise<RecoError> => {
  try {
    await fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('an engine with nothing to retrieve from', () => {
  it('returns an empty set rather than failing', async () => {
    // The acceptance criterion of this stage: an empty engine answers, it does not throw.
    const candidates = await retrieve(ctxWith(), [], policyWith())
    expect(candidates.size).toBe(0)
  })
})

describe('the budget is pushed into the provider (§23.3)', () => {
  it('hands every provider a budget and a deadline', async () => {
    const seen: RetrievalBudget[] = []
    const spy: CandidateProvider = {
      id: 'library',
      version: '1',
      provide: async (_ctx, budget) => {
        seen.push(budget)
        return tracks('a')
      },
    }

    await retrieve(ctxWith(5_000), [spy], policyWith())
    expect(seen).toEqual([{ maxItems: 5_000, deadline: NOW + 200 }])
  })

  it('splits the ceiling between providers instead of multiplying it by their count', async () => {
    // Three providers at 5000 each is a 15000-row ceiling, and the ceiling exists to bound
    // what one request may cost the database.
    const seen: number[] = []
    const spy = (id: string): CandidateProvider => ({
      id,
      version: '1',
      provide: async (_ctx, budget) => {
        seen.push(budget.maxItems)
        return []
      },
    })

    await retrieve(ctxWith(900), [spy('a'), spy('b'), spy('c')], policyWith())
    expect(seen).toEqual([300, 300, 300])
  })

  it('never hands out a budget of zero, however many providers there are', async () => {
    const seen: number[] = []
    const spy = (id: string): CandidateProvider => ({
      id,
      version: '1',
      provide: async (_ctx, budget) => {
        seen.push(budget.maxItems)
        return []
      },
    })

    await retrieve(ctxWith(2), [spy('a'), spy('b'), spy('c')], policyWith())
    expect(seen).toEqual([1, 1, 1])
  })

  it('warns about a provider that ignored its budget, because the database already paid', async () => {
    const policy = policyWith()
    await retrieve(ctxWith(2), [provider('greedy', tracks('a', 'b', 'c', 'd'))], policy)

    expect(policy.diagnostics.collected[0]?.message).toMatch(
      /translate budget.maxItems into your source's LIMIT/,
    )
    expect(policy.diagnostics.collected[0]?.port).toBe('greedy')
  })

  it('trims the union over the ceiling, deterministically', async () => {
    const policy = policyWith()
    const candidates = await retrieve(
      ctxWith(3),
      [provider('a', tracks('a1', 'a2')), provider('b', tracks('b1', 'b2'))],
      policy,
    )

    expect(candidates.size).toBe(3)
    expect(candidates.build().candidates.map((c) => c.item.id)).toEqual(['a1', 'a2', 'b1'])
  })
})

describe('merging', () => {
  it('runs providers concurrently rather than one after another', async () => {
    const started: string[] = []
    const slow = (id: string, ms: number): CandidateProvider => ({
      id,
      version: '1',
      provide: async () => {
        started.push(id)
        await new Promise((resolve) => setTimeout(resolve, ms))
        return tracks(id)
      },
    })

    await retrieve(ctxWith(), [slow('a', 20), slow('b', 1)], policyWith())
    // Both are in flight before either finishes; sequential retrieval would be the sum.
    expect(started).toEqual(['a', 'b'])
  })

  it('dedups across providers and remembers every source of a candidate', async () => {
    // Two sources is two reasons to show it, and both belong in the explanation.
    const candidates = await retrieve(
      ctxWith(),
      [provider('history', tracks('shared', 'a')), provider('cohort', tracks('shared', 'b'))],
      policyWith(),
    )
    const set = candidates.build()

    expect(set.size).toBe(3)
    expect([...set.at(0).sources]).toEqual(['history', 'cohort'])
  })
})

describe('when a provider fails (§17.2)', () => {
  it('fails the request under strict', async () => {
    const error = await failure(() =>
      retrieve(ctxWith(), [provider('good', tracks('a')), broken('bad')], policyWith('strict')),
    )
    expect(error.code).toBe('PORT_FAILED')
  })

  it('fails the request for a required provider even under degrade', async () => {
    // The matrix of §17.2 reads "degrade: carry on with the rest", but criticality is on
    // this port for a reason: a source that is the only holder of licensed items is not
    // "fewer candidates" when it dies. Honour the field, or it is decoration.
    const error = await failure(() =>
      retrieve(ctxWith(), [provider('good', tracks('a')), broken('bad')], policyWith('degrade')),
    )
    expect(error.code).toBe('PORT_FAILED')
  })

  it('carries on with the rest when the failed provider said it was optional', async () => {
    const policy = policyWith('degrade')
    const candidates = await retrieve(
      ctxWith(),
      [provider('good', tracks('a')), broken('bad', 'optional')],
      policy,
    )

    expect(candidates.size).toBe(1)
    expect(policy.diagnostics.collected[0]).toMatchObject({ port: 'bad', code: 'degraded' })
  })

  it('fails when every provider is down, even though each one said it was optional', async () => {
    // Optional and degrade means each failure alone is survivable. All of them together
    // is not: an empty feed would report the outage as a success.
    const error = await failure(() =>
      retrieve(ctxWith(), [broken('a', 'optional'), broken('b', 'optional')], policyWith('degrade')),
    )

    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toMatch(/failed request rather than an empty one/i)
  })

  it('fails on the first provider down under strict, without waiting to see the rest', async () => {
    const error = await failure(() =>
      retrieve(ctxWith(), [broken('a', 'optional'), broken('b', 'optional')], policyWith('strict')),
    )
    expect(error.code).toBe('PORT_FAILED')
  })

  it('does not confuse "everyone returned nothing" with "everyone is down"', async () => {
    const candidates = await retrieve(ctxWith(), [provider('a', []), provider('b', [])], policyWith())
    expect(candidates.size).toBe(0)
  })

  it('passes the request context down, so a provider can forward the signal', async () => {
    const provide = vi.fn(async () => [])
    const ctx = ctxWith()
    await retrieve(ctx, [{ id: 'library', version: '1', provide }], policyWith())

    expect(provide.mock.calls[0]?.[0]).toBe(ctx)
  })
})
