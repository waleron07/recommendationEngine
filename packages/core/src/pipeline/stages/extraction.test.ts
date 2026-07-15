import { describe, expect, it } from 'vitest'
import { type CandidateSet, CandidateSetBuilder } from '../../domain/candidate.js'
import { type FeatureDescriptor, type FeatureSchema, FeatureSchemaBuilder } from '../../domain/feature.js'
import { featureKey, itemId } from '../../domain/ids.js'
import type { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { FeatureExtractor, UserFeatureExtractor } from '../../ports/feature-extractor.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { extract } from './extraction.js'

const descriptor = (key: string, owner: string, defaultValue = 0, arity?: number): FeatureDescriptor => ({
  key: featureKey(key),
  kind: arity === undefined ? 'numeric' : 'embedding',
  ...(arity === undefined ? {} : { arity }),
  defaultValue,
  description: key,
  owner,
  ownerVersion: '1.0.0',
})

const schemaOf = (...descriptors: FeatureDescriptor[]): FeatureSchema => {
  const builder = new FeatureSchemaBuilder()
  for (const d of descriptors) builder.register(d)
  return builder.freeze()
}

const setOf = (...ids: string[]): CandidateSet => {
  const builder = new CandidateSetBuilder()
  builder.add(
    'library',
    ids.map((id) => ({ id: itemId(id), type: 'track', payload: {} })),
  )
  return builder.build()
}

const ctx = {} as RequestContext

const policyWith = (errorPolicy: 'strict' | 'degrade' = 'strict'): PolicyContext => ({
  stage: 'extraction',
  errorPolicy,
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

const writing = (id: string, key: string, value: number, defaultValue = 0): FeatureExtractor => ({
  id,
  version: '1.0.0',
  provides: [descriptor(key, id, defaultValue)],
  extract: async (_set, out) => {
    out.columnMut(featureKey(key)).fill(value)
  },
})

const broken = (
  id: string,
  key: string,
  defaultValue = 0,
  criticality?: 'required' | 'optional',
): FeatureExtractor => ({
  id,
  version: '1.0.0',
  ...(criticality === undefined ? {} : { criticality }),
  provides: [descriptor(key, id, defaultValue)],
  extract: async () => {
    throw new Error(`${id} is down`)
  },
})

const userWriting = (id: string, key: string, value: number): UserFeatureExtractor => ({
  id,
  version: '1.0.0',
  scope: 'user',
  provides: [descriptor(key, id)],
  extract: async (out) => out.set(featureKey(key), value),
})

const failure = async (fn: () => Promise<unknown>): Promise<RecoError> => {
  try {
    await fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('extraction', () => {
  it('gives every extractor its own columns to write', () => {
    // Safe by construction, not by lock: build() proved no two extractors declare one key,
    // so concurrent writers never touch the same cell.
    return expect(
      extract(
        setOf('a', 'b'),
        ctx,
        schemaOf(descriptor('affinity_artist', 'artist'), descriptor('popularity', 'pop')),
        schemaOf(),
        [writing('artist', 'affinity_artist', 0.9), writing('pop', 'popularity', 42)],
        [],
        policyWith(),
      ).then((extracted) => ({
        artist: [...extracted.matrix.column(featureKey('affinity_artist'))],
        popularity: [...extracted.matrix.column(featureKey('popularity'))],
      })),
    ).resolves.toEqual({ artist: [0.9, 0.9], popularity: [42, 42] })
  })

  it('fills the profile from user extractors', async () => {
    const extracted = await extract(
      setOf('a'),
      ctx,
      schemaOf(),
      schemaOf(descriptor('taste_centroid', 'taste')),
      [],
      [userWriting('taste', 'taste_centroid', 0.7)],
      policyWith(),
    )

    expect(extracted.profile.get(featureKey('taste_centroid'))).toBe(0.7)
  })

  it('handles an engine with no extractors at all', async () => {
    const extracted = await extract(setOf(), ctx, schemaOf(), schemaOf(), [], [], policyWith())

    expect(extracted.matrix.rows).toBe(0)
    expect(extracted.degradedProfile.size).toBe(0)
  })
})

describe('when an extractor fails (§17.2)', () => {
  it('fails the request for a required extractor, under either policy', async () => {
    for (const errorPolicy of ['strict', 'degrade'] as const) {
      const error = await failure(() =>
        extract(
          setOf('a'),
          ctx,
          schemaOf(descriptor('affinity_artist', 'artist')),
          schemaOf(),
          [broken('artist', 'affinity_artist')],
          [],
          policyWith(errorPolicy),
        ),
      )
      expect(error.code).toBe('PORT_FAILED')
    }
  })

  it('fails an optional extractor under strict — that is what dev and CI are for', async () => {
    const error = await failure(() =>
      extract(
        setOf('a'),
        ctx,
        schemaOf(descriptor('affinity_artist', 'artist')),
        schemaOf(),
        [broken('artist', 'affinity_artist', 0, 'optional')],
        [],
        policyWith('strict'),
      ),
    )
    expect(error.code).toBe('PORT_FAILED')
  })

  it('substitutes the feature default, which is where defaultValue finally earns its place', async () => {
    // 0 would silently declare every item brand new and hand the catalogue to recency.
    // The author of the feature says what its absence means; here, the median.
    const extracted = await extract(
      setOf('a', 'b'),
      ctx,
      schemaOf(descriptor('item_age_days', 'age', 365)),
      schemaOf(),
      [broken('age', 'item_age_days', 365, 'optional')],
      [],
      policyWith('degrade'),
    )

    expect([...extracted.matrix.column(featureKey('item_age_days'))]).toEqual([365, 365])
  })

  it('names the feature that went to default, not just the extractor', async () => {
    // "affinity_artist is a default" is actionable; "the artist extractor degraded" leaves
    // you guessing which scores moved.
    const policy = policyWith('degrade')
    await extract(
      setOf('a'),
      ctx,
      schemaOf(descriptor('affinity_artist', 'artist')),
      schemaOf(),
      [broken('artist', 'affinity_artist', 0, 'optional')],
      [],
      policy,
    )

    const codes = policy.diagnostics.collected.map((w) => w.code)
    expect(codes).toEqual(['degraded', 'schema_default'])
    expect(policy.diagnostics.collected[1]?.message).toContain('affinity_artist')
  })

  it('defaults an embedding across every row', async () => {
    const embedding: FeatureExtractor = {
      id: 'vec',
      version: '1.0.0',
      criticality: 'optional',
      provides: [descriptor('session_vector', 'vec', 0.5, 3)],
      extract: async () => {
        throw new Error('vec is down')
      },
    }

    const extracted = await extract(
      setOf('a', 'b'),
      ctx,
      schemaOf(descriptor('session_vector', 'vec', 0.5, 3)),
      schemaOf(),
      [embedding],
      [],
      policyWith('degrade'),
    )

    expect([...extracted.matrix.vector(featureKey('session_vector'), 1)]).toEqual([0.5, 0.5, 0.5])
  })

  it('leaves the surviving extractors intact when one degrades', async () => {
    const extracted = await extract(
      setOf('a'),
      ctx,
      schemaOf(descriptor('affinity_artist', 'artist'), descriptor('popularity', 'pop')),
      schemaOf(),
      [broken('artist', 'affinity_artist', 0, 'optional'), writing('pop', 'popularity', 42)],
      [],
      policyWith('degrade'),
    )

    expect(extracted.matrix.get(featureKey('popularity'), 0)).toBe(42)
  })
})

describe('when a user extractor fails', () => {
  const brokenUser = (id: string, key: string): UserFeatureExtractor => ({
    id,
    version: '1.0.0',
    scope: 'user',
    criticality: 'optional',
    provides: [descriptor(key, id)],
    extract: async () => {
      throw new Error(`${id} is down`)
    },
  })

  it('reports the profile feature as degraded rather than substituting zeros', async () => {
    // A centroid of zeros is not a degraded taste vector, it is a wrong one. Strategies
    // that require it stand down instead.
    const extracted = await extract(
      setOf('a'),
      ctx,
      schemaOf(),
      schemaOf(descriptor('taste_centroid', 'taste')),
      [],
      [brokenUser('taste', 'taste_centroid')],
      policyWith('degrade'),
    )

    expect([...extracted.degradedProfile]).toEqual(['taste_centroid'])
  })

  it('fails the request when the user extractor is required', async () => {
    const required: UserFeatureExtractor = {
      id: 'taste',
      version: '1.0.0',
      scope: 'user',
      provides: [descriptor('taste_centroid', 'taste')],
      extract: async () => {
        throw new Error('down')
      },
    }

    const error = await failure(() =>
      extract(
        setOf('a'),
        ctx,
        schemaOf(),
        schemaOf(descriptor('taste_centroid', 'taste')),
        [],
        [required],
        policyWith('degrade'),
      ),
    )
    expect(error.code).toBe('PORT_FAILED')
  })
})
