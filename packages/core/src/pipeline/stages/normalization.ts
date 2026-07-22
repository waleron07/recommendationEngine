import { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { NormalizedColumn, ScoreNormalizer } from '../../ports/score-normalizer.js'
import { rethrowIfAborted } from '../policy.js'
import type { ScoredColumn } from './scoring.js'

/**
 * Stage 6. Every column onto [0..1], so the weights mean what they say.
 *
 * Without this step a weight is not a preference, it is a unit conversion:
 * `PopularityStrategy` returns 4,200,000 plays and `RecencyStrategy` returns 0.87, so
 * balancing them would need `popularity: 0.0000001` — and one viral track joining the
 * catalogue would silently rescale everybody's recommendations. After it, `artist: 0.9`
 * against `popularity: 0.3` reads as "artist matters three times more", and that is true.
 *
 * A strategy never learns how it was normalized. It knows its own scale (`normalizer`);
 * the operator knows the house default. Neither knows the other's business.
 */
export function normalize(
  columns: readonly ScoredColumn[],
  normalizers: ReadonlyMap<string, ScoreNormalizer>,
  ctx: RequestContext,
): readonly NormalizedColumn[] {
  const out: NormalizedColumn[] = []

  for (const { column, weight, strategy } of columns) {
    ctx.signal.throwIfAborted()
    const normalizer = normalizerFor(strategy.id, strategy.normalizer, normalizers, ctx)

    let normalized: Float64Array
    try {
      normalized = normalizer.normalize(column.raw)
    } catch (error) {
      rethrowIfAborted(error)
      // Not degradable, under either policy. Falling back to the raw column would put
      // 4,200,000 into a weighted sum of numbers in [0..1] and bury every other strategy —
      // a "degradation" that silently rewrites the ranking is worse than a failed request.
      throw new RecoError(
        'PORT_FAILED',
        `normalization: normalizer "${normalizer.id}" failed on column "${strategy.id}". ` +
          `A raw column cannot stand in for a normalized one: its scale would swamp the sum.`,
        { cause: error },
      )
    }

    assertShape(normalizer.id, strategy.id, column.raw, normalized)
    out.push({ strategyId: strategy.id, normalized, raw: column.raw, weight, reasons: column.reasons })
  }

  return out
}

/** The strategy's own normalizer wins; then the per-strategy config; then the default. */
function normalizerFor(
  strategyId: string,
  own: ScoreNormalizer | undefined,
  normalizers: ReadonlyMap<string, ScoreNormalizer>,
  ctx: RequestContext,
): ScoreNormalizer {
  if (own !== undefined) return own

  const configured = ctx.config.normalization.perStrategy?.[strategyId] ?? ctx.config.normalization.default
  const normalizer = normalizers.get(configured)
  if (normalizer === undefined) {
    throw new RecoError(
      'INVALID_CONFIG',
      `Normalizer "${configured}" is configured for "${strategyId}" but is not registered. ` +
        `Known: ${[...normalizers.keys()].join(', ') || '(none)'}.`,
    )
  }
  return normalizer
}

/**
 * A normalizer that lies about its output is the failure this whole stage exists to
 * prevent, so it is checked rather than trusted.
 *
 * One NaN here reaches the weighted sum, and from there every comparison against it is
 * false — the ranking collapses into insertion order while every score still looks like a
 * number. That is the bug that gets found in a business metric three weeks later.
 */
function assertShape(
  normalizerId: string,
  strategyId: string,
  raw: Float64Array,
  normalized: Float64Array,
): void {
  if (normalized.length !== raw.length) {
    throw new RecoError(
      'PORT_FAILED',
      `normalization: "${normalizerId}" returned ${normalized.length} values for the ${raw.length} rows of ` +
        `column "${strategyId}". Rows are positional: a shorter column silently rescores everyone below it.`,
    )
  }

  for (let row = 0; row < normalized.length; row++) {
    const value = normalized[row] as number
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RecoError(
        'PORT_FAILED',
        `normalization: "${normalizerId}" returned ${value} for row ${row} of column "${strategyId}"; ` +
          `normalized output must be finite and within [0..1], because the weights assume it.`,
      )
    }
  }
}
