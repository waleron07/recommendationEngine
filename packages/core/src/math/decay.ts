/**
 * Decay curves: how much less something matters as it ages.
 *
 * Every function takes an `age` and a shape parameter **in the same unit** and returns a
 * weight in [0..1]. The unit is the caller's — days, milliseconds, plays — and the
 * functions never look at a clock, which is what makes them testable without one.
 *
 * A negative age returns 1. It means "not yet", and the alternative (extrapolating the
 * curve past its peak) would make a future event count for more than a present one — a
 * clock skew of one second between two servers should not promote a track.
 */

/**
 * Halves every `halfLife`. The default shape for recency and the usual right answer.
 *
 * Expressed as `2^(-age/halfLife)` rather than `e^(-λ·age)` for one reason: the parameter
 * is then a number a human can state and check. "Interest halves every 30 days" is a
 * claim a product owner can agree or disagree with; `λ = 0.0231` is a number nobody can
 * argue about, which is how a magic constant survives three years in a config file.
 */
export function exponentialDecay(age: number, halfLife: number): number {
  assertPositive('halfLife', halfLife)
  if (age <= 0) return 1
  return 2 ** (-age / halfLife)
}

/**
 * Straight line to zero at `span`, and zero after.
 *
 * The one with a real end. Exponential decay never quite reaches zero, so a track from
 * 2009 keeps a whisper of weight forever; if "older than a year is worth nothing" is the
 * rule you actually mean, this says it exactly and stops.
 */
export function linearDecay(age: number, span: number): number {
  assertPositive('span', span)
  if (age <= 0) return 1
  return Math.max(0, 1 - age / span)
}

/**
 * Flat near zero, then falls away: `e^(-age²/2σ²)`.
 *
 * The difference from exponential is the first few units, and it is the whole reason to
 * choose it: exponential starts dropping immediately, so yesterday already counts less
 * than today. Gaussian holds a plateau and then falls. For "this week is all equally
 * recent, last month is not", that plateau is the requirement.
 */
export function gaussianDecay(age: number, scale: number): number {
  assertPositive('scale', scale)
  if (age <= 0) return 1
  return Math.exp(-(age * age) / (2 * scale * scale))
}

/**
 * Recovery: the mirror of decay, from `floor` back to 1 over `span`.
 *
 * What fatigue needs and decay cannot express. A track played 300 times is damped now, but
 * it must be allowed back eventually or the library shrinks with every listen — the user
 * who loved something most ends up never hearing it again. Fatigue says how far down;
 * this says how long back.
 */
export function recovery(elapsed: number, span: number, floor: number): number {
  assertPositive('span', span)
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new RangeError(`recovery floor must be within [0..1], got ${floor}.`)
  }
  if (elapsed <= 0) return floor
  return floor + (1 - floor) * Math.min(1, elapsed / span)
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    // A half-life of 0 divides by zero and a negative one grows without bound: the score
    // would rise with age, which is the opposite of the thing being asked for.
    throw new RangeError(`${name} must be a positive finite number, got ${value}.`)
  }
}
