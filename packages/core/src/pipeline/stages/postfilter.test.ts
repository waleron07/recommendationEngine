import { describe, expect, it } from 'vitest'
import { CandidateSetBuilder } from '../../domain/candidate.js'
import { type FeatureDescriptor, type FeatureSchema, FeatureSchemaBuilder } from '../../domain/feature.js'
import { featureKey, itemId } from '../../domain/ids.js'
import { DenseFeatureMatrix } from '../../domain/matrix.js'
import { DenseProfileVector } from '../../domain/profile.js'
import { ConfigResolver } from '../../kernel/config.js'
import type { PostFilter } from '../../ports/candidate-filter.js'
import type { RequestContext } from '../../ports/context.js'
import type { ScoringView } from '../../ports/scoring-strategy.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { postfilter } from './postfilter.js'

const LICENCE = featureKey('licence_ok')

const descriptor = (key: string): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: key,
  owner: 'licence-extractor',
  ownerVersion: '1.0.0',
})

const schema = (): FeatureSchema => {
  const builder = new FeatureSchemaBuilder()
  builder.register(descriptor('licence_ok'))
  return builder.freeze()
}

const ctx = {
  config: new ConfigResolver().resolve(
    { limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 } },
    [],
  ),
} as RequestContext

const policyWith = (): PolicyContext => ({
  stage: 'postfilter',
  errorPolicy: 'strict',
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

/** Candidates a..n, with licence_ok set from `licences`. */
const fixture = (licences: number[]) => {
  const candidates = new CandidateSetBuilder()
  candidates.add(
    'library',
    licences.map((_, i) => ({ id: itemId(`t${i}`), type: 'track', payload: {} })),
  )
  const set = candidates.build()
  const matrix = new DenseFeatureMatrix(schema(), set.size)
  matrix.columnMut(LICENCE).set(licences)

  const view: ScoringView = { items: matrix, profile: new DenseProfileVector(schema()), ctx }
  return { candidates, set, matrix, view }
}

const licensed: PostFilter = {
  id: 'licence',
  failClosed: true,
  requires: [LICENCE],
  approve: (row, view) => view.items.get(LICENCE, row) === 1,
}

describe('postfilter', () => {
  it('drops what the features say is not allowed', () => {
    const { candidates, set, matrix, view } = fixture([1, 0, 1])
    const result = postfilter(candidates, set, matrix, [licensed], view, ctx, policyWith())

    expect(result.set.candidates.map((c) => c.item.id)).toEqual(['t0', 't2'])
  })

  it('renumbers the matrix with the candidates, so features stay on their own row', () => {
    // The row index is the only thing tying a candidate to its features. A row that
    // outlives its candidate is how one item's affinity lands on another item's score.
    const { candidates, set, matrix, view } = fixture([0, 1, 1])
    const result = postfilter(candidates, set, matrix, [licensed], view, ctx, policyWith())

    expect(result.matrix.rows).toBe(2)
    expect(result.set.at(0).item.id).toBe('t1')
    expect(result.matrix.get(LICENCE, 0)).toBe(1)
    expect(result.matrix.get(LICENCE, 1)).toBe(1)
  })

  it('leaves the set untouched when everything is approved', () => {
    const { candidates, set, matrix, view } = fixture([1, 1])
    const result = postfilter(candidates, set, matrix, [licensed], view, ctx, policyWith())

    // Same object: no copy is worth making when nothing was removed.
    expect(result.matrix).toBe(matrix)
    expect(result.set).toBe(set)
  })

  it('passes through when nothing filters', () => {
    const { candidates, set, matrix, view } = fixture([0, 0])
    expect(postfilter(candidates, set, matrix, [], view, ctx, policyWith()).set).toBe(set)
  })

  it('handles an empty candidate set', () => {
    const { candidates, set, matrix, view } = fixture([])
    expect(postfilter(candidates, set, matrix, [licensed], view, ctx, policyWith()).set.size).toBe(0)
  })

  it('drops every candidate when none is approved', () => {
    const { candidates, set, matrix, view } = fixture([0, 0])
    const result = postfilter(candidates, set, matrix, [licensed], view, ctx, policyWith())

    expect(result.set.size).toBe(0)
    expect(result.matrix.rows).toBe(0)
  })

  it('treats a throw as refusal here too', () => {
    const exploding: PostFilter = {
      id: 'licence',
      failClosed: true,
      requires: [LICENCE],
      approve: (row) => {
        if (row === 0) throw new Error('cannot decide')
        return true
      },
    }
    const { candidates, set, matrix, view } = fixture(Array.from({ length: 100 }, () => 1))
    const result = postfilter(candidates, set, matrix, [exploding], view, ctx, policyWith())

    expect(result.set.size).toBe(99)
    expect(result.set.at(0).item.id).toBe('t1')
  })

  it('keeps the sources of the survivors', () => {
    const candidates = new CandidateSetBuilder()
    candidates.add('history', [{ id: itemId('t0'), type: 'track', payload: {} }])
    candidates.add('cohort', [{ id: itemId('t0'), type: 'track', payload: {} }])
    candidates.add('history', [{ id: itemId('t1'), type: 'track', payload: {} }])

    const set = candidates.build()
    const matrix = new DenseFeatureMatrix(schema(), set.size)
    matrix.columnMut(LICENCE).set([1, 0])
    const view: ScoringView = { items: matrix, profile: new DenseProfileVector(schema()), ctx }

    const result = postfilter(candidates, set, matrix, [licensed], view, ctx, policyWith())
    expect([...result.set.at(0).sources]).toEqual(['history', 'cohort'])
  })
})

describe('DenseFeatureMatrix.select', () => {
  it('copies the chosen rows in the order given', () => {
    const { matrix } = fixture([10, 20, 30])
    const selected = matrix.select([2, 0])

    expect(selected.rows).toBe(2)
    expect([...selected.column(LICENCE)]).toEqual([30, 10])
  })

  it('carries embeddings across', () => {
    const builder = new FeatureSchemaBuilder()
    builder.register({
      key: featureKey('vec'),
      kind: 'embedding',
      arity: 2,
      defaultValue: 0,
      description: 'vec',
      owner: 'x',
      ownerVersion: '1',
    })
    const matrix = new DenseFeatureMatrix(builder.freeze(), 3)
    matrix.vectorMut(featureKey('vec'), 0).set([1, 2])
    matrix.vectorMut(featureKey('vec'), 2).set([5, 6])

    const selected = matrix.select([2, 0])
    expect([...selected.vector(featureKey('vec'), 0)]).toEqual([5, 6])
    expect([...selected.vector(featureKey('vec'), 1)]).toEqual([1, 2])
  })

  it('rejects a row that does not exist rather than reading past the end', () => {
    const { matrix } = fixture([1, 2])
    expect(() => matrix.select([5])).toThrow()
  })

  it('selects nothing without complaint', () => {
    const { matrix } = fixture([1, 2])
    expect(matrix.select([]).rows).toBe(0)
  })
})
