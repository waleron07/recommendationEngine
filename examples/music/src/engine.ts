import {
  type CandidateProvider,
  CLOCK,
  type Clock,
  createEngine,
  eventId,
  itemId,
  type RecommendationEngine,
  timestamp,
  userId,
} from '@recoengine/core'
import { attributeQuotaDiversifier } from '@recoengine/diversity'
import { interactionCountExtractor, interactionRecencyExtractor } from '@recoengine/features'
import { fatigueModifier } from '@recoengine/modifiers'
import {
  affinityStrategy,
  historyStrategy,
  popularityStrategy,
  recencyStrategy,
} from '@recoengine/strategies'
import { CATALOGUE, HISTORY, NOW, type PlayEvent, type Track } from './catalogue.js'
import {
  artistAffinityExtractor,
  artistGroupExtractor,
  genreAffinityExtractor,
  itemAgeExtractor,
  popularityExtractor,
} from './extractors.js'

/**
 * A complete music recommender — and the acceptance test for domain independence (§22, §10).
 *
 * Read what is imported: five domain extractors from this example, and *everything else*
 * (`createEngine`, the strategies, the modifier, the diversifier, the history features) from
 * the published packages, untouched. The engine core has no idea music exists. That the
 * whole thing type-checks and runs is the proof the abstraction does not leak.
 */
export function buildMusicEngine(now: number = NOW): RecommendationEngine<Track> {
  const clock: Clock = { now: () => timestamp(now) }

  const provider: CandidateProvider<Track> = {
    id: 'music-library',
    version: '1.0.0',
    provide: async (_ctx, budget) =>
      CATALOGUE.slice(0, budget.maxItems).map((entry) => ({
        id: itemId(entry.id),
        type: 'track',
        payload: entry.track,
      })),
  }

  return (
    createEngine<Track>()
      .provide(CLOCK, clock)
      // Domain: turns tracks into numbers.
      .use(provider)
      .use(popularityExtractor)
      .use(itemAgeExtractor)
      .use(artistAffinityExtractor)
      .use(genreAffinityExtractor)
      .use(artistGroupExtractor)
      // Domain-neutral, off the shelf: interaction features from history.
      .use(interactionCountExtractor())
      .use(interactionRecencyExtractor({ halfLife: 30 }))
      // Standard strategies — three lines of config where the original spec had three classes.
      .use(affinityStrategy({ id: 'artist', feature: 'affinity_artist' }))
      .use(affinityStrategy({ id: 'genre', feature: 'affinity_genre' }))
      .use(popularityStrategy({ cohortFeature: null }))
      .use(recencyStrategy({ halfLife: 365 }))
      .use(historyStrategy())
      // A track played into the ground gets damped, not banned (multiplicative, §15).
      .use(fatigueModifier({ threshold: 2, halfLife: 3 }))
      // No more than two tracks by one artist in the feed (§14), via the categorical column.
      .use(attributeQuotaDiversifier({ feature: 'artist_group', max: 2 }))
      .configure({
        limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 },
        weights: { artist: 0.9, genre: 0.6, popularity: 0.3, recency: 0.3, history: 1.0 },
      })
      .build()
  )
}

/** Turns the catalogue's compact history into the engine's `History` shape. */
export function historyOf(events: readonly PlayEvent[] = HISTORY, now: number = NOW) {
  const DAY = 86_400_000
  return {
    userId: userId('u1'),
    events: events.map((event, i) => ({
      id: eventId(`e${i}`),
      userId: userId('u1'),
      itemId: itemId(event.itemId),
      type: 'play',
      at: timestamp(now - event.daysAgo * DAY),
    })),
  }
}

/** A ready-to-run request for the example user. */
export function listenRequest(now: number = NOW) {
  return {
    user: { id: userId('u1'), payload: {} as Track },
    history: historyOf(HISTORY, now),
    limit: 10,
    explain: 'reasons' as const,
  }
}
