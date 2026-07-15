import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RecoError } from '../kernel/errors.js'
import { type FeatureDescriptor, FeatureSchemaBuilder } from './feature.js'
import { featureKey } from './ids.js'
import { DenseFeatureMatrix } from './matrix.js'
import { DenseProfileVector } from './profile.js'

const scalar = (key: string, over: Partial<FeatureDescriptor> = {}): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: `test feature ${key}`,
  owner: 'extractor:test',
  ownerVersion: '1.0.0',
  ...over,
})

const schemaOf = (...descriptors: FeatureDescriptor[]) => {
  const builder = new FeatureSchemaBuilder()
  for (const d of descriptors) builder.register(d)
  return builder.freeze()
}

const A = featureKey('a')
const B = featureKey('b')
const EMB = featureKey('emb')

describe('DenseFeatureMatrix', () => {
  it('keeps columns independent — writing one feature leaves the others alone', () => {
    const matrix = new DenseFeatureMatrix(schemaOf(scalar('a'), scalar('b')), 3)
    matrix.columnMut(A).set([1, 2, 3])

    expect([...matrix.column(A)]).toEqual([1, 2, 3])
    expect([...matrix.column(B)]).toEqual([0, 0, 0])
  })

  it('returns a view, not a copy: writes through column() land in the matrix', () => {
    const matrix = new DenseFeatureMatrix(schemaOf(scalar('a')), 2)
    matrix.columnMut(A)[1] = 42
    expect(matrix.get(A, 1)).toBe(42)
  })

  it('seeds each feature from its own defaultValue, because zero is not neutral', () => {
    // An absent item_age_days of 0 would declare every item brand new. The descriptor
    // decides what absence means; the matrix must honour that per feature.
    const matrix = new DenseFeatureMatrix(schemaOf(scalar('a', { defaultValue: 0.5 }), scalar('b')), 2)

    expect([...matrix.column(A)]).toEqual([0.5, 0.5])
    expect([...matrix.column(B)]).toEqual([0, 0])
  })

  it('gives each embedding row a contiguous slice, so cosine never gathers', () => {
    const matrix = new DenseFeatureMatrix(
      schemaOf(scalar('a'), scalar('emb', { kind: 'embedding', arity: 4 })),
      3,
    )
    matrix.vectorMut(EMB, 0).set([1, 2, 3, 4])
    matrix.vectorMut(EMB, 2).set([9, 9, 9, 9])

    expect([...matrix.vector(EMB, 0)]).toEqual([1, 2, 3, 4])
    expect([...matrix.vector(EMB, 1)]).toEqual([0, 0, 0, 0])
    expect([...matrix.vector(EMB, 2)]).toEqual([9, 9, 9, 9])
  })

  it('keeps scalars and embeddings in separate blocks that cannot overwrite each other', () => {
    const matrix = new DenseFeatureMatrix(
      schemaOf(scalar('a'), scalar('emb', { kind: 'embedding', arity: 2 })),
      2,
    )
    matrix.columnMut(A).set([7, 8])
    matrix.vectorMut(EMB, 0).set([1, 1])
    matrix.vectorMut(EMB, 1).set([2, 2])

    expect([...matrix.column(A)]).toEqual([7, 8])
    expect([...matrix.vector(EMB, 0)]).toEqual([1, 1])
    expect([...matrix.vector(EMB, 1)]).toEqual([2, 2])
  })

  it('rejects out-of-range rows instead of reading a neighbour', () => {
    const matrix = new DenseFeatureMatrix(schemaOf(scalar('a')), 2)
    expect(() => matrix.get(A, 2)).toThrow(RecoError)
    expect(() => matrix.get(A, -1)).toThrow(RecoError)
  })

  it('sends scalars and embeddings to the right accessor', () => {
    const matrix = new DenseFeatureMatrix(
      schemaOf(scalar('a'), scalar('emb', { kind: 'embedding', arity: 2 })),
      1,
    )
    expect(() => matrix.vector(A, 0)).toThrow(/scalar/)
    expect(() => matrix.get(EMB, 0)).toThrow(/vector\(\)/)
  })

  it('handles an empty candidate set without allocating nonsense', () => {
    const matrix = new DenseFeatureMatrix(schemaOf(scalar('a')), 0)
    expect(matrix.rows).toBe(0)
    expect(matrix.column(A).length).toBe(0)
  })

  it('round-trips any value at any row: no aliasing between rows or features', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.double({ noNaN: true, min: -1e6, max: 1e6 }), { minLength: 1, maxLength: 6 }),
        (rows, values) => {
          const matrix = new DenseFeatureMatrix(schemaOf(scalar('a'), scalar('b')), rows)
          for (let row = 0; row < rows; row++) {
            const value = values[row % values.length] as number
            matrix.columnMut(A)[row] = value
          }
          for (let row = 0; row < rows; row++) {
            expect(matrix.get(A, row)).toBe(values[row % values.length])
            expect(matrix.get(B, row)).toBe(0)
          }
        },
      ),
    )
  })
})

describe('DenseProfileVector', () => {
  it('stores scalars and embeddings side by side', () => {
    const profile = new DenseProfileVector(
      schemaOf(scalar('a'), scalar('emb', { kind: 'embedding', arity: 3 })),
    )
    profile.set(A, 0.75)
    profile.setVector(EMB, Float64Array.from([1, 2, 3]))

    expect(profile.get(A)).toBe(0.75)
    expect([...profile.vector(EMB)]).toEqual([1, 2, 3])
  })

  it('seeds from defaultValue like the matrix does', () => {
    const profile = new DenseProfileVector(schemaOf(scalar('a', { defaultValue: 0.5 })))
    expect(profile.get(A)).toBe(0.5)
  })

  it('rejects a vector of the wrong arity rather than truncating it', () => {
    const profile = new DenseProfileVector(schemaOf(scalar('emb', { kind: 'embedding', arity: 3 })))
    expect(() => profile.setVector(EMB, Float64Array.from([1, 2]))).toThrow(
      /arity 3 but was given .* length 2/,
    )
  })

  it('copies on setVector, so a reused caller buffer cannot mutate the profile', () => {
    const profile = new DenseProfileVector(schemaOf(scalar('emb', { kind: 'embedding', arity: 2 })))
    const scratch = Float64Array.from([1, 2])
    profile.setVector(EMB, scratch)
    scratch[0] = 99

    expect([...profile.vector(EMB)]).toEqual([1, 2])
  })

  it('names the missing feature', () => {
    const profile = new DenseProfileVector(schemaOf(scalar('a')))
    expect(() => profile.get(featureKey('ghost'))).toThrow(/not declared/)
  })
})
