import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RecoError } from '../kernel/errors.js'
import { strategyId } from './ids.js'
import { contributionOf, ScoreBoardBuilder } from './score.js'

const S = (id: string) => strategyId(id)

describe('ScoreBoardBuilder', () => {
  it('reproduces the worked example from ARCHITECTURE.md §16 exactly', () => {
    // The document's flagship example. If this drifts, either the code or the doc is
    // lying to readers, and the test says which.
    const board = new ScoreBoardBuilder(1)
      .add(0, contributionOf(S('artist'), 'additive', 143, 0.98, 0.9))
      .add(0, contributionOf(S('history'), 'additive', 12, 0.86, 1.0))
      .add(0, contributionOf(S('genre'), 'additive', 0.85, 0.85, 0.6))
      .add(0, contributionOf(S('popularity'), 'additive', 4.2e6, 0.8, 0.3))
      .add(0, contributionOf(S('novelty'), 'multiplicative', 1.07, 1.07, 1))
      .build()

    expect(board.base(0)).toBeCloseTo(0.89, 4)
    expect(Math.round(board.final(0) * 100)).toBe(95)
  })

  it('keeps Σ additive contributions equal to base × Σ weights — the §21 criterion', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0.01, max: 2, noNaN: true })),
          { minLength: 1, maxLength: 8 },
        ),
        (pairs) => {
          const builder = new ScoreBoardBuilder(1)
          for (const [normalized, weight] of pairs) {
            builder.add(0, contributionOf(S('s'), 'additive', normalized, normalized, weight))
          }
          const board = builder.build()

          const sumContributions = board.contributions(0).reduce((a, c) => a + c.contribution, 0)
          const sumWeights = pairs.reduce((a, [, w]) => a + w, 0)

          expect(board.base(0)).toBeCloseTo(sumContributions / sumWeights, 10)
        },
      ),
    )
  })

  it('normalises by Σ weights, so adding a strategy does not rescale the others', () => {
    // Without the division, a ninth strategy silently shifts every score and a tuned
    // `score > 80 → push` threshold quietly starts meaning something else.
    const two = new ScoreBoardBuilder(1)
      .add(0, contributionOf(S('a'), 'additive', 1, 1.0, 1))
      .add(0, contributionOf(S('b'), 'additive', 1, 1.0, 1))
      .build()

    const five = new ScoreBoardBuilder(1)
      .add(0, contributionOf(S('a'), 'additive', 1, 1.0, 1))
      .add(0, contributionOf(S('b'), 'additive', 1, 1.0, 1))
      .add(0, contributionOf(S('c'), 'additive', 1, 1.0, 1))
      .add(0, contributionOf(S('d'), 'additive', 1, 1.0, 1))
      .add(0, contributionOf(S('e'), 'additive', 1, 1.0, 1))
      .build()

    expect(two.base(0)).toBe(1)
    expect(five.base(0)).toBe(1)
  })

  it('reweights automatically when a strategy sits the request out', () => {
    // This is how cold start degrades: HistoryStrategy declares applicable() === false,
    // never contributes, and its weight leaves both sums. No `if (isNewUser)` anywhere.
    const withHistory = new ScoreBoardBuilder(1)
      .add(0, contributionOf(S('history'), 'additive', 0, 0.0, 1.0))
      .add(0, contributionOf(S('popularity'), 'additive', 1, 1.0, 0.3))
      .build()

    const withoutHistory = new ScoreBoardBuilder(1)
      .add(0, contributionOf(S('popularity'), 'additive', 1, 1.0, 0.3))
      .build()

    expect(withHistory.base(0)).toBeCloseTo(0.3 / 1.3, 10)
    expect(withoutHistory.base(0)).toBe(1)
  })

  it('multiplies fatigue instead of subtracting it, so a top score can actually fall', () => {
    const loved = contributionOf(S('affinity'), 'additive', 1, 0.98, 1)

    const subtracted = new ScoreBoardBuilder(1)
      .add(0, loved)
      .add(0, contributionOf(S('fatigue'), 'boost', -0.3, -0.3, 1))
      .build()

    const multiplied = new ScoreBoardBuilder(1)
      .add(0, loved)
      .add(0, contributionOf(S('fatigue'), 'multiplicative', 0.1, 0.1, 1))
      .build()

    expect(subtracted.final(0)).toBeCloseTo(0.68, 6) // still near the top
    expect(multiplied.final(0)).toBeCloseTo(0.098, 6) // actually gone
  })

  it('lets veto zero a score outright', () => {
    const board = new ScoreBoardBuilder(1)
      .add(0, contributionOf(S('affinity'), 'additive', 1, 1.0, 1))
      .add(0, contributionOf(S('blocked'), 'veto', 0, 0, 1))
      .build()

    expect(board.base(0)).toBe(1)
    expect(board.final(0)).toBe(0)
  })

  it('clamps final into [0..1] however wild the boosts get', () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (boost) => {
        const board = new ScoreBoardBuilder(1)
          .add(0, contributionOf(S('a'), 'additive', 1, 0.5, 1))
          .add(0, contributionOf(S('b'), 'boost', boost, boost, 1))
          .build()

        expect(board.final(0)).toBeGreaterThanOrEqual(0)
        expect(board.final(0)).toBeLessThanOrEqual(1)
      }),
    )
  })

  it('scores an untouched row 0 rather than NaN', () => {
    // 0/0 is the natural result of "no strategy said anything". NaN here would sort
    // unpredictably and poison nothing visibly — the worst kind of bug.
    const board = new ScoreBoardBuilder(2).add(0, contributionOf(S('a'), 'additive', 1, 1, 1)).build()

    expect(board.base(1)).toBe(0)
    expect(board.final(1)).toBe(0)
    expect(board.contributions(1)).toEqual([])
  })

  it('refuses a non-finite contribution at the door', () => {
    const builder = new ScoreBoardBuilder(1)
    expect(() => builder.add(0, contributionOf(S('bad'), 'additive', 1, Number.NaN, 1))).toThrow(/non-finite/)
  })

  it('rejects out-of-range rows on write and on read', () => {
    expect(() => new ScoreBoardBuilder(1).add(5, contributionOf(S('a'), 'additive', 1, 1, 1))).toThrow(
      RecoError,
    )
    expect(() => new ScoreBoardBuilder(1).build().final(5)).toThrow(RecoError)
  })

  it('keeps every contribution for the explainer, including the ones that lost', () => {
    const board = new ScoreBoardBuilder(1)
      .add(
        0,
        contributionOf(S('artist'), 'additive', 143, 0.98, 0.9, [
          { code: 'favorite_artist', polarity: 'positive', strength: 0.98 },
        ]),
      )
      .add(0, contributionOf(S('popularity'), 'additive', 4.2e6, 0.8, 0.3))
      .build()

    const contributions = board.contributions(0)
    expect(contributions).toHaveLength(2)
    expect(contributions[0]?.raw).toBe(143)
    expect(contributions[0]?.reasons[0]?.code).toBe('favorite_artist')
  })
})

describe('contributionOf', () => {
  it('weights additive contributions but leaves modifiers alone', () => {
    expect(contributionOf(S('a'), 'additive', 1, 0.5, 0.6).contribution).toBeCloseTo(0.3, 10)
    expect(contributionOf(S('a'), 'multiplicative', 1, 0.5, 0.6).contribution).toBe(0.5)
  })
})
