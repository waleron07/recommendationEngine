/**
 * The music domain: a tiny catalogue and a listening history.
 *
 * This is the *only* place that knows what a track is. Everything the engine does with it
 * flows through the domain extractors in `extractors.ts`, which turn these payloads into
 * numbers — the engine core never sees a `Track`.
 */

export interface Track {
  readonly title: string
  readonly artistId: string
  readonly artistName: string
  readonly genres: readonly string[]
  /** Lifetime plays across all users — the raw popularity signal. */
  readonly plays: number
  /** Release time, ms epoch. Feeds `item_age` → the recency strategy. */
  readonly releasedAt: number
}

export interface CatalogueEntry {
  readonly id: string
  readonly track: Track
}

const DAY = 86_400_000
/** A fixed "now" so the example is deterministic; the demo and tests pin the clock to it. */
export const NOW = 1_700_000_000_000

const t = (
  id: string,
  title: string,
  artistId: string,
  artistName: string,
  genres: readonly string[],
  plays: number,
  ageDays: number,
): CatalogueEntry => ({
  id,
  track: { title, artistId, artistName, genres, plays, releasedAt: NOW - ageDays * DAY },
})

/** Eight tracks, three artists, three genres — small enough to reason about by hand. */
export const CATALOGUE: readonly CatalogueEntry[] = [
  t('t1', 'Come Together', 'beatles', 'The Beatles', ['rock', 'classic'], 4_200_000, 20_000),
  t('t2', 'Here Comes the Sun', 'beatles', 'The Beatles', ['rock', 'folk'], 3_800_000, 19_800),
  t('t3', 'Yesterday', 'beatles', 'The Beatles', ['folk', 'classic'], 3_100_000, 20_100),
  t('t4', 'Bohemian Rhapsody', 'queen', 'Queen', ['rock', 'opera'], 5_000_000, 17_500),
  t('t5', "Don't Stop Me Now", 'queen', 'Queen', ['rock', 'pop'], 2_900_000, 17_400),
  t('t6', 'Redemption Song', 'marley', 'Bob Marley', ['reggae', 'folk'], 1_200_000, 16_000),
  t('t7', 'Three Little Birds', 'marley', 'Bob Marley', ['reggae', 'pop'], 900_000, 15_900),
  t('t8', 'Fresh Cut', 'newband', 'New Band', ['pop'], 500, 5),
]

/** Fast lookup for history aggregation: an event's `itemId` → its track. */
export const byId: ReadonlyMap<string, Track> = new Map(CATALOGUE.map((e) => [e.id, e.track]))

export interface PlayEvent {
  readonly itemId: string
  /** Days before `NOW`. */
  readonly daysAgo: number
}

/**
 * A user who mostly plays The Beatles, a bit of Queen, and one reggae track a while back.
 * Enough history to make the affinity and recency signals say something specific.
 */
export const HISTORY: readonly PlayEvent[] = [
  { itemId: 't1', daysAgo: 1 },
  { itemId: 't1', daysAgo: 3 },
  { itemId: 't2', daysAgo: 2 },
  { itemId: 't2', daysAgo: 10 },
  { itemId: 't3', daysAgo: 40 },
  { itemId: 't4', daysAgo: 5 },
  { itemId: 't6', daysAgo: 120 },
]
