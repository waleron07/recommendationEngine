/**
 * Infrastructure ports. Everything the engine needs from the outside world that is not
 * data: time, randomness, logging, metrics, caching.
 *
 * They exist as ports rather than imports because `Date.now()` and `Math.random()` in
 * the middle of a pipeline make it untestable and non-reproducible. A golden test that
 * cannot pin the clock is not a golden test.
 */

import type { Timestamp } from '../domain/ids.js'

export interface Clock {
  now(): Timestamp
}

/**
 * Deterministic random source.
 *
 * `fork(seed)` is what makes exploration reproducible: the same user on the same day
 * gets the same "random" bucket, so an A/B test measures the variant rather than the
 * noise, and a bug report can be replayed.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  /** A new stream derived from this one and `seed`. Same seed, same stream. */
  fork(seed: string): Rng
}

export interface Logger {
  debug(message: string, data?: object): void
  warn(message: string, data?: object): void
}

export interface Metrics {
  timing(key: string, ms: number): void
  count(key: string, n?: number): void
}

/**
 * Feature cache. Keyed by the extractor, which owns the key format, and always includes
 * `schema.version` — a cached vector from a different schema is not a cache hit, it is
 * corruption.
 */
export interface FeatureCache {
  get(key: string): Float64Array | undefined
  set(key: string, value: Float64Array, ttlMs: number): void
}
