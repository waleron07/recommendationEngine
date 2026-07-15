import type { RequestContext } from './context.js'

/** Which stage is running. `id` is stable; it is what timings and traces are keyed by. */
export interface StageInfo {
  /** `'retrieval'`, `'prefilter'`, `'scoring'`… */
  readonly id: string
  /** Position in the pipeline, 0..14. */
  readonly index: number
}

/**
 * Onion wrapper around any stage: telemetry, timing, caching, debugging.
 *
 * A plugin can wrap a stage without changing it, which is the point — cross-cutting
 * concerns are exactly what you cannot express by adding another port, because they
 * apply to all of them.
 *
 * The engine already times every stage into `Diagnostics`, so this is for what the engine
 * should not have an opinion about: your tracer, your cache, your debugger.
 */
export interface StageMiddleware {
  readonly id: string
  /**
   * Call `next()` exactly once and return its value.
   *
   * Not calling it skips the stage — occasionally useful (a cache hit), usually a bug.
   * Middleware runs in registration order, outermost first.
   */
  intercept<T>(stage: StageInfo, ctx: RequestContext, next: () => Promise<T>): Promise<T>
}
