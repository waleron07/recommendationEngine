import type { DiagnosticWarning } from '../domain/recommendation.js'
import { RecoError } from '../kernel/errors.js'
import type { Criticality } from '../ports/context.js'
import type { Metrics } from '../ports/infra.js'
import type { DiagnosticsCollector, StageId } from './stage.js'

/**
 * An abort is never a port failure.
 *
 * Told apart by name rather than by `instanceof`: `throwIfAborted()` throws the platform's
 * `DOMException`, which does not exist as a type in an isomorphic core (§23.4), and the
 * host may substitute its own reason object anyway. The name is the stable part of the
 * contract everywhere the engine runs.
 */
export function isAbort(error: unknown): boolean {
  return (
    (error as { name?: unknown } | undefined)?.name === 'AbortError' ||
    (error as Error)?.name === 'TimeoutError'
  )
}

/** Rethrows cancellation untouched. Every catch in the pipeline starts with this. */
export function rethrowIfAborted(error: unknown): void {
  if (isAbort(error)) throw error
}

export interface PolicyContext {
  readonly stage: StageId
  readonly errorPolicy: 'strict' | 'degrade'
  readonly diagnostics: DiagnosticsCollector
  readonly metrics: Metrics | undefined
}

/**
 * Decides what a thrown port means, per the matrix of §17.2.
 *
 * The whole matrix reduces to one question — *can this be degraded into a value that is
 * still honest?* — and to one non-negotiable answer: never quietly. A `degrade` that does
 * not write a warning and count a metric is not resilience, it is a quality regression
 * with the alarm disconnected. So the counting happens here, in the engine, rather than
 * being left to whoever configured it.
 *
 * @returns true when the caller should carry on degraded; throws when it should not
 */
export function degradeOrThrow(
  policy: PolicyContext,
  port: { readonly id: string } & Criticality,
  error: unknown,
  message: string,
): boolean {
  rethrowIfAborted(error)

  // 'required' is the default, and it means the request dies here. An extractor whose
  // features silently became zeros is the invisible catastrophe: every score shifts and
  // nothing looks broken.
  const optional = port.criticality === 'optional'
  if (policy.errorPolicy === 'strict' || !optional) {
    throw new RecoError('PORT_FAILED', `${policy.stage}: ${message}`, { cause: error })
  }

  warn(policy, {
    stage: policy.stage,
    port: port.id,
    code: 'degraded',
    message,
    cause: error,
  })
  return true
}

/** Records a warning and counts it, because one without the other is half a signal. */
export function warn(policy: PolicyContext, warning: DiagnosticWarning): void {
  policy.diagnostics.warn(warning)
  policy.metrics?.count(`reco.${warning.code}`)
}

/**
 * Fail-closed accounting for filters (§17.2).
 *
 * A filter that throws removes the *candidate*, not the request: the safety invariant
 * ("what is not explicitly approved is not shown") holds either way, and dropping one
 * candidate keeps the other 4999. But fail-closed has a trap fail-open does not — a total
 * outage looks like emptiness rather than breakage. Drop them one at a time and a dead
 * licence service empties the feed: the user reads "no recommendations", operations reads
 * HTTP 200, and the incident surfaces a day later in a metric. An empty result is safe,
 * and it lies about why.
 *
 * Hence a budget rather than a binary: one failure degrades, a systematic one is called
 * what it is. It is the only way to get both properties at once.
 */
export class FilterErrorBudget {
  private failures = 0
  private readonly policy: PolicyContext
  private readonly total: number
  private readonly budget: number

  constructor(policy: PolicyContext, total: number, budget: number) {
    this.policy = policy
    this.total = total
    this.budget = budget
  }

  /** @returns false — always. A candidate whose verdict threw is never approved. */
  refuse(filterId: string, itemId: string, error: unknown): boolean {
    rethrowIfAborted(error)
    this.failures += 1

    warn(this.policy, {
      stage: this.policy.stage,
      port: filterId,
      code: 'port_failed',
      message: `"${filterId}" threw deciding "${itemId}"; the candidate was dropped, unapproved.`,
      cause: error,
    })

    if (this.total > 0 && this.failures / this.total > this.budget) {
      throw new RecoError(
        'PORT_FAILED',
        `Filters threw on ${this.failures} of ${this.total} candidates, over the ${this.budget} budget. ` +
          `That is not a flaky candidate, it is a broken dependency — and an empty feed would have ` +
          `reported it as success.`,
        { cause: error },
      )
    }
    return false
  }
}
