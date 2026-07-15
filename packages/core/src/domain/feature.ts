import { FeatureCollisionError, RecoError } from '../kernel/errors.js'
import type { Brand } from './brand.js'
import type { FeatureKey } from './ids.js'

/**
 * `categorical` holds a hash of a category rather than the category itself. Hashing
 * preserves equality, which is the only operation quotas need, and keeps the value a
 * number so it can live in the matrix alongside everything else.
 *
 * `embedding` is the `arity > 1` case: 128 dimensions of one vector, not 128 features.
 */
export type FeatureKind = 'numeric' | 'binary' | 'ordinal' | 'categorical' | 'embedding'

export interface FeatureDescriptor {
  readonly key: FeatureKey
  readonly kind: FeatureKind
  /** Columns this feature occupies. Defaults to 1. Only `embedding` may exceed it. */
  readonly arity?: number
  /**
   * Substituted when an `optional` extractor fails under the degrade policy.
   *
   * This is the feature's degradation policy, not decoration: the author decides what
   * absence means. For `popularity` that is 0; for `item_age_days` it is the median,
   * because 0 would silently declare every item brand new.
   */
  readonly defaultValue: number
  readonly range?: readonly [min: number, max: number]
  readonly description: string
  /** Extractor id. Surfaces in collision errors and in the schema version. */
  readonly owner: string
  /** Extractor version. Changing it invalidates cached features for this key. */
  readonly ownerVersion: string
}

/** Hash of the whole schema. Part of every feature cache key. */
export type FeatureSchemaVersion = Brand<string, 'FeatureSchemaVersion'>

/**
 * Write side of the schema. Handed to plugins during `register()` and nowhere else.
 */
export interface MutableFeatureSchema {
  register(descriptor: FeatureDescriptor): void
}

/**
 * Read side of the schema, produced by `build()`.
 *
 * There is deliberately no `register` here. A plugin cannot mutate the schema after
 * the engine is built because it holds no object that could: the mutable and frozen
 * schemas are different types, so `register → recommend → register` is a compile
 * error rather than a corrupted matrix at runtime.
 */
export interface FeatureSchema {
  /** Total columns, counting each embedding dimension. */
  readonly size: number
  /** Number of scalar (arity 1) features. */
  readonly scalarCount: number
  readonly version: FeatureSchemaVersion
  has(key: FeatureKey): boolean
  descriptor(key: FeatureKey): FeatureDescriptor
  descriptors(): readonly FeatureDescriptor[]
  /** Column index of a scalar feature. Throws for embeddings — use `arityOf`. */
  indexOf(key: FeatureKey): number
  arityOf(key: FeatureKey): number
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a. Small, dependency-free, and adequate: this is a cache key, not a signature. */
function fnv1a(input: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function arityOf(descriptor: FeatureDescriptor): number {
  return descriptor.arity ?? 1
}

/**
 * Collects descriptors during registration, then freezes into a `FeatureSchema`.
 *
 * Scalars and embeddings are numbered separately because the matrix stores them in
 * different layouts — see `matrix.ts` for why.
 */
export class FeatureSchemaBuilder implements MutableFeatureSchema {
  private readonly descriptors = new Map<FeatureKey, FeatureDescriptor>()
  private readonly scalarIndex = new Map<FeatureKey, number>()
  private scalars = 0
  private columns = 0
  private frozen = false

  register(descriptor: FeatureDescriptor): void {
    if (this.frozen) {
      throw new RecoError(
        'BUILDER_SEALED',
        `Cannot register "${descriptor.key}" after the schema was frozen.`,
      )
    }

    const existing = this.descriptors.get(descriptor.key)
    if (existing !== undefined) {
      throw new FeatureCollisionError(descriptor.key, existing.owner, descriptor.owner)
    }

    const arity = arityOf(descriptor)
    if (!Number.isInteger(arity) || arity < 1) {
      throw new RecoError(
        'INVALID_CONFIG',
        `Feature "${descriptor.key}" has arity ${arity}; expected a positive integer.`,
      )
    }
    if (arity > 1 && descriptor.kind !== 'embedding') {
      throw new RecoError(
        'INVALID_CONFIG',
        `Feature "${descriptor.key}" has arity ${arity} but kind "${descriptor.kind}". ` +
          `Only "embedding" may span multiple columns.`,
      )
    }
    if (!Number.isFinite(descriptor.defaultValue)) {
      throw new RecoError(
        'INVALID_CONFIG',
        `Feature "${descriptor.key}" has a non-finite defaultValue. It is substituted on degraded ` +
          `extraction, so NaN would poison every score that reads it.`,
      )
    }

    this.descriptors.set(descriptor.key, descriptor)
    if (arity === 1) {
      this.scalarIndex.set(descriptor.key, this.scalars)
      this.scalars += 1
    }
    this.columns += arity
  }

  freeze(): FeatureSchema {
    this.frozen = true
    const descriptors = [...this.descriptors.values()]

    // Sorted so the version depends on the set of features, not on plugin registration
    // order. Two engines with the same features share a cache; a reordered `use()` chain
    // must not invalidate it.
    const fingerprint = [...this.descriptors.values()]
      .map((d) => `${d.key}:${d.kind}:${arityOf(d)}:${d.owner}@${d.ownerVersion}`)
      .sort()
      .join('|')

    const version = `fs_${fnv1a(fingerprint)}` as FeatureSchemaVersion
    const { descriptors: byKey, scalarIndex } = this
    const size = this.columns
    const scalarCount = this.scalars

    return {
      size,
      scalarCount,
      version,
      has: (key) => byKey.has(key),
      descriptor: (key) => {
        const found = byKey.get(key)
        if (found === undefined) {
          throw new RecoError('MISSING_FEATURE', `Feature "${key}" is not declared in this schema.`)
        }
        return found
      },
      descriptors: () => descriptors,
      indexOf: (key) => {
        const index = scalarIndex.get(key)
        if (index === undefined) {
          const reason = byKey.has(key)
            ? `it is an embedding (arity ${arityOf(byKey.get(key) as FeatureDescriptor)}); read it with vector()`
            : 'it is not declared in this schema'
          throw new RecoError('MISSING_FEATURE', `Cannot take indexOf("${key}"): ${reason}.`)
        }
        return index
      },
      arityOf: (key) => {
        const found = byKey.get(key)
        if (found === undefined) {
          throw new RecoError('MISSING_FEATURE', `Feature "${key}" is not declared in this schema.`)
        }
        return arityOf(found)
      },
    }
  }
}
