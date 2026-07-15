import { describe, expect, it } from 'vitest'
import { strategyId } from '../../domain/ids.js'
import type { ScoreColumn } from '../../domain/score.js'
import type { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { ScoreNormalizer } from '../../ports/score-normalizer.js'
import type { ScoringStrategy } from '../../ports/scoring-strategy.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { normalize } from './normalization.js'
import type { ScoredColumn } from './scoring.js'

const minmax: ScoreNormalizer = {
  id: 'minmax',
  normalize: (raw) => {
    const min = Math.min(...raw)
    const max = Math.max(...raw)
    const span = max - min
    return raw.map((value) => (span === 0 ? 0 : (value - min) / span)) as Float64Array
  },
}

const identity: ScoreNormalizer = { id: 'identity', normalize: (raw) => raw }

const registry = new Map<string, ScoreNormalizer>([
  ['minmax', minmax],
  ['identity', identity],
])

const ctxWith = (normalization: { default: string; perStrategy?: Record<string, string> }): RequestContext =>
  ({ signal: new AbortController().signal, config: { normalization } }) as RequestContext

const policyWith = (): PolicyContext => ({
  stage: 'normalization',
  errorPolicy: 'strict',
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

const scored = (id: string, raw: number[], normalizer?: ScoreNormalizer): ScoredColumn => {
  const column: ScoreColumn = { strategyId: strategyId(id), raw: new Float64Array(raw), reasons: new Map() }
  const strategy = {
    id: strategyId(id),
    requires: [],
    ...(normalizer === undefined ? {} : { normalizer }),
    score: () => column,
  } as ScoringStrategy
  return { column, weight: 1, strategy }
}

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('normalization is what makes weights mean anything', () => {
  it('maps a wild scale onto [0..1]', () => {
    // 4_200_000 plays and 0.87 recency become comparable. Without this, balancing them
    // needs popularity: 0.0000001, and one viral track rescales everyone's feed.
    const [column] = normalize(
      [scored('popularity', [0, 2_100_000, 4_200_000])],
      registry,
      ctxWith({ default: 'minmax' }),
      policyWith(),
    )

    expect([...(column?.normalized ?? [])]).toEqual([0, 0.5, 1])
  })

  it('keeps the raw column, because "played 143 times" needs the 143', () => {
    const [column] = normalize(
      [scored('plays', [143])],
      registry,
      ctxWith({ default: 'minmax' }),
      policyWith(),
    )
    expect([...(column?.raw ?? [])]).toEqual([143])
  })

  it('carries weight and reasons through untouched', () => {
    const [column] = normalize(
      [scored('artist', [1, 2])],
      registry,
      ctxWith({ default: 'minmax' }),
      policyWith(),
    )

    expect(column?.weight).toBe(1)
    expect(column?.strategyId).toBe('artist')
  })

  it('normalizes nothing without complaint', () => {
    expect(normalize([], registry, ctxWith({ default: 'minmax' }), policyWith())).toEqual([])
  })
})

describe('choosing the normalizer', () => {
  it('lets the strategy decide, because it knows its own scale', () => {
    const [column] = normalize(
      [scored('recency', [0.5], identity)],
      registry,
      ctxWith({ default: 'minmax' }),
      policyWith(),
    )
    expect([...(column?.normalized ?? [])]).toEqual([0.5])
  })

  it('falls back to the per-strategy config, then to the default', () => {
    const [perStrategy] = normalize(
      [scored('recency', [0.5])],
      registry,
      ctxWith({ default: 'minmax', perStrategy: { recency: 'identity' } }),
      policyWith(),
    )
    expect([...(perStrategy?.normalized ?? [])]).toEqual([0.5])

    const [byDefault] = normalize(
      [scored('artist', [5, 10])],
      registry,
      ctxWith({ default: 'minmax' }),
      policyWith(),
    )
    expect([...(byDefault?.normalized ?? [])]).toEqual([0, 1])
  })

  it('refuses a normalizer that is configured but not registered', () => {
    const error = failure(() =>
      normalize([scored('artist', [1])], registry, ctxWith({ default: 'zscore' }), policyWith()),
    )

    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toContain('zscore')
  })
})

describe('a normalizer that lies is caught, not trusted', () => {
  const lying = (id: string, output: number[]): ScoreNormalizer => ({
    id,
    normalize: () => new Float64Array(output),
  })

  it('rejects output outside [0..1], because the weights assume it', () => {
    const error = failure(() =>
      normalize(
        [scored('artist', [1, 2], lying('bad', [0.5, 42]))],
        registry,
        ctxWith({ default: 'minmax' }),
        policyWith(),
      ),
    )

    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toContain('42')
  })

  it('rejects a NaN before it reaches the sum', () => {
    // One NaN in the weighted sum makes every comparison against it false: the ranking
    // collapses into insertion order while every score still looks like a number.
    const error = failure(() =>
      normalize(
        [scored('artist', [1], lying('bad', [Number.NaN]))],
        registry,
        ctxWith({ default: 'minmax' }),
        policyWith(),
      ),
    )
    expect(error.code).toBe('PORT_FAILED')
  })

  it('rejects a column of the wrong length — rows are positional', () => {
    const error = failure(() =>
      normalize(
        [scored('artist', [1, 2, 3], lying('bad', [0.5]))],
        registry,
        ctxWith({ default: 'minmax' }),
        policyWith(),
      ),
    )
    expect(error.message).toMatch(/silently rescores everyone below it/)
  })

  it('fails the request when the normalizer throws, rather than passing the raw column on', () => {
    const broken: ScoreNormalizer = {
      id: 'broken',
      normalize: () => {
        throw new Error('maths went wrong')
      },
    }

    const error = failure(() =>
      normalize(
        [scored('popularity', [4_200_000], broken)],
        registry,
        ctxWith({ default: 'minmax' }),
        policyWith(),
      ),
    )

    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toMatch(/its scale would swamp the sum/)
  })
})
