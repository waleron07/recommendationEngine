import type { FeatureDescriptor } from '../domain/feature.js'
import type { FeatureKey } from '../domain/ids.js'
import type { FeatureMatrix } from '../domain/matrix.js'
import type { RequestContext } from './context.js'

/**
 * Stage 4. Pure maths over the matrix: scale, log1p, bucketize, cross, impute, decay.
 *
 * No `criticality`: a transform reads features and writes features, so its failure
 * breaks the chain everything downstream reads. There is no meaningful degraded value
 * for "the log of a number we never computed".
 *
 * `apply` is synchronous for the same reason `score` is (§23.2): the moment it could
 * await, someone fetches a scaling factor from Redis inside it, and the I/O →
 * extraction → maths separation the whole pipeline rests on is gone. The signature makes
 * the violation impossible rather than merely discouraged.
 */
export interface FeatureTransform {
  readonly id: string
  readonly version: string
  /** Inputs. Together with `provides` this is what orders the transforms at `build()`. */
  readonly requires: readonly FeatureKey[]
  readonly provides: readonly FeatureDescriptor[]
  apply(matrix: FeatureMatrix, ctx: RequestContext): void
}
