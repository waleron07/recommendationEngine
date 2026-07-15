import type { Rng } from '../ports/infra.js'

/**
 * Deterministic PRNG. The engine's only source of randomness.
 *
 * `Math.random()` is disqualified by one property: it cannot be seeded. Exploration
 * through it is unreplayable, an A/B test over it measures the scheduler's mood rather
 * than the variant, and a bug report saying "this user got a strange feed" can never be
 * reproduced. §23.4 rules it out, and this file is what makes that a fact.
 *
 * **This is xoshiro128\*\*, not the xoroshiro128+ named in §23.4** — same authors, same
 * family, chosen deliberately. xoroshiro128+ is a 64-bit generator, and JavaScript has no
 * 64-bit integers: it would need BigInt (allocating, roughly an order of magnitude slower,
 * on a path that runs per candidate) or hand-rolled 32-bit limb arithmetic, which is
 * forty lines of shift-and-carry I would have to trust without the reference vectors to
 * check it against. xoshiro128** is designed for exactly this case — four 32-bit words,
 * `Math.imul` and shifts, all of it native — and it delivers what the engine actually
 * needs from the requirement: seedable, reproducible, fast, and no environment API.
 *
 * Not cryptographic, and never to be used as such: the state is recoverable from the
 * output. It picks recommendations; it does not keep secrets.
 */
export class Xoshiro128 implements Rng {
  /**
   * Kept so `fork()` can be a pure function of the seeds.
   *
   * This is the load-bearing detail of the whole class. If `fork(child)` derived from the
   * parent's *current state*, the stream a user got would depend on how many times the
   * parent had been drawn from before their request arrived — so the same user on the same
   * day would land in a different bucket depending on traffic. Reproducibility would be a
   * function of load, which is another way of saying there would be none.
   */
  readonly seed: string

  private s0: number
  private s1: number
  private s2: number
  private s3: number

  constructor(seed: string) {
    this.seed = seed

    // splitmix32 expands one word into four uncorrelated ones. Seeding xoshiro directly
    // from a hash would leave neighbouring seeds ("u1", "u2") with near-identical state,
    // and the first few outputs visibly related — which for per-user forks is the one
    // thing that must not happen.
    const mix = splitmix32(fnv1a(seed))
    this.s0 = mix()
    this.s1 = mix()
    this.s2 = mix()
    this.s3 = mix()

    // All-zero state is xoshiro's one fixed point: it would emit zeros forever.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1
  }

  /** Uniform in [0, 1). 32 bits of randomness, divided into the unit interval. */
  next(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9)
    const t = this.s1 << 9

    this.s2 ^= this.s0
    this.s3 ^= this.s1
    this.s1 ^= this.s2
    this.s0 ^= this.s3
    this.s2 ^= t
    this.s3 = rotl(this.s3, 11)

    // Divided by 2^32 rather than masked into a smaller range: the result lands on a
    // 32-bit grid in [0, 1), and 1 is never reached, which is what callers assume.
    return (result >>> 0) / 0x1_0000_0000
  }

  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      // Silently returning 0 would make `int(0)` look like a working call that always
      // picks the first bucket — a bug that reads as a preference.
      throw new RangeError(`Rng.int needs a positive integer bound, got ${maxExclusive}.`)
    }
    return Math.floor(this.next() * maxExclusive)
  }

  /**
   * A stream derived from this one and `seed`, deterministically.
   *
   * Same parent seed and same child seed, same stream — always, regardless of what either
   * has drawn. That is what lets the engine fork per user and still promise that the same
   * user on the same day gets the same exploration bucket.
   */
  fork(seed: string): Rng {
    return new Xoshiro128(`${this.seed}/${seed}`)
  }
}

/** Rotate left, 32-bit. */
function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits))
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a, as in `feature.ts`: string → one 32-bit word to seed the mixer with. */
function fnv1a(input: string): number {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** splitmix32: one word in, a stream of well-distributed words out. */
function splitmix32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x9e3779b9) | 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    return (z ^ (z >>> 15)) >>> 0
  }
}
