import { RecoError } from '../kernel/errors.js'
import type { FeatureSchema } from './feature.js'
import type { FeatureKey } from './ids.js'

/**
 * Features of the *user*, not of a candidate: taste centroid, session embedding,
 * profile saturation, a PageRank seed vector.
 *
 * This closes the asymmetry that made sequence models unwritable: a strategy could see
 * features of candidates but had no vector view of the history. With a profile vector,
 * "how well does this track follow the session" becomes cosine of two vectors — pure
 * arithmetic, no domain object in sight. See ARCHITECTURE.md §11.1.1.
 *
 * Profile and item features live in separate schemas, so `affinity_artist` can mean
 * "this item's artist" in one and "this user's artists" in the other without colliding.
 */
export interface ProfileVector {
  readonly schema: FeatureSchema
  get(key: FeatureKey): number
  vector(key: FeatureKey): Float64Array
}

/** Write side. Handed to `UserFeatureExtractor.extract()` and nowhere else. */
export interface MutableProfileVector extends ProfileVector {
  set(key: FeatureKey, value: number): void
  /** Copies in; the caller keeps ownership of `value`. */
  setVector(key: FeatureKey, value: Float64Array): void
}

/**
 * One row's worth of features. Laid out contiguously per feature, so `vector()` is a
 * view rather than a copy — the same reasoning as `DenseFeatureMatrix`, minus the
 * column/row tension, since there is only one row.
 */
export class DenseProfileVector implements MutableProfileVector {
  readonly schema: FeatureSchema

  private readonly data: Float64Array
  private readonly offsets = new Map<FeatureKey, number>()

  constructor(schema: FeatureSchema) {
    this.schema = schema

    let offset = 0
    for (const descriptor of schema.descriptors()) {
      this.offsets.set(descriptor.key, offset)
      offset += schema.arityOf(descriptor.key)
    }

    this.data = new Float64Array(offset)

    for (const descriptor of schema.descriptors()) {
      if (descriptor.defaultValue === 0) continue
      const base = this.offsets.get(descriptor.key) as number
      this.data.fill(descriptor.defaultValue, base, base + schema.arityOf(descriptor.key))
    }
  }

  get(key: FeatureKey): number {
    const base = this.offsetOf(key)
    if (this.schema.arityOf(key) !== 1) {
      throw new RecoError(
        'MISSING_FEATURE',
        `Cannot take get("${key}"): it is an embedding; read it with vector().`,
      )
    }
    return this.data[base] as number
  }

  set(key: FeatureKey, value: number): void {
    const base = this.offsetOf(key)
    if (this.schema.arityOf(key) !== 1) {
      throw new RecoError(
        'MISSING_FEATURE',
        `Cannot set("${key}"): it is an embedding; write it with setVector().`,
      )
    }
    this.data[base] = value
  }

  vector(key: FeatureKey): Float64Array {
    const base = this.offsetOf(key)
    return this.data.subarray(base, base + this.schema.arityOf(key))
  }

  setVector(key: FeatureKey, value: Float64Array): void {
    const arity = this.schema.arityOf(key)
    if (value.length !== arity) {
      throw new RecoError(
        'INVALID_CONFIG',
        `Feature "${key}" has arity ${arity} but was given a vector of length ${value.length}.`,
      )
    }
    this.data.set(value, this.offsetOf(key))
  }

  private offsetOf(key: FeatureKey): number {
    const base = this.offsets.get(key)
    if (base === undefined) {
      throw new RecoError('MISSING_FEATURE', `Feature "${key}" is not declared in this profile schema.`)
    }
    return base
  }
}
