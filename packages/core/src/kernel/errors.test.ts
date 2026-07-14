import { describe, expect, it } from 'vitest'
import { BuilderSealedError, FeatureCollisionError, MissingFeatureError, RecoError } from './errors.js'

describe('RecoError', () => {
  it('exposes a stable code so callers never match on message text', () => {
    const err = new RecoError('INVALID_CONFIG', 'limits.maxCandidates is required')
    expect(err.code).toBe('INVALID_CONFIG')
    expect(err).toBeInstanceOf(Error)
  })

  it('preserves the underlying cause instead of swallowing it', () => {
    const cause = new Error('connection refused')
    const err = new RecoError('PORT_FAILED', 'provider "library" failed', { cause })
    expect(err.cause).toBe(cause)
  })
})

describe('build-time errors', () => {
  it('MissingFeatureError names both the feature and who required it', () => {
    const err = new MissingFeatureError('affinity_artist', 'strategy:artist')
    expect(err.code).toBe('MISSING_FEATURE')
    expect(err.message).toContain('affinity_artist')
    expect(err.message).toContain('strategy:artist')
  })

  it('FeatureCollisionError names both owners', () => {
    const err = new FeatureCollisionError('popularity', 'extractor:global', 'extractor:cohort')
    expect(err.code).toBe('FEATURE_COLLISION')
    expect(err.message).toContain('extractor:global')
    expect(err.message).toContain('extractor:cohort')
  })

  it('BuilderSealedError names the rejected operation', () => {
    const err = new BuilderSealedError('use')
    expect(err.code).toBe('BUILDER_SEALED')
    expect(err.message).toContain('use')
  })

  it('every build-time error is a RecoError, so one catch handles the class', () => {
    const errors = [
      new MissingFeatureError('f', 'o'),
      new FeatureCollisionError('f', 'a', 'b'),
      new BuilderSealedError('op'),
    ]
    for (const err of errors) {
      expect(err).toBeInstanceOf(RecoError)
      expect(err.name).not.toBe('RecoError')
    }
  })
})
