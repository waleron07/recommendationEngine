import type { CandidateSet } from '../domain/candidate.js'
import type { Recommendation, RecommendationResult } from '../domain/recommendation.js'
import { defaultExplainer, fillSlot, sortRanker, weightedSum } from '../engine/defaults.js'
import type { EngineBlueprint } from '../kernel/builder.js'
import type { RequestContext } from '../ports/context.js'
import type { Clock, Logger, Metrics, Rng } from '../ports/infra.js'
import type { ScoreNormalizer } from '../ports/score-normalizer.js'
import type { ScoringView } from '../ports/scoring-strategy.js'
import type { PolicyContext } from './policy.js'
import { type RecommendationRequest, resolveRequest } from './request.js'
import { DiagnosticsCollector, runStage, type StageId } from './stage.js'
import { combine, modify } from './stages/combination.js'
import { engineer } from './stages/engineering.js'
import { explain } from './stages/explanation.js'
import { extract } from './stages/extraction.js'
import { normalize } from './stages/normalization.js'
import { postfilter } from './stages/postfilter.js'
import { prefilter } from './stages/prefilter.js'
import { blend, diversify, rank, truncate } from './stages/ranking.js'
import { retrieve } from './stages/retrieval.js'
import { score } from './stages/scoring.js'

export interface PipelineDeps {
  readonly clock: Clock
  readonly rng: Rng
  readonly logger: Logger
  readonly metrics: Metrics | undefined
  readonly normalizers: ReadonlyMap<string, ScoreNormalizer>
}

/**
 * One request, sixteen stages, in the order §3 argues for.
 *
 * Straight-line code rather than a list of stage objects, and that is the design: the
 * sequence is fixed. A pipeline anyone can splice into is a pipeline nobody can reason
 * about, because "when does my filter run" becomes "it depends who else is installed".
 * Extension goes through ports, which is why every line below reads as prose — this
 * function is the pipeline diagram, executable.
 */
export async function runPipeline<P, UP>(
  blueprint: EngineBlueprint<P>,
  request: RecommendationRequest<P, UP>,
  deps: PipelineDeps,
): Promise<RecommendationResult<P>> {
  const { registry } = blueprint
  const diagnostics = new DiagnosticsCollector()
  const started = deps.clock.now()

  // Stage 0 is the one stage outside runStage: it builds the context that every other
  // stage needs to be run at all, including the signal they are checked against.
  const resolveStarted = deps.clock.now()
  const ctx: RequestContext<UP> = resolveRequest(request, {
    config: blueprint.config,
    clock: deps.clock,
    rng: deps.rng,
    logger: deps.logger,
    diagnostics,
    weightProvider: registry.weightProvider,
  })
  diagnostics.record({ id: 'resolve', ms: deps.clock.now() - resolveStarted, in: 0, out: 0 })

  const policyFor = (stage: StageId): PolicyContext => ({
    stage,
    errorPolicy: ctx.config.errorPolicy,
    diagnostics,
    metrics: deps.metrics,
  })

  const stage = <T>(id: StageId, inputSize: number, sizeOf: (value: T) => number, run: () => Promise<T>) =>
    runStage<T>({
      id,
      ctx,
      middleware: registry.middleware,
      diagnostics,
      clock: deps.clock,
      inputSize,
      sizeOf,
      run,
    })

  const retrieved = await stage(
    'retrieval',
    0,
    (b) => b.size,
    () => retrieve(ctx, registry.providers, policyFor('retrieval')),
  )
  const retrievedCount = retrieved.size

  const approved = await stage(
    'prefilter',
    retrievedCount,
    (b) => b.size,
    async () => prefilter(retrieved, registry.preFilters, ctx, policyFor('prefilter')),
  )

  let candidates = approved
  let set: CandidateSet<P> = candidates.build()

  const extracted = await stage(
    'extraction',
    set.size,
    () => set.size,
    () =>
      extract(
        set,
        ctx,
        registry.schema,
        registry.profileSchema,
        registry.extractors,
        registry.userExtractors,
        policyFor('extraction'),
      ),
  )
  let matrix = extracted.matrix

  await stage(
    'engineering',
    set.size,
    () => set.size,
    async () => engineer(matrix, ctx, registry.transforms, policyFor('engineering')),
  )

  const viewOf = (): ScoringView => ({ items: matrix, profile: extracted.profile, ctx })

  const filtered = await stage(
    'postfilter',
    set.size,
    (f) => f.set.size,
    async () =>
      postfilter(candidates, set, matrix, registry.postFilters, viewOf(), ctx, policyFor('postfilter')),
  )
  candidates = filtered.candidates
  set = filtered.set
  matrix = filtered.matrix

  const columns = await stage(
    'scoring',
    set.size,
    (c) => c.length,
    async () =>
      score(registry.strategies, set, viewOf(), ctx, extracted.degradedProfile, policyFor('scoring')),
  )

  const normalized = await stage(
    'normalization',
    columns.length,
    (c) => c.length,
    async () => normalize(columns, deps.normalizers, ctx, policyFor('normalization')),
  )

  const combined = await stage(
    'combination',
    normalized.length,
    (b) => b.rows,
    async () => combine(normalized, fillSlot(registry.combiner, weightedSum), ctx),
  )

  const board = await stage(
    'modifiers',
    combined.rows,
    (b) => b.rows,
    async () => modify(combined, registry.modifiers, set, ctx, policyFor('modifiers')),
  )

  const ranked = await stage(
    'ranking',
    board.rows,
    (r) => r.length,
    async () => rank(fillSlot(registry.ranker, sortRanker), board, set, ctx),
  )

  const diversified = await stage(
    'diversification',
    ranked.length,
    (r) => r.length,
    async () => diversify(registry.diversifiers, ranked, set, board, ctx, policyFor('diversification')),
  )

  const blended = await stage(
    'blending',
    diversified.length,
    (r) => r.length,
    async () => blend(registry.blender, diversified, board, ctx, policyFor('blending')),
  )

  const page = await stage(
    'truncate',
    blended.length,
    (r) => r.length,
    async () => truncate(blended, ctx),
  )

  const recommendations = await stage(
    'explanation',
    page.length,
    (r: readonly Recommendation<P>[]) => r.length,
    async () =>
      explain(
        page,
        fillSlot(registry.explainer, defaultExplainer as never),
        board,
        set,
        ctx,
        policyFor('explanation'),
      ),
  )

  return await stage(
    'assemble',
    recommendations.length,
    (r) => r.recommendations.length,
    async () => ({
      recommendations,
      diagnostics: {
        totalMs: deps.clock.now() - started,
        stages: diagnostics.stages,
        retrieved: retrievedCount,
        // What filtering removed, both stages of it. The one number that explains an empty
        // feed at a glance: retrieved 5000, filtered 5000.
        filtered: retrievedCount - set.size,
        warnings: diagnostics.collected,
      },
    }),
  )
}
