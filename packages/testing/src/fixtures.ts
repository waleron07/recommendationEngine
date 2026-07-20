import {
  type CandidateProvider,
  CLOCK,
  type Clock,
  createEngine,
  type DeepPartial,
  type EngineConfig,
  type Event,
  eventId,
  type FeatureDescriptor,
  type FeatureExtractor,
  featureKey,
  type History,
  identity,
  itemId,
  minmax,
  RecoError,
  type RecommendationEngine,
  type RecommendationRequest,
  type RecommendationResult,
  type ScoringStrategy,
  strategyId,
  timestamp,
  type Usable,
  type UserFeatureExtractor,
  userId,
} from '@recoengine/core'

/**
 * Fixtures: the synthetic engine parts every test needs, in one place instead of
 * re-hand-rolled per file. The "domain" is deliberately trivial — an item's payload *is*
 * its feature row — so a test stays about the thing under test and nothing else.
 */

/** A candidate row: an id plus any number of numeric feature values, read as payload. */
export type FeatureRow = { readonly id: string } & Record<string, number>

const numericDescriptor = (owner: string, key: string): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: key,
  owner,
  ownerVersion: '1.0.0',
})

/** Provider whose payload is the row itself — feature values live in the payload. */
export function catalogueOf(rows: readonly FeatureRow[], id = 'catalogue'): CandidateProvider<FeatureRow> {
  return {
    id,
    version: '1.0.0',
    provide: async (_ctx, budget) =>
      rows.slice(0, budget.maxItems).map((row) => ({ id: itemId(row.id), type: 'item', payload: row })),
  }
}

/** Provider over bare ids with empty payloads — for when features come from strategies, not payload. */
export function itemsOf(ids: readonly string[], id = 'catalogue'): CandidateProvider {
  return {
    id,
    version: '1.0.0',
    provide: async (_ctx, budget) =>
      ids.slice(0, budget.maxItems).map((value) => ({ id: itemId(value), type: 'item', payload: {} })),
  }
}

/** Extractor that copies the named numeric payload fields straight into their columns. */
export function payloadExtractor(
  keys: readonly string[],
  id = 'payload-features',
): FeatureExtractor<FeatureRow> {
  return {
    id,
    version: '1.0.0',
    provides: keys.map((key) => numericDescriptor(id, key)),
    extract: async (set, out) => {
      for (const key of keys) {
        const column = out.columnMut(featureKey(key))
        for (let row = 0; row < set.size; row++) column[row] = set.at(row).item.payload[key] ?? 0
      }
    },
  }
}

/** A user-side extractor that surfaces one profile scalar (e.g. `profile_saturation`). */
export function profileExtractor(key: string, value: number, id = 'profile-features'): UserFeatureExtractor {
  return {
    id,
    version: '1.0.0',
    scope: 'user',
    provides: [numericDescriptor(id, key)],
    extract: async (out) => {
      out.set(featureKey(key), value)
    },
  }
}

/** An extractor that declares a feature and then throws — for exercising the error policy (§17.2). */
export function throwingExtractor(
  key: string,
  options: { criticality?: 'required' | 'optional'; id?: string } = {},
): FeatureExtractor<FeatureRow> {
  const id = options.id ?? 'throwing-extractor'
  return {
    id,
    version: '1.0.0',
    criticality: options.criticality ?? 'required',
    provides: [numericDescriptor(id, key)],
    extract: async () => {
      throw new Error(`extractor "${id}" failed on purpose`)
    },
  }
}

/** A base strategy scoring every candidate the same, so modifiers move a level field. */
export function constantStrategy(value: number, id = 'base'): ScoringStrategy {
  const sid = strategyId(id)
  return {
    id: sid,
    requires: [],
    normalizer: identity,
    score: (view) => ({
      strategyId: sid,
      raw: new Float64Array(view.items.rows).fill(value),
      reasons: new Map(),
    }),
  }
}

/**
 * A minimal strategy that surfaces one feature column, normalized with `minmax` so any
 * raw scale lands in [0..1]. A ready-made consumer for a given feature.
 */
export function passthroughStrategy(key: string, id = 'passthrough'): ScoringStrategy {
  const sid = strategyId(id)
  return {
    id: sid,
    requires: [featureKey(key)],
    normalizer: minmax,
    score: (view) => ({
      strategyId: sid,
      raw: Float64Array.from(view.items.column(featureKey(key))),
      reasons: new Map(),
    }),
  }
}

/** Deterministic clock pinned at `now`. */
export function fixedClock(now: number): Clock {
  return { now: () => timestamp(now) }
}

let eventSeq = 0
/** `count` events of one type on one item, all at `at`. */
export function events(
  item: string,
  count: number,
  options: { at?: number; type?: string; user?: string } = {},
): Event[] {
  const { at = 0, type = 'play', user = 'u' } = options
  return Array.from({ length: count }, () => ({
    id: eventId(`ev${eventSeq++}`),
    userId: userId(user),
    itemId: itemId(item),
    type,
    at: timestamp(at),
  }))
}

export const TEST_LIMITS = { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 } as const

/** A request with sensible defaults; override any field. */
export function request(overrides: Partial<RecommendationRequest> = {}): RecommendationRequest {
  return {
    user: { id: userId('u'), payload: {} },
    history: { userId: userId('u'), events: [] },
    limit: 10,
    explain: 'reasons',
    ...overrides,
  }
}

/** A `History` value from a flat event list, keyed to the default test user. */
export function historyOf(list: readonly Event[]): History {
  return { userId: userId('u'), events: list }
}

export interface EngineSpec<P = unknown> {
  readonly use: readonly Usable<P>[]
  readonly config?: DeepPartial<EngineConfig>
  readonly now?: number
}

/** Assemble a built engine from a flat spec, wiring a fixed clock and the standard test limits. */
export function testEngine<P = unknown>(spec: EngineSpec<P>): RecommendationEngine<P> {
  const builder = spec.use.reduce(
    (acc, plugin) => acc.use(plugin),
    createEngine<P>().provide(CLOCK, fixedClock(spec.now ?? 0)),
  )
  return builder.configure({ limits: TEST_LIMITS, ...spec.config } as DeepPartial<EngineConfig>).build()
}

/** Ranked ids, top first — the thing golden tests assert on. */
export function rankedIds(result: RecommendationResult): string[] {
  return result.recommendations.map((r) => r.item.id as string)
}

/** id → score, for asserting how a modifier moved individual candidates. */
export function scoreById(result: RecommendationResult): Map<string, number> {
  return new Map(result.recommendations.map((r) => [r.item.id as string, r.score]))
}

/** Re-exported so a contract violation is a `RecoError`, matching the rest of the engine. */
export { RecoError }
