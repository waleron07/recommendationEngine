import { describe, expect, it } from 'vitest'
import type { FeatureDescriptor } from '../domain/feature.js'
import { featureKey, strategyId } from '../domain/ids.js'
import type { PostFilter } from '../ports/candidate-filter.js'
import type { FeatureExtractor, UserFeatureExtractor } from '../ports/feature-extractor.js'
import type { FeatureTransform } from '../ports/feature-transform.js'
import type { ScoringStrategy } from '../ports/scoring-strategy.js'
import type { RecoError } from './errors.js'
import { type FeatureGraphInput, resolveFeatureGraph } from './graph.js'

const descriptor = (key: string, owner: string): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: key,
  owner,
  ownerVersion: '1.0.0',
})

const extractor = (id: string, provides: string[]): FeatureExtractor => ({
  id,
  version: '1.0.0',
  provides: provides.map((key) => descriptor(key, id)),
  extract: async () => {},
})

const userExtractor = (id: string, provides: string[]): UserFeatureExtractor => ({
  id,
  version: '1.0.0',
  scope: 'user',
  provides: provides.map((key) => descriptor(key, id)),
  extract: async () => {},
})

const transform = (id: string, requires: string[], provides: string[]): FeatureTransform => ({
  id,
  version: '1.0.0',
  requires: requires.map(featureKey),
  provides: provides.map((key) => descriptor(key, id)),
  apply: () => {},
})

const strategy = (id: string, requires: string[] = [], requiresProfile?: string[]): ScoringStrategy => ({
  id: strategyId(id),
  requires: requires.map(featureKey),
  ...(requiresProfile === undefined ? {} : { requiresProfile: requiresProfile.map(featureKey) }),
  score: () => ({ strategyId: strategyId(id), raw: new Float64Array(0), reasons: new Map() }),
})

const postFilter = (id: string, requires: string[]): PostFilter => ({
  id,
  failClosed: true,
  requires: requires.map(featureKey),
  approve: () => true,
})

const graph = (input: Partial<FeatureGraphInput>): readonly FeatureTransform[] =>
  resolveFeatureGraph({
    extractors: [],
    userExtractors: [],
    transforms: [],
    strategies: [],
    postFilters: [],
    ...input,
  })

const failure = (input: Partial<FeatureGraphInput>): RecoError => {
  try {
    graph(input)
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected resolveFeatureGraph() to throw, got none')
}

describe('missing features — the point of the whole stage', () => {
  it('refuses to start when a strategy requires a feature nobody provides', () => {
    // Without this the key reads as undefined, becomes NaN in the first arithmetic, and
    // NaN takes the whole ranking with it. Nothing throws and the tests pass.
    const error = failure({ strategies: [strategy('artist', ['affinity_artist'])] })

    expect(error.code).toBe('MISSING_FEATURE')
    expect(error.message).toContain('affinity_artist')
    expect(error.message).toContain('artist')
  })

  it('accepts a strategy whose feature an extractor provides', () => {
    expect(() =>
      graph({
        extractors: [extractor('artist-extractor', ['affinity_artist'])],
        strategies: [strategy('artist', ['affinity_artist'])],
      }),
    ).not.toThrow()
  })

  it('accepts a strategy whose feature a transform produces', () => {
    expect(() =>
      graph({
        extractors: [extractor('pop', ['popularity'])],
        transforms: [transform('log1p', ['popularity'], ['popularity_log'])],
        strategies: [strategy('popularity', ['popularity_log'])],
      }),
    ).not.toThrow()
  })

  it('names the post-filter that requires a feature nobody provides', () => {
    const error = failure({ postFilters: [postFilter('licence', ['licence_ok'])] })

    expect(error.code).toBe('MISSING_FEATURE')
    expect(error.message).toContain('licence')
  })
})

describe('profile features live in their own space', () => {
  it('satisfies requiresProfile from a UserFeatureExtractor', () => {
    expect(() =>
      graph({
        userExtractors: [userExtractor('taste', ['taste_centroid'])],
        strategies: [strategy('history', [], ['taste_centroid'])],
      }),
    ).not.toThrow()
  })

  it('refuses an item feature standing in for a profile feature of the same name', () => {
    // `affinity_genre` as an item feature means "how well this track fits the user";
    // as a profile feature it means "how much of the user's taste is this genre".
    // One namespace would call these a collision; two mean the engine can tell them apart.
    const error = failure({
      extractors: [extractor('genre', ['affinity_genre'])],
      strategies: [strategy('genre', [], ['affinity_genre'])],
    })

    expect(error.code).toBe('MISSING_FEATURE')
    expect(error.message).toMatch(/own schema/i)
  })

  it('lets one key name both an item feature and a profile feature', () => {
    expect(() =>
      graph({
        extractors: [extractor('item-genre', ['affinity_genre'])],
        userExtractors: [userExtractor('profile-genre', ['affinity_genre'])],
        strategies: [strategy('genre', ['affinity_genre'], ['affinity_genre'])],
      }),
    ).not.toThrow()
  })
})

describe('transform ordering', () => {
  it('derives the order from requires/provides rather than from registration', () => {
    // Registered backwards on purpose: keeping a chain of six transforms in the right
    // order by hand is a rule that holds until the first merge conflict.
    const sorted = graph({
      extractors: [extractor('pop', ['popularity'])],
      transforms: [
        transform('scale', ['popularity_log'], ['popularity_scaled']),
        transform('log1p', ['popularity'], ['popularity_log']),
      ],
    })

    expect(sorted.map((t) => t.id)).toEqual(['log1p', 'scale'])
  })

  it('imposes no ordering for an extractor-provided input — extractors all run first', () => {
    const sorted = graph({
      extractors: [extractor('pop', ['popularity']), extractor('age', ['item_age'])],
      transforms: [
        transform('b', ['item_age'], ['item_age_log']),
        transform('a', ['popularity'], ['popularity_log']),
      ],
    })

    expect(sorted.map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('reports a cycle between transforms as a cycle', () => {
    const error = failure({
      transforms: [transform('a', ['b_out'], ['a_out']), transform('b', ['a_out'], ['b_out'])],
    })

    expect(error.code).toBe('DEPENDENCY_CYCLE')
    expect(error.message).toMatch(/a → b → a|b → a → b/)
  })

  it('catches a transform that reads what it writes', () => {
    expect(failure({ transforms: [transform('impute', ['age'], ['age'])] }).code).toBe('DEPENDENCY_CYCLE')
  })

  it('names the transform whose input nobody produces', () => {
    const error = failure({ transforms: [transform('log1p', ['popularity'], ['popularity_log'])] })

    expect(error.code).toBe('MISSING_FEATURE')
    expect(error.message).toContain('log1p')
  })

  it('orders a diamond so every transform follows both of its inputs', () => {
    const sorted = graph({
      extractors: [extractor('src', ['raw'])],
      transforms: [
        transform('merge', ['left', 'right'], ['merged']),
        transform('right', ['raw'], ['right']),
        transform('left', ['raw'], ['left']),
      ],
    })

    const order = sorted.map((t) => t.id)
    expect(order.indexOf('merge')).toBeGreaterThan(order.indexOf('left'))
    expect(order.indexOf('merge')).toBeGreaterThan(order.indexOf('right'))
  })

  it('returns an empty order for an engine with no transforms', () => {
    expect(graph({})).toEqual([])
  })
})
