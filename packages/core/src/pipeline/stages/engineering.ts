import type { FeatureMatrix } from '../../domain/matrix.js'
import { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { FeatureTransform } from '../../ports/feature-transform.js'
import type { PolicyContext } from '../policy.js'
import { rethrowIfAborted } from '../policy.js'

/**
 * Stage 4. Pure maths over the matrix: scale, log1p, bucketize, cross, impute, decay.
 *
 * Sequential, and it has to be: the transforms arrive topologically sorted from `build()`,
 * so `scale` runs after the `log1p` whose output it reads. Running them concurrently would
 * throw that ordering away — the one thing the graph validation exists to establish.
 *
 * No degradation is possible here under either policy. A transform reads features and
 * writes features, so its failure breaks the chain everything downstream reads, and there
 * is no honest default for "the logarithm of a number we never computed". `criticality`
 * is deliberately absent from the port for the same reason.
 */
export function engineer(
  matrix: FeatureMatrix,
  ctx: RequestContext,
  transforms: readonly FeatureTransform[],
  policy: PolicyContext,
): void {
  for (const transform of transforms) {
    // Checked between transforms, not only at the stage boundary: a chain of six over
    // 5000 rows is exactly the CPU-bound stretch where an abort would otherwise wait.
    ctx.signal.throwIfAborted()

    try {
      transform.apply(matrix, ctx)
    } catch (error) {
      rethrowIfAborted(error)
      throw new RecoError(
        'PORT_FAILED',
        `${policy.stage}: transform "${transform.id}" failed. Transforms cannot degrade — everything ` +
          `downstream reads what this one was supposed to write.`,
        { cause: error },
      )
    }
  }
}
