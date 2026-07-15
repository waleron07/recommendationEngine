import { describe, expect, it } from 'vitest'
import { CandidateSetBuilder } from '../../domain/candidate.js'
import { itemId, strategyId } from '../../domain/ids.js'
import { contributionOf, type ScoreBoard, ScoreBoardBuilder } from '../../domain/score.js'
import type { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { ScoreCombiner } from '../../ports/score-combiner.js'
import type { ScoreModifier } from '../../ports/score-modifier.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { combine, modify } from './combination.js'

const ctx = { signal: new AbortController().signal } as RequestContext

const policyWith = (errorPolicy: 'strict' | 'degrade' = 'strict'): PolicyContext => ({
  stage: 'modifiers',
  errorPolicy,
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

const set = (() => {
  const builder = new CandidateSetBuilder()
  builder.add('library', [
    { id: itemId('a'), type: 'track', payload: {} },
    { id: itemId('b'), type: 'track', payload: {} },
  ])
  return builder.build()
})()

/** A board where both candidates scored `base` from one additive strategy at weight 1. */
const boardOf = (base: number): ScoreBoard => {
  const builder = new ScoreBoardBuilder(2)
  for (let row = 0; row < 2; row++) {
    builder.add(row, contributionOf(strategyId('artist'), 'additive', base, base, 1))
  }
  return builder.build()
}

const fatigue = (multiplier: number, throwOnRow?: number): ScoreModifier => ({
  id: 'fatigue',
  kind: 'multiplicative',
  apply: (board) => {
    for (let row = 0; row < board.rows; row++) {
      if (row === throwOnRow) throw new Error('history service is down')
      board.add(row, contributionOf(strategyId('fatigue'), 'multiplicative', multiplier, multiplier, 1))
    }
  },
})

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('combination (stage 7)', () => {
  const weightedSum: ScoreCombiner = {
    id: 'weighted-sum',
    combine: (columns) => {
      const builder = new ScoreBoardBuilder(columns[0]?.normalized.length ?? 0)
      for (const column of columns) {
        for (let row = 0; row < column.normalized.length; row++) {
          builder.add(
            row,
            contributionOf(
              column.strategyId,
              'additive',
              column.raw[row] as number,
              column.normalized[row] as number,
              column.weight,
            ),
          )
        }
      }
      return builder.build()
    },
  }

  it('folds the columns into one score per candidate', () => {
    const board = combine(
      [
        {
          strategyId: strategyId('artist'),
          normalized: new Float64Array([1, 0]),
          raw: new Float64Array([1, 0]),
          weight: 1,
          reasons: new Map(),
        },
      ],
      weightedSum,
      ctx,
      2,
    )

    expect(board.base(0)).toBe(1)
    expect(board.base(1)).toBe(0)
  })

  it('fails the request when the combiner throws, under any policy — nothing runs without a score', () => {
    const broken: ScoreCombiner = {
      id: 'rrf',
      combine: () => {
        throw new Error('fusion failed')
      },
    }

    const error = failure(() =>
      combine(
        [
          {
            strategyId: strategyId('x'),
            normalized: new Float64Array([1]),
            raw: new Float64Array([1]),
            weight: 1,
            reasons: new Map(),
          },
        ],
        broken,
        ctx,
        1,
      ),
    )
    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toMatch(/nothing downstream can run/i)
  })
})

describe('modifiers (stage 8)', () => {
  it('multiplies rather than subtracts, which is the whole reason it is a separate stage', () => {
    // Subtract 0.3 from a track scoring 0.98 and it stays on top after the 300th play;
    // multiply by 0.1 and it leaves, while the order of everything else survives.
    const board = modify(boardOf(0.98), [fatigue(0.1)], set, ctx, policyWith())

    expect(board.base(0)).toBeCloseTo(0.98)
    expect(board.final(0)).toBeCloseTo(0.098)
  })

  it('carries the original contributions through the rebuild, so the explanation survives', () => {
    // Variant (a): the board is reopened through contributions(), which is only possible
    // because a board cannot hold a score without holding what produced it.
    const board = modify(boardOf(0.5), [fatigue(0.5)], set, ctx, policyWith())

    expect(board.contributions(0).map((c) => c.strategyId)).toEqual(['artist', 'fatigue'])
  })

  it('returns the board untouched when there is nothing to modify', () => {
    const original = boardOf(0.5)
    expect(modify(original, [], set, ctx, policyWith())).toBe(original)
  })

  it('fails the request when a modifier throws under strict', () => {
    expect(failure(() => modify(boardOf(0.5), [fatigue(0.1, 0)], set, ctx, policyWith('strict'))).code).toBe(
      'PORT_FAILED',
    )
  })

  it('discards every contribution of a modifier that threw partway, rather than half-damping the feed', () => {
    // The bug this guards: fatigue applied to row 0, threw on row 1, and half the feed
    // comes back damped and half does not — silently, under a policy called "degrade".
    const policy = policyWith('degrade')
    const board = modify(boardOf(0.8), [fatigue(0.1, 1)], set, ctx, policy)

    expect(board.final(0)).toBeCloseTo(0.8)
    expect(board.final(1)).toBeCloseTo(0.8)
    expect(board.contributions(0).map((c) => c.strategyId)).toEqual(['artist'])
    expect(policy.diagnostics.collected[0]?.message).toMatch(/every contribution it made was discarded/)
  })

  it('lets the surviving modifiers apply when one is dropped', () => {
    const boost: ScoreModifier = {
      id: 'boost',
      kind: 'boost',
      apply: (board) => {
        for (let row = 0; row < board.rows; row++) {
          board.add(row, contributionOf(strategyId('boost'), 'boost', 0.1, 0.1, 1))
        }
      },
    }

    const board = modify(boardOf(0.5), [fatigue(0.1, 0), boost], set, ctx, policyWith('degrade'))
    expect(board.final(0)).toBeCloseTo(0.6)
  })

  it('rejects a non-finite contribution at the moment the modifier makes it', () => {
    // Caught inside the modifier's own try, so the policy can name it — and before
    // anything of its was committed.
    const nan: ScoreModifier = {
      id: 'broken',
      kind: 'multiplicative',
      apply: (board) =>
        board.add(0, contributionOf(strategyId('broken'), 'multiplicative', 1, Number.NaN, 1)),
    }

    expect(failure(() => modify(boardOf(0.5), [nan], set, ctx, policyWith('strict'))).code).toBe(
      'PORT_FAILED',
    )
  })

  it('rejects a row the modifier invented', () => {
    const stray: ScoreModifier = {
      id: 'stray',
      kind: 'boost',
      apply: (board) => board.add(99, contributionOf(strategyId('stray'), 'boost', 1, 1, 1)),
    }

    // The wrapper names who; the cause says what. Both matter in an incident.
    const error = failure(() => modify(boardOf(0.5), [stray], set, ctx, policyWith('strict')))
    expect(error.message).toContain('stray')
    expect((error.cause as RecoError).message).toMatch(/out of range/i)
  })

  it('degrades a NaN-producing modifier to neutral rather than poisoning the board', () => {
    const nan: ScoreModifier = {
      id: 'broken',
      kind: 'multiplicative',
      apply: (board) =>
        board.add(0, contributionOf(strategyId('broken'), 'multiplicative', 1, Number.NaN, 1)),
    }

    const board = modify(boardOf(0.5), [nan], set, ctx, policyWith('degrade'))
    expect(board.final(0)).toBeCloseTo(0.5)
  })
})
