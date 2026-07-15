import { RecoError } from '../kernel/errors.js'
import type { FeatureSchema } from './feature.js'
import type { FeatureKey } from './ids.js'

/**
 * Feature values for every candidate in a request.
 *
 * ## Layout
 *
 * Two blocks, because the two access patterns genuinely conflict and no single layout
 * serves both:
 *
 * - **Scalars: column-major.** `MinMaxNormalizer` walks one feature across all rows.
 *   Column-major makes that a contiguous scan; array-of-objects would be a pointer
 *   chase over 10k objects, once per feature.
 *
 * - **Embeddings: row-major, per feature.** Cosine similarity walks all 128 dimensions
 *   of one row. Under column-major those 128 values sit `rows` apart, so every read is
 *   a cache miss and `vector()` could only return a copy.
 *
 * ARCHITECTURE.md §5.5 called for column-major throughout; it did not notice the
 * conflict. Splitting by arity keeps both operations contiguous, and the schema already
 * knows which block a feature belongs to, so callers never see the seam.
 */
export interface FeatureMatrix {
  readonly rows: number
  readonly schema: FeatureSchema
  /** Scalar read. Throws for embeddings. */
  get(key: FeatureKey, row: number): number
  /** The whole column, length `rows`. Read-only view; no copy. */
  column(key: FeatureKey): Float64Array
  /** One row of an embedding, length `arity`. Contiguous view; no copy. */
  vector(key: FeatureKey, row: number): Float64Array
  /** Writable column. Extraction and transforms only. */
  columnMut(key: FeatureKey): Float64Array
  /** Writable embedding row. Extraction and transforms only. */
  vectorMut(key: FeatureKey, row: number): Float64Array
}

export class DenseFeatureMatrix implements FeatureMatrix {
  readonly rows: number
  readonly schema: FeatureSchema

  /** Column-major: `scalars[column * rows + row]`. */
  private readonly scalars: Float64Array
  /** Row-major per feature: `embeddings[base + row * arity + dim]`. */
  private readonly embeddings: Float64Array
  private readonly embeddingBase = new Map<FeatureKey, number>()

  constructor(schema: FeatureSchema, rows: number) {
    if (!Number.isInteger(rows) || rows < 0) {
      throw new RecoError(
        'INVALID_CONFIG',
        `FeatureMatrix needs a non-negative integer row count, got ${rows}.`,
      )
    }
    this.schema = schema
    this.rows = rows

    let embeddingSize = 0
    for (const descriptor of schema.descriptors()) {
      const arity = schema.arityOf(descriptor.key)
      if (arity > 1) {
        this.embeddingBase.set(descriptor.key, embeddingSize)
        embeddingSize += rows * arity
      }
    }

    this.scalars = new Float64Array(schema.scalarCount * rows)
    this.embeddings = new Float64Array(embeddingSize)

    // Zero is not a neutral default: an absent `item_age_days` of 0 means "brand new".
    // Each descriptor states what its own absence means, so seed from that.
    for (const descriptor of schema.descriptors()) {
      if (descriptor.defaultValue === 0) continue
      const arity = schema.arityOf(descriptor.key)
      if (arity === 1) {
        this.columnMut(descriptor.key).fill(descriptor.defaultValue)
      } else {
        const base = this.embeddingBase.get(descriptor.key) as number
        this.embeddings.fill(descriptor.defaultValue, base, base + rows * arity)
      }
    }
  }

  get(key: FeatureKey, row: number): number {
    this.assertRow(row)
    const index = this.schema.indexOf(key)
    return this.scalars[index * this.rows + row] as number
  }

  column(key: FeatureKey): Float64Array {
    const index = this.schema.indexOf(key)
    return this.scalars.subarray(index * this.rows, (index + 1) * this.rows)
  }

  columnMut(key: FeatureKey): Float64Array {
    return this.column(key)
  }

  vector(key: FeatureKey, row: number): Float64Array {
    this.assertRow(row)
    const base = this.embeddingBase.get(key)
    if (base === undefined) {
      const reason = this.schema.has(key)
        ? 'it is a scalar (arity 1); read it with get() or column()'
        : 'it is not declared in this schema'
      throw new RecoError('MISSING_FEATURE', `Cannot take vector("${key}"): ${reason}.`)
    }
    const arity = this.schema.arityOf(key)
    const start = base + row * arity
    return this.embeddings.subarray(start, start + arity)
  }

  vectorMut(key: FeatureKey, row: number): Float64Array {
    return this.vector(key, row)
  }

  private assertRow(row: number): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.rows) {
      throw new RecoError('INVALID_CONFIG', `Row ${row} is out of range for a matrix with ${this.rows} rows.`)
    }
  }
}
