import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FeatureCollisionError, RecoError } from '../kernel/errors.js'
import { type FeatureDescriptor, FeatureSchemaBuilder } from './feature.js'
import { featureKey } from './ids.js'

const scalar = (key: string, over: Partial<FeatureDescriptor> = {}): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: `test feature ${key}`,
  owner: 'extractor:test',
  ownerVersion: '1.0.0',
  ...over,
})

const embedding = (key: string, arity: number, over: Partial<FeatureDescriptor> = {}): FeatureDescriptor =>
  scalar(key, { kind: 'embedding', arity, ...over })

describe('FeatureSchemaBuilder', () => {
  it('numbers scalars by registration order and counts columns', () => {
    const builder = new FeatureSchemaBuilder()
    builder.register(scalar('a'))
    builder.register(scalar('b'))
    const schema = builder.freeze()

    expect(schema.indexOf(featureKey('a'))).toBe(0)
    expect(schema.indexOf(featureKey('b'))).toBe(1)
    expect(schema.size).toBe(2)
    expect(schema.scalarCount).toBe(2)
  })

  it('counts every embedding dimension in size but not in scalarCount', () => {
    const builder = new FeatureSchemaBuilder()
    builder.register(scalar('a'))
    builder.register(embedding('emb', 128))
    const schema = builder.freeze()

    expect(schema.size).toBe(129)
    expect(schema.scalarCount).toBe(1)
    expect(schema.arityOf(featureKey('emb'))).toBe(128)
  })

  it('rejects a duplicate key, naming both owners', () => {
    const builder = new FeatureSchemaBuilder()
    builder.register(scalar('popularity', { owner: 'extractor:global' }))

    expect(() => builder.register(scalar('popularity', { owner: 'extractor:cohort' }))).toThrow(
      FeatureCollisionError,
    )
  })

  it('rejects arity > 1 on a non-embedding, so a typo cannot silently claim columns', () => {
    const builder = new FeatureSchemaBuilder()
    expect(() => builder.register(scalar('x', { arity: 4 }))).toThrow(RecoError)
  })

  it('rejects a non-finite defaultValue, since it is substituted on degrade', () => {
    const builder = new FeatureSchemaBuilder()
    expect(() => builder.register(scalar('x', { defaultValue: Number.NaN }))).toThrow(/NaN would poison/)
  })

  it('refuses registration after freeze', () => {
    const builder = new FeatureSchemaBuilder()
    builder.freeze()
    expect(() => builder.register(scalar('late'))).toThrow(RecoError)
  })

  it('says which feature is missing rather than returning undefined', () => {
    const schema = new FeatureSchemaBuilder().freeze()
    expect(() => schema.indexOf(featureKey('ghost'))).toThrow(/not declared/)
    expect(() => schema.descriptor(featureKey('ghost'))).toThrow(/not declared/)
    expect(schema.has(featureKey('ghost'))).toBe(false)
  })

  it('points embeddings at vector() instead of failing vaguely', () => {
    const builder = new FeatureSchemaBuilder()
    builder.register(embedding('emb', 8))
    const schema = builder.freeze()

    expect(() => schema.indexOf(featureKey('emb'))).toThrow(/vector\(\)/)
  })
})

describe('FeatureSchema.version', () => {
  const build = (descriptors: FeatureDescriptor[]) => {
    const builder = new FeatureSchemaBuilder()
    for (const d of descriptors) builder.register(d)
    return builder.freeze().version
  }

  it('ignores registration order: reordering use() must not drop the cache', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 6 }),
        (keys) => {
          const forward = build(keys.map((k) => scalar(k)))
          const backward = build([...keys].reverse().map((k) => scalar(k)))
          expect(backward).toBe(forward)
        },
      ),
    )
  })

  it('changes when a feature is added, so a stale matrix cannot come back from cache', () => {
    expect(build([scalar('a'), scalar('b')])).not.toBe(build([scalar('a')]))
  })

  it('changes when an extractor is rebumped, so its cached values are invalidated', () => {
    expect(build([scalar('a', { ownerVersion: '2.0.0' })])).not.toBe(
      build([scalar('a', { ownerVersion: '1.0.0' })]),
    )
  })

  it('changes when arity changes, since the matrix layout changes with it', () => {
    expect(build([embedding('e', 64)])).not.toBe(build([embedding('e', 128)]))
  })

  it('is stable across builds of the same schema', () => {
    expect(build([scalar('a'), embedding('e', 4)])).toBe(build([scalar('a'), embedding('e', 4)]))
  })
})
