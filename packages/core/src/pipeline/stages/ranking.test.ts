/**
 * Stage 9–12: ranking, diversification, blending, truncation.
 *
 * The engine and README tests drive the happy path through the whole pipeline; this file
 * targets the guards that the happy path never trips — `assertRows` and `assertSubsetOf`,
 * the checks that catch a port returning a duplicate row, an out-of-range row, or a row it
 * was never given. They were the least-covered code in the base (§5), and they are exactly
 * the code you want covered: a duplicated row is one item shown twice, reported by a user
 * and reproducible by no one.
 */
import { describe, expect, it } from 'vitest'
import { CandidateSetBuilder } from '../../domain/candidate.js'
import { itemId, strategyId } from '../../domain/ids.js'
import type { FeatureMatrix } from '../../domain/matrix.js'
import { contributionOf, type ScoreBoard, ScoreBoardBuilder } from '../../domain/score.js'
import type { RecoError } from '../../kernel/errors.js'
import type { Blender } from '../../ports/blender.js'
import type { RequestContext } from '../../ports/context.js'
import type { Diversifier } from '../../ports/diversifier.js'
import type { Ranker } from '../../ports/ranker.js'
import { isAbort, type PolicyContext } from '../policy.js'
import { DiagnosticsCollector, type DiagnosticWarning } from '../stage.js'
import { blend, diversify, rank, truncate } from './ranking.js'

const ctxWith = (
  over: Partial<{ offset: number; limit: number; explorationEnabled: boolean }> = {},
): RequestContext =>
  ({
    signal: new AbortController().signal,
    offset: over.offset ?? 0,
    limit: over.limit ?? 10,
    config: { exploration: { enabled: over.explorationEnabled ?? false } },
  }) as unknown as RequestContext

const collectorFor = (): { policy: PolicyContext; warnings: DiagnosticWarning[] } => {
  const diagnostics = new DiagnosticsCollector()
  const warnings: DiagnosticWarning[] = []
  const original = diagnostics.warn.bind(diagnostics)
  diagnostics.warn = (warning: DiagnosticWarning) => {
    warnings.push(warning)
    original(warning)
  }
  return {
    policy: { stage: 'diversification', errorPolicy: 'degrade', diagnostics, metrics: undefined },
    warnings,
  }
}

const strictPolicy: PolicyContext = {
  stage: 'diversification',
  errorPolicy: 'strict',
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
}

const set = (() => {
  const builder = new CandidateSetBuilder()
  builder.add('library', [
    { id: itemId('a'), type: 'track', payload: {} },
    { id: itemId('b'), type: 'track', payload: {} },
    { id: itemId('c'), type: 'track', payload: {} },
  ])
  return builder.build()
})()

/** Three rows scoring 3, 2, 1 — a known order to reason about. */
const board: ScoreBoard = (() => {
  const builder = new ScoreBoardBuilder(3)
  const scores = [3, 2, 1]
  for (let row = 0; row < 3; row++) {
    builder.add(
      row,
      contributionOf(strategyId('s'), 'additive', scores[row] as number, scores[row] as number, 1),
    )
  }
  return builder.build()
})()

const matrix = {} as FeatureMatrix // the misbehaving diversifiers below never read it
const ranker = (rows: readonly number[]): Ranker => ({ id: 'r', rank: () => rows })
const diversifier = (fn: (ranked: readonly number[]) => readonly number[]): Diversifier => ({
  id: 'd',
  diversify: (ranked) => fn(ranked),
})
const blender = (fn: (ranked: readonly number[]) => readonly number[]): Blender => ({
  id: 'b',
  blend: (ranked) => fn(ranked),
})

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('rank', () => {
  it('returns the ranker order when it is a valid permutation', () => {
    expect(rank(ranker([2, 1, 0]), board, set, ctxWith())).toEqual([2, 1, 0])
  })

  it('rejects a duplicated row — one item cannot appear twice in a feed', () => {
    const error = failure(() => rank(ranker([0, 0, 1]), board, set, ctxWith()))
    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toMatch(/twice/)
  })

  it('rejects a row out of range', () => {
    expect(failure(() => rank(ranker([0, 1, 9]), board, set, ctxWith())).code).toBe('PORT_FAILED')
  })

  it('fails the request when the ranker itself throws — there is no degraded order', () => {
    const thrower: Ranker = {
      id: 'boom',
      rank: () => {
        throw new Error('ranker down')
      },
    }
    expect(failure(() => rank(thrower, board, set, ctxWith())).code).toBe('PORT_FAILED')
  })
})

describe('diversify', () => {
  it('applies each diversifier in turn, keeping the result a subset', () => {
    const dropLast = diversifier((ranked) => ranked.slice(0, 2))
    expect(diversify([dropLast], [0, 1, 2], set, board, ctxWith(), matrix, strictPolicy)).toEqual([0, 1])
  })

  it('rejects a diversifier that invents a row it was never given', () => {
    // Row 2 is a valid candidate, but it was not in the list this diversifier received —
    // a reorderer may drop rows, never resurrect ones an earlier stage removed. (Using a
    // valid-but-absent row, not an out-of-range one, so assertSubsetOf is what catches it.)
    const invent = diversifier(() => [0, 1, 2])
    const error = failure(() => diversify([invent], [0, 1], set, board, ctxWith(), matrix, strictPolicy))
    expect(error.code).toBe('PORT_FAILED')
    // The subset check throws inside the stage's try, so strict re-wraps it — the specific
    // "not in the list" reason is the cause.
    expect((error.cause as Error).message).toMatch(/not in the list/)
  })

  it('rejects a diversifier that duplicates a row', () => {
    const dupe = diversifier(() => [0, 0])
    expect(
      failure(() => diversify([dupe], [0, 1, 2], set, board, ctxWith(), matrix, strictPolicy)).code,
    ).toBe('PORT_FAILED')
  })

  it('under degrade, a throwing diversifier is skipped and the ranking stands, with a warning', () => {
    const boom = diversifier(() => {
      throw new Error('similarity provider down')
    })
    const { policy, warnings } = collectorFor()
    expect(diversify([boom], [0, 1, 2], set, board, ctxWith(), matrix, policy)).toEqual([0, 1, 2])
    expect(warnings.map((w) => w.code)).toContain('degraded')
  })

  it('under strict, a throwing diversifier fails the request', () => {
    const boom = diversifier(() => {
      throw new Error('down')
    })
    expect(
      failure(() => diversify([boom], [0, 1, 2], set, board, ctxWith(), matrix, strictPolicy)).code,
    ).toBe('PORT_FAILED')
  })

  it('lets an AbortError from a diversifier propagate rather than degrading it', () => {
    const aborted = diversifier(() => {
      throw new DOMException('aborted', 'AbortError')
    })
    const { policy } = collectorFor()
    const thrown = failure(() => diversify([aborted], [0, 1, 2], set, board, ctxWith(), matrix, policy))
    expect(isAbort(thrown)).toBe(true)
  })
})

describe('blend', () => {
  it('returns the ranking untouched when no blender is registered', () => {
    expect(blend(undefined, [0, 1, 2], board, ctxWith(), strictPolicy)).toEqual([0, 1, 2])
  })

  it('warns quota_unfilled when exploration is on but nothing explores', () => {
    const { policy, warnings } = collectorFor()
    blend(undefined, [0, 1, 2], board, ctxWith({ explorationEnabled: true }), policy)
    expect(warnings.map((w) => w.code)).toContain('quota_unfilled')
  })

  it('applies a blender that reorders within the set', () => {
    expect(
      blend(
        blender((r) => [...r].reverse()),
        [0, 1, 2],
        board,
        ctxWith(),
        strictPolicy,
      ),
    ).toEqual([2, 1, 0])
  })

  it('rejects a blender that invents a row', () => {
    expect(
      failure(() =>
        blend(
          blender(() => [0, 1, 2, 7]),
          [0, 1, 2],
          board,
          ctxWith(),
          strictPolicy,
        ),
      ).code,
    ).toBe('PORT_FAILED')
  })

  it('under degrade, a throwing blender leaves the list unexplored with a warning', () => {
    const boom = blender(() => {
      throw new Error('blender down')
    })
    const { policy, warnings } = collectorFor()
    expect(blend(boom, [0, 1, 2], board, ctxWith(), policy)).toEqual([0, 1, 2])
    expect(warnings.map((w) => w.code)).toContain('degraded')
  })
})

describe('truncate', () => {
  it('applies the page window — offset then limit', () => {
    expect(truncate([0, 1, 2, 3, 4], ctxWith({ offset: 1, limit: 2 }))).toEqual([1, 2])
  })

  it('returns everything when the page is larger than the list', () => {
    expect(truncate([0, 1], ctxWith({ offset: 0, limit: 10 }))).toEqual([0, 1])
  })
})
