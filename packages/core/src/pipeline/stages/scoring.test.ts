import { describe, expect, it } from 'vitest'
import { type CandidateSet, CandidateSetBuilder } from '../../domain/candidate.js'
import { FeatureSchemaBuilder } from '../../domain/feature.js'
import { featureKey, itemId, type StrategyId, strategyId } from '../../domain/ids.js'
import { DenseFeatureMatrix } from '../../domain/matrix.js'
import { DenseProfileVector } from '../../domain/profile.js'
import type { ScoreColumn } from '../../domain/score.js'
import type { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { DomainScoringStrategy, ScoringStrategy, ScoringView } from '../../ports/scoring-strategy.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { score } from './scoring.js'

const schema = new FeatureSchemaBuilder().freeze()

const set: CandidateSet = (() => {
  const builder = new CandidateSetBuilder()
  builder.add('library', [{ id: itemId('a'), type: 'track', payload: { title: 'A' } }])
  return builder.build()
})()

const ctxWith = (weights: [string, number][] = [], history = 100): RequestContext =>
  ({
    signal: new AbortController().signal,
    history: { size: history },
    config: { weights: new Map(weights.map(([id, w]) => [strategyId(id) as StrategyId, w])) },
  }) as RequestContext

const view: ScoringView = {
  items: new DenseFeatureMatrix(schema, 1),
  profile: new DenseProfileVector(schema),
  ctx: ctxWith(),
}

const policyWith = (errorPolicy: 'strict' | 'degrade' = 'strict'): PolicyContext => ({
  stage: 'scoring',
  errorPolicy,
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

const column = (id: string, value: number): ScoreColumn => ({
  strategyId: strategyId(id),
  raw: new Float64Array([value]),
  reasons: new Map(),
})

const strategy = (id: string, value = 1): ScoringStrategy => ({
  id: strategyId(id),
  requires: [],
  score: () => column(id, value),
})

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('scoring', () => {
  it('produces one column per strategy, with its configured weight', () => {
    const columns = score(
      [strategy('artist', 0.9), strategy('genre', 0.6)],
      set,
      view,
      ctxWith([
        ['artist', 0.9],
        ['genre', 0.6],
      ]),
      new Set(),
      policyWith(),
    )

    expect(columns.map((c) => [c.column.strategyId, c.weight])).toEqual([
      ['artist', 0.9],
      ['genre', 0.6],
    ])
  })

  it('gives an unweighted strategy an equal vote', () => {
    expect(score([strategy('artist')], set, view, ctxWith(), new Set(), policyWith())[0]?.weight).toBe(1)
  })

  it('returns nothing for an engine with no strategies', () => {
    expect(score([], set, view, ctxWith(), new Set(), policyWith())).toEqual([])
  })

  it('hands the candidate set to a domain strategy and withholds it from a plain one', () => {
    // The escape hatch is priced at the type level, not hidden: a domain strategy sees the
    // payload, a plain one never does.
    let seen: CandidateSet | undefined
    const domain: DomainScoringStrategy = {
      id: strategyId('title'),
      requires: [],
      domain: true,
      score: (_view, candidates) => {
        seen = candidates
        return column('title', 1)
      },
    }

    let plainArgs = 0
    const plain: ScoringStrategy = {
      id: strategyId('artist'),
      requires: [],
      score: (...args) => {
        plainArgs = args.length
        return column('artist', 1)
      },
    }

    score([domain, plain], set, view, ctxWith(), new Set(), policyWith())
    expect(seen).toBe(set)
    expect(plainArgs).toBe(1)
  })
})

describe('applicability (§17.3)', () => {
  it('stands a strategy down for a request it cannot speak to', () => {
    // Cold start, declared rather than coded: a user with no history gets popularity and
    // recency because the other strategies stood down, not because someone wrote
    // `if (isNewUser)` in the core.
    const coldStart: ScoringStrategy = {
      id: strategyId('history'),
      requires: [],
      applicable: (ctx) => ctx.history.size >= 20,
      score: () => column('history', 1),
    }

    const policy = policyWith()
    const columns = score([coldStart, strategy('popularity')], set, view, ctxWith([], 3), new Set(), policy)

    expect(columns.map((c) => c.column.strategyId)).toEqual(['popularity'])
    expect(policy.diagnostics.collected[0]).toMatchObject({ port: 'history', code: 'not_applicable' })
  })

  it('keeps a strategy that does apply', () => {
    const applies: ScoringStrategy = {
      id: strategyId('history'),
      requires: [],
      applicable: (ctx) => ctx.history.size >= 20,
      score: () => column('history', 1),
    }

    expect(score([applies], set, view, ctxWith([], 100), new Set(), policyWith())).toHaveLength(1)
  })

  it('stands down a strategy whose profile feature could not be computed', () => {
    // A degraded profile feature is unknown, not zero. Scoring on it confidently would be
    // scoring on nothing.
    const needsProfile: ScoringStrategy = {
      id: strategyId('taste'),
      requires: [],
      requiresProfile: [featureKey('taste_centroid')],
      score: () => column('taste', 1),
    }

    const policy = policyWith()
    const columns = score([needsProfile], set, view, ctxWith(), new Set(['taste_centroid']), policy)

    expect(columns).toEqual([])
    expect(policy.diagnostics.collected[0]?.message).toContain('taste_centroid')
  })

  it('keeps a profile strategy when its features were computed', () => {
    const needsProfile: ScoringStrategy = {
      id: strategyId('taste'),
      requires: [],
      requiresProfile: [featureKey('taste_centroid')],
      score: () => column('taste', 1),
    }

    expect(score([needsProfile], set, view, ctxWith(), new Set(), policyWith())).toHaveLength(1)
  })
})

describe('when a strategy throws (§17.2)', () => {
  const broken: ScoringStrategy = {
    id: strategyId('artist'),
    requires: [],
    score: () => {
      throw new Error('maths went wrong')
    },
  }

  it('fails the request under strict', () => {
    expect(failure(() => score([broken], set, view, ctxWith(), new Set(), policyWith('strict'))).code).toBe(
      'PORT_FAILED',
    )
  })

  it('drops the column under degrade, which cannot skew the scale', () => {
    // The weight leaves both sums together, so the survivors re-weight themselves — the
    // same mechanism as standing down, which is why strategies have no criticality.
    const policy = policyWith('degrade')
    const columns = score([broken, strategy('genre')], set, view, ctxWith(), new Set(), policy)

    expect(columns.map((c) => c.column.strategyId)).toEqual(['genre'])
    expect(policy.diagnostics.collected[0]?.message).toMatch(/weights redistributed/)
  })

  it('lets an abort through as an abort', () => {
    const cooperative: ScoringStrategy = {
      id: strategyId('ppr'),
      requires: [],
      score: () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    }

    expect(() => score([cooperative], set, view, ctxWith(), new Set(), policyWith('degrade'))).toThrow(
      'aborted',
    )
  })

  it('checks the signal between strategies', () => {
    const controller = new AbortController()
    const ctx = { ...ctxWith(), signal: controller.signal } as RequestContext
    const ran: string[] = []
    const record = (id: string, then?: () => void): ScoringStrategy => ({
      id: strategyId(id),
      requires: [],
      score: () => {
        ran.push(id)
        then?.()
        return column(id, 1)
      },
    })

    expect(() =>
      score(
        [record('first', () => controller.abort()), record('second')],
        set,
        view,
        ctx,
        new Set(),
        policyWith(),
      ),
    ).toThrow()
    expect(ran).toEqual(['first'])
  })
})
