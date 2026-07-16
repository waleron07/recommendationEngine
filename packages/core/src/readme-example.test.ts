/**
 * The README example, verbatim, under test.
 *
 * §21 asks for the document's examples to become a compiling test at stage 11, and the
 * 0.4 revision learned why the hard way: an example that does not run is worse than no
 * example, because people copy it. A README is the first thing anyone runs and the last
 * thing anyone re-checks, so it gets a machine to do the re-checking.
 *
 * If you change the example in README.md, change it here. If this file stops compiling,
 * the README is lying.
 */
import { describe, expect, it } from 'vitest'
import {
  type CandidateProvider,
  createEngine,
  type FeatureExtractor,
  featureKey,
  itemId,
  type PreFilter,
  rank,
  type ScoringStrategy,
  strategyId,
  userId,
} from './index.js'

interface Track {
  readonly title: string
  readonly plays: number
}

const POPULARITY = featureKey('popularity')

/** Stands in for the reader's database. The only thing the README elides. */
const db = {
  tracks: {
    findMany: async ({ take }: { take: number }) =>
      [
        { id: 'a', title: 'Quiet One', plays: 12 },
        { id: 'b', title: 'The Hit', plays: 4_200_000 },
        { id: 'c', title: 'Middling', plays: 900 },
      ].slice(0, take),
  },
}

const library: CandidateProvider<Track> = {
  id: 'library',
  version: '1.0.0',
  provide: async (_ctx, budget) => {
    const rows = await db.tracks.findMany({ take: budget.maxItems })
    return rows.map((row) => ({
      id: itemId(row.id),
      type: 'track',
      payload: { title: row.title, plays: row.plays },
    }))
  },
}

const notPlayedYet: PreFilter<Track> = {
  id: 'not-played-yet',
  failClosed: true,
  approve: (candidate, ctx) => !ctx.history.hasSeen(candidate.item.id),
}

const popularity: FeatureExtractor<Track> = {
  id: 'popularity-extractor',
  version: '1.0.0',
  provides: [
    {
      key: POPULARITY,
      kind: 'numeric',
      defaultValue: 0,
      description: 'lifetime play count',
      owner: 'popularity-extractor',
      ownerVersion: '1.0.0',
    },
  ],
  extract: async (set, out) => {
    const column = out.columnMut(POPULARITY)
    for (let row = 0; row < set.size; row++) column[row] = set.at(row).item.payload.plays
  },
}

const popular: ScoringStrategy = {
  id: strategyId('popularity'),
  requires: [POPULARITY],
  normalizer: rank,
  score: (view) => ({
    strategyId: strategyId('popularity'),
    raw: view.items.column(POPULARITY),
    reasons: new Map(),
  }),
}

const build = () =>
  createEngine<Track>()
    .use(library)
    .use(notPlayedYet)
    .use(popularity)
    .use(popular)
    .configure({
      limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 },
      weights: { popularity: 1.0 },
    })
    .build()

const listen = () => ({
  user: { id: userId('u1'), payload: {} },
  history: { userId: userId('u1'), events: [] },
  limit: 10,
  explain: 'reasons' as const,
})

describe('the README example', () => {
  it('builds and recommends exactly as written', async () => {
    const result = await build().recommend(listen())

    expect(result.recommendations.map((r) => [r.rank, r.item.payload.title, r.score])).toEqual([
      [1, 'The Hit', 100],
      [2, 'Middling', 50],
      [3, 'Quiet One', 0],
    ])
  })

  it('explains itself with the contributions the README prints', async () => {
    const [top] = (await build().recommend(listen())).recommendations

    expect(top?.explanation.contributions).toEqual([
      expect.objectContaining({ strategyId: 'popularity', raw: 4_200_000, contribution: 1 }),
    ])
  })

  it('returns the diagnostics the README shows, with the keys it names', async () => {
    const { diagnostics } = await build().recommend(listen())

    expect(Object.keys(diagnostics).sort()).toEqual([
      'filtered',
      'retrieved',
      'stages',
      'totalMs',
      'warnings',
    ])
    expect(diagnostics.retrieved).toBe(3)
    expect(diagnostics.warnings).toEqual([])
  })

  it('shows what `rank` buys the strategy: one viral track does not flatten the rest', async () => {
    // The README claims this is why the strategy asks for `rank` rather than min-max.
    // Under min-max, 900 plays against 4.2M would normalize to 0.0002 — indistinguishable
    // from the 12-play track. Under rank it is 0.5, which is what the numbers above show.
    const result = await build().recommend(listen())
    expect(result.recommendations[1]?.score).toBe(50)
  })
})
