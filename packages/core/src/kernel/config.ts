import type { StrategyId } from '../domain/ids.js'
import { RecoError } from './errors.js'

/** Recursive optional, for `configure()`. Arrays are replaced wholesale, not merged. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/**
 * How the engine behaves when a port throws. `strict` in dev and CI, usually `degrade`
 * in production.
 *
 * Silent degradation is the thing this whole design is against, so `degrade` never means
 * "pretend it worked": every degraded stage writes a structured warning into
 * `Diagnostics` and counts `reco.degraded` in `Metrics`. A degrade policy without a
 * metric is a slow quality regression nobody notices.
 */
export type ErrorPolicy = 'strict' | 'degrade'

export interface EngineConfig {
  /** Key = `StrategyId`. Missing keys default to 1.0 — an equal vote. */
  readonly weights: Readonly<Record<string, number>>
  readonly normalization: {
    readonly default: string
    readonly perStrategy?: Readonly<Record<string, string>>
  }
  readonly combiner: { readonly id: string; readonly options?: object }
  readonly exploration: {
    readonly enabled: boolean
    readonly buckets: readonly { readonly id: string; readonly share: number; readonly filter?: string }[]
    readonly epsilon: number
    readonly seed?: string
  }
  readonly novelty: {
    readonly enabled: boolean
    readonly halfLifeDays: number
    readonly saturationThreshold: number
  }
  readonly fatigue: {
    readonly enabled: boolean
    readonly threshold: number
    readonly decay: 'exponential' | 'linear' | 'sigmoid'
    readonly floor: number
    readonly recoveryDays: number
  }
  readonly diversity: {
    readonly enabled: boolean
    readonly lambda: number
    readonly quotas?: Readonly<Record<string, number>>
  }
  readonly errorPolicy: ErrorPolicy
  /**
   * Share of candidates a filter may throw on before the request fails.
   *
   * Fail-closed has a trap fail-open does not: a total outage looks like emptiness rather
   * than breakage. Drop candidates one by one and a dead licence service empties the
   * feed — the user reads "no recommendations", operations reads HTTP 200, and the
   * incident surfaces a day later in a metric. An empty result is safe, but it lies about
   * why. A threshold buys both properties: one failure degrades, a systematic one is
   * called what it is.
   */
  readonly filterErrorBudget: number
  /**
   * ENGINE INVARIANT, not a recommendation. All three are mandatory and have no
   * defaults: omitting one fails `build()`. The author has to name the numbers on
   * purpose, because there is no honest default for "how much of my database may one
   * request touch".
   */
  readonly limits: {
    /** Retrieval ceiling, handed to providers as `RetrievalBudget.maxItems`. */
    readonly maxCandidates: number
    /** Ceiling on `request.limit`. Above it the request is rejected. */
    readonly maxLimit: number
    /** Feeds `AbortSignal.timeout`. */
    readonly timeoutMs: number
  }
  /** One namespace per plugin. Validated by the plugin's own `configSchema`. */
  readonly plugins: Readonly<Record<string, unknown>>
}

/**
 * Config after resolution and validation. What `ctx.config` is.
 *
 * `weights` becomes a `Map` keyed by `StrategyId` rather than the plain record the author
 * writes: by this point every key is known to name a registered strategy, and the branded
 * key type is what carries that fact into the pipeline.
 */
export interface ResolvedConfig extends Omit<EngineConfig, 'weights'> {
  readonly weights: ReadonlyMap<StrategyId, number>
}

/** One thing wrong with the config. Collected, not thrown one at a time. */
export interface ConfigIssue {
  /** Dotted path: `'limits.maxLimit'`, `'plugins.music.decay'`. */
  readonly path: string
  readonly message: string
}

/**
 * A plugin's contract for its own config namespace.
 *
 * Hand-rolled instead of zod because `@recoengine/core` has zero dependencies and this is
 * where that promise gets tested. `validate` returns issues rather than throwing, so
 * `build()` can report every problem in the config at once instead of making the author
 * fix them one restart at a time.
 */
export interface ConfigSchema<T = unknown> {
  /** Key under `config.plugins`. */
  readonly namespace: string
  /** Merged under the host's values (§10, priority 5). */
  readonly defaults: T
  validate(value: unknown): readonly ConfigIssue[]
}

/** Everything except `limits`, which is deliberately absent (§23.3). */
const CORE_DEFAULTS: Omit<EngineConfig, 'limits'> = {
  weights: {},
  normalization: { default: 'minmax' },
  combiner: { id: 'weighted-sum' },
  exploration: { enabled: false, buckets: [], epsilon: 0 },
  novelty: { enabled: false, halfLifeDays: 30, saturationThreshold: 0.8 },
  fatigue: { enabled: false, threshold: 50, decay: 'exponential', floor: 0.1, recoveryDays: 30 },
  diversity: { enabled: false, lambda: 0.7 },
  errorPolicy: 'strict',
  filterErrorBudget: 0.05,
  plugins: {},
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep merge, with arrays replaced rather than concatenated.
 *
 * Concatenation would make `configure({ exploration: { buckets: [...] } })` append to the
 * defaults, so the shares would sum past 1 and the second `configure()` call would behave
 * differently from the first. Replacement is the only rule that keeps `configure()`
 * idempotent.
 */
function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch

  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = key in base ? merge(base[key], value) : value
  }
  return out
}

const isFinitePositive = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
const isShare = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/**
 * Merges the layers, validates the result, and refuses to produce a config that would
 * misbehave later.
 *
 * Every check here answers a failure that is otherwise silent and slow: a weight keyed to
 * a strategy that does not exist does nothing at all, and `popularty: 0.3` looks right in
 * a review. `maxLimit > maxCandidates` produces a page that can never be filled. Both are
 * typos that would surface as "the recommendations feel off" months later.
 */
export class ConfigResolver {
  private readonly schemas = new Map<string, ConfigSchema>()

  /** Later plugins may not silently re-own a namespace someone already validates. */
  addSchema(schema: ConfigSchema, owner: string): void {
    const existing = this.schemas.get(schema.namespace)
    if (existing !== undefined) {
      throw new RecoError(
        'SLOT_CONFLICT',
        `Two plugins claim the config namespace "${schema.namespace}". One of them would validate ` +
          `the other's options. Rename one — "${owner}" is the second to claim it.`,
      )
    }
    this.schemas.set(schema.namespace, schema)
  }

  /**
   * @param patch  everything `configure()` accumulated
   * @param strategyIds  registered strategies; weights are checked against them
   */
  resolve(patch: DeepPartial<EngineConfig>, strategyIds: readonly StrategyId[]): ResolvedConfig {
    const pluginDefaults: Record<string, unknown> = {}
    for (const [namespace, schema] of this.schemas) {
      pluginDefaults[namespace] = schema.defaults
    }

    const merged = merge({ ...CORE_DEFAULTS, plugins: pluginDefaults }, patch) as EngineConfig
    const issues = [...this.validateEngine(merged, strategyIds), ...this.validatePlugins(merged)]

    if (issues.length > 0) {
      // All of them, at once. Fixing config one restart per typo is a waste of a life.
      const detail = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n')
      throw new RecoError('INVALID_CONFIG', `Engine config is invalid:\n${detail}`)
    }

    const weights = new Map<StrategyId, number>()
    for (const id of strategyIds) {
      weights.set(id, merged.weights[id] ?? 1)
    }

    return Object.freeze({ ...merged, weights })
  }

  /** Layers per-request overrides over the built config. Stage 0 of the pipeline. */
  static override(base: ResolvedConfig, patch: DeepPartial<EngineConfig> | undefined): ResolvedConfig {
    if (patch === undefined) return base
    const merged = merge({ ...base, weights: Object.fromEntries(base.weights) }, patch) as EngineConfig
    const weights = new Map<StrategyId, number>()
    for (const [id, weight] of Object.entries(merged.weights)) {
      weights.set(id as StrategyId, weight)
    }
    return Object.freeze({ ...merged, weights })
  }

  private validateEngine(config: EngineConfig, strategyIds: readonly StrategyId[]): ConfigIssue[] {
    const issues: ConfigIssue[] = []
    const limits = config.limits as EngineConfig['limits'] | undefined

    // No defaults, on purpose (§23.3). Absence is the error, not a cue to invent a number.
    if (limits === undefined) {
      issues.push({
        path: 'limits',
        message:
          'is mandatory and has no default. Name maxCandidates, maxLimit and timeoutMs explicitly — ' +
          'the engine will not guess how much of your database one request may touch.',
      })
    } else {
      for (const key of ['maxCandidates', 'maxLimit', 'timeoutMs'] as const) {
        if (!isFinitePositive(limits[key])) {
          issues.push({
            path: `limits.${key}`,
            message: `is mandatory and must be a positive finite number.`,
          })
        }
      }
      if (
        isFinitePositive(limits.maxLimit) &&
        isFinitePositive(limits.maxCandidates) &&
        limits.maxLimit > limits.maxCandidates
      ) {
        issues.push({
          path: 'limits.maxLimit',
          message:
            `is ${limits.maxLimit} but maxCandidates is ${limits.maxCandidates}: a request may ask for more ` +
            `items than retrieval is ever allowed to fetch, so that page can never be filled.`,
        })
      }
    }

    const known = new Set<string>(strategyIds)
    for (const [id, weight] of Object.entries(config.weights)) {
      if (!Number.isFinite(weight) || weight < 0) {
        issues.push({
          path: `weights.${id}`,
          message: `must be a non-negative finite number, got ${weight}.`,
        })
      }
      if (!known.has(id)) {
        // A weight for a strategy that is not registered does exactly nothing, and
        // `popularty: 0.3` reads as correct in a diff. Same reasoning as MISSING_FEATURE:
        // catch the typo at startup, not in a quality metric next quarter.
        issues.push({
          path: `weights.${id}`,
          message:
            `no strategy with this id is registered, so this weight has no effect. ` +
            `Registered: ${known.size > 0 ? [...known].join(', ') : '(none)'}.`,
        })
      }
    }

    if (!isShare(config.filterErrorBudget)) {
      issues.push({
        path: 'filterErrorBudget',
        message: `must be a share in [0..1], got ${config.filterErrorBudget}.`,
      })
    }
    if (!isShare(config.exploration.epsilon)) {
      issues.push({
        path: 'exploration.epsilon',
        message: `must be in [0..1], got ${config.exploration.epsilon}.`,
      })
    }
    if (!isShare(config.diversity.lambda)) {
      issues.push({ path: 'diversity.lambda', message: `must be in [0..1], got ${config.diversity.lambda}.` })
    }
    if (!isShare(config.fatigue.floor)) {
      issues.push({ path: 'fatigue.floor', message: `must be in [0..1], got ${config.fatigue.floor}.` })
    }
    if (config.fatigue.enabled && !isFinitePositive(config.fatigue.threshold)) {
      issues.push({
        path: 'fatigue.threshold',
        message: `must be a positive number when fatigue is enabled.`,
      })
    }
    if (config.novelty.enabled && !isFinitePositive(config.novelty.halfLifeDays)) {
      issues.push({
        path: 'novelty.halfLifeDays',
        message: `must be a positive number when novelty is enabled.`,
      })
    }

    if (config.exploration.enabled) {
      if (config.exploration.buckets.length === 0) {
        issues.push({ path: 'exploration.buckets', message: `is empty while exploration is enabled.` })
      } else {
        const total = config.exploration.buckets.reduce((sum, bucket) => sum + bucket.share, 0)
        // Slots are integers; shares that sum to 0.9 leave a tenth of every page undefined.
        if (Math.abs(total - 1) > 1e-6) {
          issues.push({
            path: 'exploration.buckets',
            // Rounded: 0.7 + 0.2 sums to 0.8999999999999999 in binary floating point, and
            // an error reading "shares sum to 0.8999999999999999" makes the engine look
            // broken rather than the config. The tolerance above already forgave that noise.
            message: `shares sum to ${Number(total.toFixed(6))}, expected 1. Every slot must belong to exactly one bucket.`,
          })
        }
      }
    }

    return issues
  }

  private validatePlugins(config: EngineConfig): ConfigIssue[] {
    const issues: ConfigIssue[] = []
    for (const [namespace, schema] of this.schemas) {
      for (const issue of schema.validate(config.plugins[namespace])) {
        issues.push({ path: `plugins.${namespace}.${issue.path}`, message: issue.message })
      }
    }
    return issues
  }
}
