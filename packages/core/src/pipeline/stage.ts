import type { DiagnosticWarning, StageTiming } from '../domain/recommendation.js'
import type { RequestContext } from '../ports/context.js'
import type { Clock } from '../ports/infra.js'
import type { StageInfo, StageMiddleware } from '../ports/middleware.js'

/**
 * The sixteen stages, in order. Fixed, and deliberately not extensible.
 *
 * Extension happens through ports, never by inserting a stage: a pipeline anyone can
 * splice into is a pipeline nobody can reason about, because the answer to "when does my
 * filter run" becomes "it depends who else is installed". The sequence is an argument
 * (§3), not a default — 2 before 3 because payload rules are cheap, 4b after 4 because
 * some safety rules need features, 6 apart from 5 so a strategy need not know its own
 * scale, 8 apart from 7 because fatigue multiplies rather than adds.
 */
export const STAGES = [
  'resolve',
  'retrieval',
  'prefilter',
  'extraction',
  'engineering',
  'postfilter',
  'scoring',
  'normalization',
  'combination',
  'modifiers',
  'ranking',
  'diversification',
  'blending',
  'truncate',
  'explanation',
  'assemble',
] as const

export type StageId = (typeof STAGES)[number]

const INDEX_OF: ReadonlyMap<StageId, number> = new Map(STAGES.map((id, index) => [id, index]))

export function stageInfo(id: StageId): StageInfo {
  return { id, index: INDEX_OF.get(id) as number }
}

/**
 * Collects everything the caller learns about how a request went.
 *
 * Mutable and request-scoped: one of these per `recommend()`, never shared. It is the
 * only mutable thing in the whole execution, and it exists because diagnostics are
 * inherently a record of what already happened.
 */
export class DiagnosticsCollector {
  private readonly timings: StageTiming[] = []
  private readonly warnings: DiagnosticWarning[] = []

  warn(warning: DiagnosticWarning): void {
    this.warnings.push(warning)
  }

  record(timing: StageTiming): void {
    this.timings.push(timing)
  }

  get stages(): readonly StageTiming[] {
    return this.timings
  }

  get collected(): readonly DiagnosticWarning[] {
    return this.warnings
  }
}

/** How many candidates a stage's output holds. Stages that do not move candidates say so. */
export type Sizer<T> = (value: T) => number

export interface StageRun<T> {
  readonly id: StageId
  readonly ctx: RequestContext
  readonly middleware: readonly StageMiddleware[]
  readonly diagnostics: DiagnosticsCollector
  readonly clock: Clock
  /** Candidates entering. Recorded even when the stage cannot change the count. */
  readonly inputSize: number
  readonly sizeOf: Sizer<T>
  run(): Promise<T>
}

/**
 * Runs one stage: checks cancellation, wraps it in middleware, times it, records it.
 *
 * The cancellation contract of §17.1 rule 1 lives here, and it is what makes the other
 * two rules survivable. The engine checks the signal at every stage boundary, so a port
 * that does nothing about cancellation still cannot delay it by more than one stage. That
 * is a free guarantee for every author who never read the contract — and there will be
 * such authors.
 *
 * An abort is not degradation. It propagates: no warning, no default value, no half a
 * feed dressed up as a real one. A cancelled request has no answer, and saying so is the
 * only honest thing to do.
 */
export async function runStage<T>(stage: StageRun<T>): Promise<T> {
  const { ctx, id, clock, diagnostics } = stage

  // Before the work, not after: the point is not to start what nobody is waiting for.
  ctx.signal.throwIfAborted()

  const info = stageInfo(id)
  const started = clock.now()

  // Onion: registration order is outermost-first, so the first middleware sees the whole
  // stage including every other middleware. Built by folding from the inside out.
  let invoke = stage.run
  for (let i = stage.middleware.length - 1; i >= 0; i--) {
    const layer = stage.middleware[i] as StageMiddleware
    const next = invoke
    invoke = () => layer.intercept(info, ctx, next)
  }

  try {
    const output = await invoke()
    diagnostics.record({
      id,
      ms: clock.now() - started,
      in: stage.inputSize,
      out: stage.sizeOf(output),
    })
    return output
  } catch (error) {
    // Timed even when it threw: "the request failed after 190ms of a 200ms budget" is a
    // different incident from "it failed in 2ms", and only the timing tells them apart.
    diagnostics.record({ id, ms: clock.now() - started, in: stage.inputSize, out: 0 })
    throw error
  }
}
