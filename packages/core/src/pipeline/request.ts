import type { History, User } from '../domain/entities.js'
import { MapHistoryIndex } from '../domain/history.js'
import { type StrategyId, type Timestamp, timestamp } from '../domain/ids.js'
import type { DiagnosticWarning } from '../domain/recommendation.js'
import { ConfigResolver, type DeepPartial, type EngineConfig, type ResolvedConfig } from '../kernel/config.js'
import { RecoError } from '../kernel/errors.js'
import type { RequestContext } from '../ports/context.js'
import type { Clock, Logger, Rng } from '../ports/infra.js'
import type { WeightProvider } from '../ports/weight-provider.js'
import type { DiagnosticsCollector } from './stage.js'

/** What the caller asks for. */
export interface RecommendationRequest<P = unknown, UP = unknown> {
  readonly user: User<UP>
  readonly history: History
  readonly limit: number
  readonly offset?: number
  readonly explain?: 'none' | 'reasons' | 'full'
  readonly signals?: ReadonlyMap<string, unknown>
  /** This call only. The top layer of §10's resolution chain. */
  readonly overrides?: DeepPartial<EngineConfig>
  /** Merged with the engine's own timeout — the engine's is a ceiling, not a default. */
  readonly signal?: AbortSignal
}

export interface RequestDeps {
  readonly config: ResolvedConfig
  readonly clock: Clock
  readonly rng: Rng
  readonly logger: Logger
  readonly diagnostics: DiagnosticsCollector
  readonly weightProvider: WeightProvider | undefined
}

/**
 * Stage 0. Builds the context every later stage reads, and freezes it.
 *
 * Everything mutable about a request is decided here and nowhere else. That is what lets
 * one engine instance serve concurrent requests without a lock: the registry is frozen at
 * `build()`, the context is frozen at stage 0, and there is nothing left to race on.
 */
export function resolveRequest<P, UP>(
  request: RecommendationRequest<P, UP>,
  deps: RequestDeps,
): RequestContext<UP> {
  const config = ConfigResolver.override(deps.config, request.overrides)

  if (!Number.isInteger(request.limit) || request.limit < 0) {
    throw new RecoError(
      'INVALID_CONFIG',
      `request.limit must be a non-negative integer, got ${request.limit}.`,
    )
  }
  if (request.limit > config.limits.maxLimit) {
    // Its own code, because this is the caller's mistake and not the engine's: a page of
    // 10_000 is a request the operator already said no to.
    throw new RecoError(
      'REQUEST_LIMIT_EXCEEDED',
      `request.limit is ${request.limit}, over limits.maxLimit of ${config.limits.maxLimit}.`,
    )
  }

  const ctx: RequestContext<UP> = {
    user: request.user,
    history: new MapHistoryIndex(request.history),
    now: deps.clock.now(),
    limit: request.limit,
    offset: request.offset ?? 0,
    explain: request.explain ?? 'none',
    signals: request.signals ?? new Map(),
    config,
    // Forked per request and per user: the same user on the same day lands in the same
    // exploration bucket, so an A/B test measures the variant instead of the noise, and a
    // bug report can be replayed. An unseeded rng makes exploration undebuggable.
    rng: deps.rng.fork(`${request.user.id}:${config.exploration.seed ?? ''}`),
    logger: deps.logger,
    diagnostics: { warn: (warning: DiagnosticWarning) => deps.diagnostics.warn(warning) },
    signal: buildSignal(request.signal, config.limits.timeoutMs),
  }

  return Object.freeze(withWeights(ctx, deps.weightProvider))
}

/**
 * The engine always has a signal, whether or not the caller brought one (§17.1).
 *
 * `AbortSignal.any` rather than a hand-rolled listener: it is the platform's own
 * composition, it does not leak the listener when either side settles, and it exists in
 * every runtime the CI matrix names. `timeoutMs` is not a default the caller may
 * disable — it is the ceiling the operator set, so it applies on top of their signal
 * rather than instead of it.
 */
function buildSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout])
}

/**
 * Applies the `WeightProvider` layer of §10.
 *
 * The door left open for online learning: weights may come from a bandit trained outside
 * the engine, and the core still learns nothing. Missing keys keep their configured value
 * rather than dropping to zero — a provider that only knows about two strategies must not
 * silence the other six.
 *
 * The provider is handed a whole, valid context whose `config` still carries the
 * configured weights. Building it in two passes rather than threading a half-context
 * through: the port's type promises a `RequestContext`, and one missing `rng` away from
 * that promise is a crash inside somebody else's plugin.
 */
function withWeights<UP>(ctx: RequestContext<UP>, provider: WeightProvider | undefined): RequestContext<UP> {
  if (provider === undefined) return ctx

  const overrides = provider.weights(ctx)
  if (overrides.size === 0) return ctx

  const weights = new Map<StrategyId, number>(ctx.config.weights)
  for (const [id, weight] of overrides) {
    if (!weights.has(id)) continue // Unknown strategy: build() already rejected those keys.
    weights.set(id, weight)
  }
  return { ...ctx, config: Object.freeze({ ...ctx.config, weights }) }
}

/** The deadline handed to providers, so a slow source stops rather than being cut off. */
export function deadlineOf(ctx: RequestContext): Timestamp {
  return timestamp(ctx.now + ctx.config.limits.timeoutMs)
}
