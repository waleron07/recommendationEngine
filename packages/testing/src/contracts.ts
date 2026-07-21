import {
  type FeatureExtractor,
  type History,
  isAbort,
  type RecommendationEngine,
  type RecommendationRequest,
  type ScoreModifier,
  type ScoringStrategy,
  type Usable,
} from '@recoengine/core'
import {
  catalogueOf,
  constantStrategy,
  type FeatureRow,
  itemsOf,
  passthroughStrategy,
  payloadExtractor,
  request,
  testEngine,
} from './fixtures.js'

/**
 * Reusable port contracts (§20–§21). Each is framework-agnostic: it throws a plain
 * `Error` on violation and returns on conformance, so a third-party plugin author checks
 * a rule in one line — `it('cancels', () => assertHonoursCancellation(engine))` — under
 * whatever runner they use. No `vitest` dependency reaches this package.
 *
 * The two mandatory ones (§21) are cancellation (§17.1) and error policy (§17.2); the
 * rest — determinism, well-formed scores — are the hygiene every engine owes its caller.
 */

const fail = (message: string): never => {
  throw new Error(`[recoengine contract] ${message}`)
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/**
 * §17.1. A pre-aborted signal must make `recommend()` reject with an `AbortError`, never
 * resolve with a half-built feed. This holds for *any* engine: the core checks the signal
 * at every stage boundary, so even a port that does nothing inherits the guarantee — and
 * a port that swallows the signal is exactly what this catches.
 */
export async function assertHonoursCancellation(
  engine: RecommendationEngine,
  req: RecommendationRequest = request(),
): Promise<void> {
  const controller = new AbortController()
  controller.abort()

  try {
    await engine.recommend({ ...req, signal: controller.signal })
  } catch (error) {
    if (!isAbort(error)) {
      fail(`recommend() rejected on a pre-aborted signal, but not with an AbortError: ${describe(error)}`)
    }
    return
  }
  fail('recommend() resolved on a pre-aborted signal; §17.1 requires it to reject with an AbortError.')
}

/**
 * Same input, same output — twice. The seeded RNG (§21) makes a feed reproducible; a
 * contribution ordered by a `Map`'s iteration order, or a tie broken non-deterministically,
 * would show up here rather than as a flaky golden test three weeks later.
 */
export async function assertDeterministic(
  engine: RecommendationEngine,
  req: RecommendationRequest = request(),
): Promise<void> {
  const first = await engine.recommend(req)
  const second = await engine.recommend(req)

  const shape = (result: Awaited<ReturnType<RecommendationEngine['recommend']>>) =>
    result.recommendations.map((r) => `${r.rank}:${r.item.id}:${r.score}`).join('|')

  if (shape(first) !== shape(second)) {
    fail(`two runs of the same request produced different rankings:\n  ${shape(first)}\n  ${shape(second)}`)
  }
}

/**
 * Every score finite, within `[0..100]`, ranks a dense `1..n`, and no more than the
 * request asked for. A single `NaN` from a strategy poisons the weighted sum and collapses
 * the ranking into insertion order while every score still *looks* like a number — the
 * failure this refuses to let pass silently.
 */
export async function assertScoresWellFormed(
  engine: RecommendationEngine,
  req: RecommendationRequest = request(),
): Promise<void> {
  const { recommendations } = await engine.recommend(req)

  if (recommendations.length > req.limit) {
    fail(`returned ${recommendations.length} recommendations for a limit of ${req.limit}.`)
  }

  recommendations.forEach((rec, index) => {
    if (!Number.isFinite(rec.score)) fail(`score for "${rec.item.id}" is not finite: ${rec.score}.`)
    if (rec.score < -1e-9 || rec.score > 100 + 1e-9) {
      fail(`score for "${rec.item.id}" is outside [0..100]: ${rec.score}.`)
    }
    if (rec.rank !== index + 1) {
      fail(`ranks are not a dense 1..n: position ${index} has rank ${rec.rank}.`)
    }
  })
}

/**
 * Explainability is structural (§16): a score is a fold over its contributions, so
 * `Σ (additive contributions) = baseScore` must hold exactly for every recommendation.
 * A drift here means the explanation and the number it explains have come apart — the one
 * thing the board's design is supposed to make impossible. Checks the additive fold
 * (`base = Σ(weight×norm)/Σweight`), which is what the presentation `baseScore` reflects;
 * multiplicative and boost contributions move `score` off `baseScore` and are out of scope.
 */
export async function assertExplanationSums(
  engine: RecommendationEngine,
  req: RecommendationRequest = request(),
): Promise<void> {
  const { recommendations } = await engine.recommend({ ...req, explain: 'full' })

  for (const rec of recommendations) {
    const additive = rec.explanation.contributions.filter((c) => c.kind === 'additive')
    if (additive.length === 0) continue // Nothing additive to fold — cold start, base 0.
    const weightSum = additive.reduce((s, c) => s + c.weight, 0)
    if (weightSum === 0) continue
    const base = additive.reduce((s, c) => s + c.weight * c.normalized, 0) / weightSum
    const expected = Math.round(base * 100)
    if (Math.abs(expected - rec.explanation.baseScore) > 1) {
      fail(
        `Σ contributions ≠ baseScore for "${rec.item.id}": folded ${expected}, ` +
          `explanation says ${rec.explanation.baseScore}. The score and its explanation have drifted.`,
      )
    }
  }
}

export interface StrategyContractOptions {
  /** Candidate rows carrying the strategy's required features as payload fields. */
  readonly rows: readonly FeatureRow[]
  /** Extra plugins the strategy needs — e.g. a `profileExtractor` for a `requiresProfile` feature. */
  readonly extraPlugins?: readonly Usable<FeatureRow>[]
  /** History, when the strategy's `applicable` gate needs one to run at all. */
  readonly history?: History
  readonly signals?: ReadonlyMap<string, unknown>
  readonly now?: number
  /**
   * By default the harness auto-adds a `payloadExtractor` for the strategy's required
   * features, reading them from `rows`. Set this when the features are instead produced by
   * a real extractor/transform in `extraPlugins` — otherwise both declare the same key and
   * `build()` rejects the collision.
   */
  readonly featuresFromPlugins?: boolean
}

/**
 * Runs a `ScoringStrategy` through a real engine (one extractor supplying its required
 * features from `rows`) and applies the cancellation, determinism and well-formedness
 * contracts. The one-line conformance check for a strategy author.
 */
export async function assertScoringStrategy(
  strategy: ScoringStrategy,
  options: StrategyContractOptions,
): Promise<void> {
  const keys = strategy.requires.map((key) => key as string)
  const supply = options.featuresFromPlugins ? [] : [payloadExtractor(keys)]
  const engine = testEngine<FeatureRow>({
    use: [catalogueOf(options.rows), ...supply, ...(options.extraPlugins ?? []), strategy],
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const req = request({
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
  })

  await assertScoresWellFormed(engine, req)
  await assertDeterministic(engine, req)
  await assertHonoursCancellation(engine, req)
}

export interface ModifierContractOptions {
  /** Ids of the candidates to score. */
  readonly ids: readonly string[]
  /** The flat base score every candidate starts from, before the modifier. Default 0.5. */
  readonly base?: number
  readonly history?: History
  readonly signals?: ReadonlyMap<string, unknown>
  readonly extraPlugins?: readonly Usable[]
  readonly now?: number
}

/**
 * Runs a `ScoreModifier` through a real engine over a flat base score and applies the
 * hygiene contracts. Confirms the modifier keeps scores finite and in range — a
 * multiplicative factor of `NaN`, or a boost that pushes past the clamp, would surface here.
 */
export async function assertScoreModifier(
  modifier: ScoreModifier,
  options: ModifierContractOptions,
): Promise<void> {
  const engine = testEngine({
    use: [
      itemsOf(options.ids),
      constantStrategy(options.base ?? 0.5),
      ...(options.extraPlugins ?? []),
      modifier,
    ],
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const req = request({
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
  })

  await assertScoresWellFormed(engine, req)
  await assertDeterministic(engine, req)
  await assertHonoursCancellation(engine, req)
}

export interface ExtractorErrorPolicyOptions {
  /** A throwing extractor (see `throwingExtractor`) whose `criticality` decides the degrade path. */
  readonly extractor: FeatureExtractor<FeatureRow>
  /** The feature it declares, consumed by a passthrough strategy so the failure reaches scoring. */
  readonly feature: string
  readonly rows?: readonly FeatureRow[]
}

/**
 * §17.2, for the port that most needs it. A failing extractor must fail the request under
 * `strict`; under `degrade` it may fall back to the feature's `defaultValue` *with a
 * warning* — but only if its author opted in with `criticality: 'optional'`. A `required`
 * extractor fails loudly under both policies, because silent degradation is the invisible
 * catastrophe §12 and §17.2 exist to forbid.
 */
export async function assertExtractorErrorPolicy(options: ExtractorErrorPolicyOptions): Promise<void> {
  const rows = options.rows ?? (['a', 'b'].map((id) => ({ id })) as FeatureRow[])
  const engine = testEngine<FeatureRow>({
    use: [catalogueOf(rows), options.extractor, passthroughStrategy(options.feature)],
  })

  // strict: must reject, always.
  let strictThrew = false
  try {
    await engine.recommend(request({ overrides: { errorPolicy: 'strict' } }))
  } catch {
    strictThrew = true
  }
  if (!strictThrew) fail('a throwing extractor did not fail the request under errorPolicy "strict".')

  const optional = options.extractor.criticality === 'optional'
  const degradeReq = request({ overrides: { errorPolicy: 'degrade' } })

  if (optional) {
    const result = await engine
      .recommend(degradeReq)
      .catch((error) =>
        fail(
          `an optional extractor should degrade under "degrade", but the request rejected: ${describe(error)}`,
        ),
      )
    if (result.diagnostics.warnings.length === 0) {
      fail(
        'an optional extractor degraded silently under "degrade" — §17.2 requires a warning in diagnostics.',
      )
    }
  } else {
    let degradeThrew = false
    try {
      await engine.recommend(degradeReq)
    } catch {
      degradeThrew = true
    }
    if (!degradeThrew) {
      fail('a required extractor degraded silently under "degrade"; §17.2 requires it to fail the request.')
    }
  }
}
