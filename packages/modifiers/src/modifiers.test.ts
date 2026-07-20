/**
 * Golden and curve tests for the stage-8 modifiers (§22: "кривые затухания и восстановления").
 *
 * Two lenses. `saturationOf` is tested directly against a hand-built history. The three
 * modifiers are driven through a real `createEngine(...).recommend(...)` over a constant
 * base score, so the base is flat and every score movement is the modifier's doing —
 * which makes fatigue's decay, its recovery over time, novelty's saturation scaling, and
 * boost's additive nudge all directly observable in the ranking.
 */
import { CLOCK, createEngine, MapHistoryIndex, userId } from '@recoengine/core'
import {
  assertScoreModifier,
  constantStrategy,
  events,
  fixedClock,
  historyOf,
  itemsOf,
  request,
  TEST_LIMITS,
} from '@recoengine/testing'
import { describe, expect, it } from 'vitest'
import { boostModifier, fatigueModifier, noveltyModifier, saturationOf } from './index.js'

const DAY = 86_400_000
const NOW = 1_000_000_000_000
const clock = fixedClock(NOW)

// Fixtures come from @recoengine/testing (Этап 6а); thin aliases keep the tests reading as
// before while the synthetic base strategy, provider, clock and history builders moved to the kit.
const base = constantStrategy
const provider = itemsOf
const LIMITS = { limits: TEST_LIMITS }
const plays = (id: string, count: number, at: number = NOW) => events(id, count, { at })
const listen = (evts: readonly unknown[]) => request({ history: historyOf(evts as never) })

const byId = (recommendations: readonly { item: { id: string }; score: number }[]) =>
  new Map(recommendations.map((r) => [r.item.id as string, r.score]))

describe('saturationOf', () => {
  const history = (list: readonly unknown[]) =>
    new MapHistoryIndex({ userId: userId('u'), events: list as never })

  it('is 1 when every interaction lands on one item', () => {
    expect(saturationOf(history(plays('a', 10)), undefined)).toBe(1)
  })

  it('is ~0 when interactions are spread evenly across many items', () => {
    const even = ['a', 'b', 'c', 'd'].flatMap((id) => plays(id, 5))
    expect(saturationOf(history(even), undefined)).toBeCloseTo(0, 10)
  })

  it('is 0 for an empty history', () => {
    expect(saturationOf(history([]), undefined)).toBe(0)
  })

  it('sits between the extremes for a lopsided distribution', () => {
    const lopsided = [...plays('a', 90), ...plays('b', 10)]
    const s = saturationOf(history(lopsided), undefined)
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
  })
})

describe('fatigueModifier', () => {
  const engine = (mod = fatigueModifier()) =>
    createEngine()
      .provide(CLOCK, clock)
      .use(provider(['heavy', 'light']))
      .use(base(0.5))
      .use(mod)
      .configure(LIMITS)
      .build()

  it('damps an over-played item below an untouched one, and multiplicatively', async () => {
    const { recommendations } = await engine().recommend(listen(plays('heavy', 100)))
    const scores = byId(recommendations)
    expect(Math.round(scores.get('light') as number)).toBe(50) // untouched: base × 1
    expect(Math.round(scores.get('heavy') as number)).toBe(5) // 0.5 × (0.1 + 0.9·2^-9)
    expect(recommendations[0]?.item.id).toBe('light')
  })

  it('deepens monotonically with the interaction count', async () => {
    const at = (count: number) =>
      engine()
        .recommend(listen(plays('heavy', count)))
        .then((r) => byId(r.recommendations).get('heavy') as number)
    const [none, some, lots] = await Promise.all([at(0), at(20), at(100)])
    expect(none).toBe(50) // below threshold → no damp
    expect(some).toBeLessThan(none)
    expect(lots).toBeLessThan(some)
  })

  it('recovers over time: the same play count long ago barely bites', async () => {
    const recent = byId((await engine().recommend(listen(plays('heavy', 100, NOW)))).recommendations).get(
      'heavy',
    ) as number
    const old = byId(
      (await engine().recommend(listen(plays('heavy', 100, NOW - 400 * DAY)))).recommendations,
    ).get('heavy') as number
    expect(Math.round(recent)).toBe(5)
    expect(Math.round(old)).toBe(50) // effective count decayed below threshold — fully recovered
    expect(old).toBeGreaterThan(recent)
  })

  it('explains itself with the raw play count', async () => {
    const { recommendations } = await engine().recommend(listen(plays('heavy', 100)))
    const heavy = recommendations.find((r) => r.item.id === 'heavy')
    expect(heavy?.explanation.reasons).toContainEqual(
      expect.objectContaining({ code: 'fatigued', params: expect.objectContaining({ count: 100 }) }),
    )
  })

  it('cannot damp past its floor', async () => {
    const { recommendations } = await engine(fatigueModifier({ floor: 0.2 })).recommend(
      listen(plays('heavy', 10_000)),
    )
    // base 0.5 × floor 0.2 = 0.1 → 10, and never below.
    expect(Math.round(byId(recommendations).get('heavy') as number)).toBe(10)
  })
})

describe('noveltyModifier', () => {
  const engine = (mod = noveltyModifier()) =>
    createEngine()
      .provide(CLOCK, clock)
      .use(provider(['seen', 'fresh']))
      .use(base(0.5))
      .use(mod)
      .configure(LIMITS)
      .build()

  it('boosts the unfamiliar when the profile is saturated', async () => {
    // History is 20 plays of one item → saturation 1. "seen" is that item; "fresh" is new.
    const { recommendations } = await engine().recommend(listen(plays('seen', 20)))
    const scores = byId(recommendations)
    expect(recommendations[0]?.item.id).toBe('fresh')
    expect(Math.round(scores.get('fresh') as number)).toBe(75) // 0.5 × (1 + 1·0.5·1)
    expect(scores.get('seen') as number).toBeLessThan(scores.get('fresh') as number)
    expect(recommendations[0]?.explanation.reasons).toContainEqual(
      expect.objectContaining({ code: 'novelty_boost' }),
    )
  })

  it('self-regulates: a broad profile earns no boost', async () => {
    const even = ['p', 'q', 'r', 's', 't'].flatMap((id) => plays(id, 4)) // saturation ≈ 0
    const { recommendations } = await engine().recommend(listen(even))
    const scores = byId(recommendations)
    expect(Math.round(scores.get('fresh') as number)).toBe(50)
    expect(Math.round(scores.get('seen') as number)).toBe(50)
  })

  it('scales the boost with saturation', async () => {
    const saturated = byId((await engine().recommend(listen(plays('seen', 20)))).recommendations).get(
      'fresh',
    ) as number
    const lopsided = byId(
      (await engine().recommend(listen([...plays('seen', 15), ...plays('x', 5), ...plays('y', 5)])))
        .recommendations,
    ).get('fresh') as number
    expect(saturated).toBeGreaterThan(lopsided) // more saturated profile → stronger novelty push
    expect(lopsided).toBeGreaterThan(50)
  })
})

describe('boostModifier', () => {
  const engine = (mod: ReturnType<typeof boostModifier>) =>
    createEngine()
      .provide(CLOCK, clock)
      .use(provider(['a', 'b', 'c']))
      .use(base(0.5))
      .use(mod)
      .configure(LIMITS)
      .build()

  it('lifts a pinned item by a flat additive amount', async () => {
    const { recommendations } = await engine(boostModifier({ items: ['b'], amount: 0.3 })).recommend(
      listen([]),
    )
    const scores = byId(recommendations)
    expect(recommendations[0]?.item.id).toBe('b')
    expect(Math.round(scores.get('b') as number)).toBe(80) // 0.5 + 0.3
    expect(Math.round(scores.get('a') as number)).toBe(50)
    expect(recommendations[0]?.explanation.reasons).toContainEqual(
      expect.objectContaining({ code: 'boosted' }),
    )
  })

  it('penalises with a negative amount, without removing the item', async () => {
    const { recommendations } = await engine(boostModifier({ items: ['b'], amount: -0.3 })).recommend(
      listen([]),
    )
    const scores = byId(recommendations)
    expect(scores.has('b')).toBe(true) // penalised, not filtered
    expect(Math.round(scores.get('b') as number)).toBe(20) // 0.5 − 0.3
    expect(recommendations.find((r) => r.item.id === 'b')?.explanation.reasons).toContainEqual(
      expect.objectContaining({ code: 'penalized' }),
    )
  })

  it('selects by predicate as well as by id set', async () => {
    const { recommendations } = await engine(
      boostModifier({ select: (candidate) => candidate.item.id === 'c', amount: 0.4 }),
    ).recommend(listen([]))
    expect(recommendations[0]?.item.id).toBe('c')
    expect(Math.round(byId(recommendations).get('c') as number)).toBe(90)
  })

  it('refuses to build a boost that selects nothing', () => {
    expect(() => boostModifier({ amount: 0.5 })).toThrow()
  })
})

// Each modifier is also run through the reusable port contracts (@recoengine/testing):
// well-formed scores, determinism and cancellation (§17.1). Dogfoods the kit on the real
// modifiers — a multiplicative NaN or a boost past the clamp would surface here.
describe('port-contract conformance', () => {
  const history = historyOf(plays('a', 50))

  it('fatigue', () => assertScoreModifier(fatigueModifier(), { ids: ['a', 'b', 'c'], history, now: NOW }))
  it('novelty', () => assertScoreModifier(noveltyModifier(), { ids: ['a', 'b', 'c'], history, now: NOW }))
  it('boost', () =>
    assertScoreModifier(boostModifier({ items: ['a'], amount: 0.3 }), { ids: ['a', 'b', 'c'] }))
})
