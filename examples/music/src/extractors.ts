import { type FeatureDescriptor, type FeatureExtractor, featureKey } from '@recoengine/core'
import { byId, type Track } from './catalogue.js'

/**
 * The domain extractors — the whole of the music-specific code. Each reads `Track` payloads
 * (or the history keyed by the track catalogue) and writes a column of numbers the standard
 * strategies consume. Nothing below this line knows a track from a toaster.
 *
 * This is the seam the architecture is built around: swap these five extractors for a
 * catalogue of products and the same strategies, modifiers and diversifiers recommend
 * e-commerce, with the core untouched. Stage 10 proves exactly that.
 */

const numeric = (key: string, owner: string, description: string): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description,
  owner,
  ownerVersion: '1.0.0',
})

const DAY = 86_400_000

/** Reads `payload.plays` straight into `popularity_global`. The one truly trivial extractor. */
export const popularityExtractor: FeatureExtractor<Track> = {
  id: 'music-popularity',
  version: '1.0.0',
  provides: [numeric('popularity_global', 'music-popularity', 'lifetime plays')],
  extract: async (set, out) => {
    const column = out.columnMut(featureKey('popularity_global'))
    for (let row = 0; row < set.size; row++) column[row] = set.at(row).item.payload.plays
  },
}

/** `item_age` in days, from the release timestamp and `ctx.now`. Feeds the recency strategy. */
export const itemAgeExtractor: FeatureExtractor<Track> = {
  id: 'music-age',
  version: '1.0.0',
  provides: [numeric('item_age', 'music-age', 'days since release')],
  extract: async (set, out, ctx) => {
    const column = out.columnMut(featureKey('item_age'))
    for (let row = 0; row < set.size; row++) {
      column[row] = (ctx.now - set.at(row).item.payload.releasedAt) / DAY
    }
  },
}

/**
 * `affinity_artist`: how strongly the user's history favours *this track's artist*, in
 * [0..1] (their most-played artist is 1). This is where the domain earns its keep — it
 * knows a track has an artist and that history events map to tracks; the strategy that
 * consumes the column does not.
 */
export const artistAffinityExtractor: FeatureExtractor<Track> = {
  id: 'music-affinity-artist',
  version: '1.0.0',
  provides: [numeric('affinity_artist', 'music-affinity-artist', 'affinity to the track artist')],
  extract: async (set, out, ctx) => {
    // One pass over history, memoised: artist → play count. `byId` is the catalogue lookup
    // that turns an event's itemId into its artist — the domain knowledge the core lacks.
    const byArtist = ctx.history.aggregate('music:artist', (event) => byId.get(event.itemId)?.artistId)
    let max = 0
    for (const count of byArtist.values()) if (count > max) max = count

    const column = out.columnMut(featureKey('affinity_artist'))
    for (let row = 0; row < set.size; row++) {
      const artist = set.at(row).item.payload.artistId
      column[row] = max === 0 ? 0 : (byArtist.get(artist) ?? 0) / max
    }
  },
}

/**
 * `affinity_genre`: the user's affinity to a track's genres, in [0..1]. A track has several
 * genres, so this cannot use `aggregate` directly (that counts one key per event) — it sums
 * each played track's plays into every genre it belongs to, then normalizes.
 */
export const genreAffinityExtractor: FeatureExtractor<Track> = {
  id: 'music-affinity-genre',
  version: '1.0.0',
  provides: [numeric('affinity_genre', 'music-affinity-genre', 'affinity to the track genres')],
  extract: async (set, out, ctx) => {
    const byItem = ctx.history.aggregate('music:item', (event) => event.itemId)
    const byGenre = new Map<string, number>()
    for (const [itemId, count] of byItem) {
      for (const genre of byId.get(itemId)?.genres ?? []) {
        byGenre.set(genre, (byGenre.get(genre) ?? 0) + count)
      }
    }
    let max = 0
    for (const count of byGenre.values()) if (count > max) max = count

    const column = out.columnMut(featureKey('affinity_genre'))
    for (let row = 0; row < set.size; row++) {
      const genres = set.at(row).item.payload.genres
      // A track's genre affinity is its strongest genre, so a single loved genre lifts it.
      let best = 0
      for (const genre of genres) {
        const value = max === 0 ? 0 : (byGenre.get(genre) ?? 0) / max
        if (value > best) best = value
      }
      column[row] = best
    }
  },
}

/**
 * `artist_group`: a categorical hash of the artist, so the attribute-quota diversifier can
 * cap "no more than N tracks by one artist" through equality on the column (§14) — without
 * the diversifier ever learning what an artist is.
 */
export const artistGroupExtractor: FeatureExtractor<Track> = {
  id: 'music-artist-group',
  version: '1.0.0',
  provides: [
    {
      key: featureKey('artist_group'),
      kind: 'categorical',
      defaultValue: 0,
      description: 'hash of the artist id, for quota grouping',
      owner: 'music-artist-group',
      ownerVersion: '1.0.0',
    },
  ],
  extract: async (set, out) => {
    const column = out.columnMut(featureKey('artist_group'))
    for (let row = 0; row < set.size; row++) column[row] = hash(set.at(row).item.payload.artistId)
  },
}

/** A small stable string hash (FNV-1a, 32-bit) — equal strings give equal numbers. */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
