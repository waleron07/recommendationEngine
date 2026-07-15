import { describe, expect, it } from 'vitest'
import { exponentialDecay, gaussianDecay, linearDecay, recovery } from './decay.js'

const CURVES = [
  ['exponential', (age: number) => exponentialDecay(age, 30)],
  ['linear', (age: number) => linearDecay(age, 30)],
  ['gaussian', (age: number) => gaussianDecay(age, 30)],
] as const

describe('every curve', () => {
  it.each(CURVES)('%s starts at 1 and stays within [0..1]', (_label, curve) => {
    expect(curve(0)).toBe(1)
    for (let age = 0; age <= 365; age++) {
      const value = curve(age)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it.each(CURVES)('%s never rises as things age', (_label, curve) => {
    // A decay that goes up somewhere is not a decay, and the strategy reading it would be
    // quietly promoting the old.
    for (let age = 1; age <= 365; age++) {
      expect(curve(age)).toBeLessThanOrEqual(curve(age - 1))
    }
  })

  it.each(CURVES)('%s treats a negative age as "not yet"', (_label, curve) => {
    // Clock skew of a second between two servers should not promote a track.
    expect(curve(-1)).toBe(1)
    expect(curve(-1_000_000)).toBe(1)
  })

  it.each([
    ['exponential', (bad: number) => exponentialDecay(10, bad)],
    ['linear', (bad: number) => linearDecay(10, bad)],
    ['gaussian', (bad: number) => gaussianDecay(10, bad)],
  ] as const)('%s refuses a non-positive parameter', (_label, curve) => {
    // Zero divides by zero; a negative one makes the score rise with age, which is the
    // opposite of the thing being asked for.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => curve(bad)).toThrow(RangeError)
    }
  })
})

describe('exponentialDecay', () => {
  it('halves every half-life, which is the point of stating it that way', () => {
    // "Interest halves every 30 days" is a claim a product owner can argue with.
    // λ = 0.0231 is a number nobody can argue with, which is how it survives three years.
    expect(exponentialDecay(30, 30)).toBeCloseTo(0.5, 10)
    expect(exponentialDecay(60, 30)).toBeCloseTo(0.25, 10)
    expect(exponentialDecay(90, 30)).toBeCloseTo(0.125, 10)
  })

  it('never quite reaches zero', () => {
    // A track from 2009 keeps a whisper of weight forever. If that is wrong for you,
    // linearDecay is the one with a real end.
    expect(exponentialDecay(3_650, 30)).toBeGreaterThan(0)
  })
})

describe('linearDecay', () => {
  it('falls in a straight line', () => {
    expect(linearDecay(15, 30)).toBeCloseTo(0.5, 10)
    expect(linearDecay(7.5, 30)).toBeCloseTo(0.75, 10)
  })

  it('reaches zero at the span and stays there', () => {
    expect(linearDecay(30, 30)).toBe(0)
    expect(linearDecay(31, 30)).toBe(0)
    expect(linearDecay(10_000, 30)).toBe(0)
  })
})

describe('gaussianDecay', () => {
  it('holds a plateau where exponential is already falling', () => {
    // The whole reason to choose it: "this week is all equally recent, last month is not".
    expect(gaussianDecay(1, 30)).toBeGreaterThan(exponentialDecay(1, 30))
    expect(gaussianDecay(1, 30)).toBeGreaterThan(0.999)
  })

  it('falls away faster than exponential once it starts', () => {
    expect(gaussianDecay(90, 30)).toBeLessThan(exponentialDecay(90, 30))
  })

  it('is about 0.6 at one sigma', () => {
    expect(gaussianDecay(30, 30)).toBeCloseTo(Math.exp(-0.5), 10)
  })
})

describe('recovery', () => {
  it('starts at the floor and climbs back to 1', () => {
    // Fatigue says how far down; this says how long back. Without it the library shrinks
    // with every listen, and whoever loved a track most never hears it again.
    expect(recovery(0, 30, 0.1)).toBe(0.1)
    expect(recovery(15, 30, 0.1)).toBeCloseTo(0.55, 10)
    expect(recovery(30, 30, 0.1)).toBe(1)
  })

  it('stays at 1 once recovered', () => {
    expect(recovery(100, 30, 0.1)).toBe(1)
  })

  it('never falls', () => {
    for (let elapsed = 1; elapsed <= 60; elapsed++) {
      expect(recovery(elapsed, 30, 0.1)).toBeGreaterThanOrEqual(recovery(elapsed - 1, 30, 0.1))
    }
  })

  it('treats a floor of 1 as nothing to recover from', () => {
    expect(recovery(0, 30, 1)).toBe(1)
    expect(recovery(15, 30, 1)).toBe(1)
  })

  it('is the mirror of decay: from a floor of 0 it is linear', () => {
    expect(recovery(15, 30, 0)).toBeCloseTo(1 - linearDecay(15, 30), 10)
  })

  it.each([-0.1, 1.1, Number.NaN])('refuses the floor %s', (floor) => {
    expect(() => recovery(10, 30, floor)).toThrow(RangeError)
  })
})
