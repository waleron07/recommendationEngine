import type { Item } from './entities.js'
import type { Explanation } from './explanation.js'

/** One recommended item, with the record of why it is here. */
export interface Recommendation<P = unknown> {
  readonly item: Item<P>
  /** 1-based: this is what a human reads, and position 0 is not a thing anyone says. */
  readonly rank: number
  /** Presentation scale (0..100), not the internal [0..1]. */
  readonly score: number
  readonly explanation: Explanation
}

/**
 * The answer, and how it was arrived at.
 *
 * `diagnostics` is a sibling of the recommendations rather than a log line, because the
 * two questions "what should I show" and "did anything degrade while deciding" are asked
 * by the same caller and answered by the same call. A warning that only reaches stdout is
 * a warning nobody acts on.
 */
export interface RecommendationResult<P = unknown> {
  readonly recommendations: readonly Recommendation<P>[]
  readonly diagnostics: Diagnostics
}

/**
 * Structured warning. Part of the answer, not a line in a log file.
 *
 * It lives here rather than beside `DiagnosticsSink` because it is what the *caller*
 * receives: the sink is how a port writes one, and `Diagnostics` is where it ends up.
 * Defining it next to the writer would point the dependency backwards — domain would
 * have to import a port to describe its own result.
 */
export interface DiagnosticWarning {
  readonly stage: string
  readonly port: string
  readonly code: 'port_failed' | 'not_applicable' | 'degraded' | 'quota_unfilled' | 'schema_default'
  readonly message: string
  readonly cause?: unknown
}

/** What one stage cost and what passed through it. */
export interface StageTiming {
  readonly id: string
  readonly ms: number
  /** Candidates entering the stage. */
  readonly in: number
  /** Candidates leaving it. A filter that empties the set is visible right here. */
  readonly out: number
}

/**
 * Where the time went and what went wrong, per request.
 *
 * `warnings` is structured (`DiagnosticWarning`), not prose: degradation without a metric
 * is a slow quality regression that nobody notices, so the engine also counts
 * `reco.degraded` itself rather than trusting every operator to grep for it.
 */
export interface Diagnostics {
  readonly totalMs: number
  readonly stages: readonly StageTiming[]
  readonly retrieved: number
  readonly filtered: number
  readonly warnings: readonly DiagnosticWarning[]
}
