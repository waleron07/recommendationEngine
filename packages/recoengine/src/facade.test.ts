/**
 * The facade re-exports everything, and a built engine proves it.
 *
 * `npm i recoengine` is meant to be all a caller needs: the core *and* the standard
 * plugins, from one import. This wires a real engine using pieces pulled from every
 * battery through the facade alone — if any re-export were missing, this file would not
 * compile, and if the wiring were wrong, it would not run.
 */
import { describe, expect, it } from 'vitest'
import {
  cosineSimilarity,
  createEngine,
  fatigueModifier,
  featureKey,
  interactionCountExtractor,
  itemId,
  mmrDiversifier,
  popularityStrategy,
  userId,
} from './index.js'

describe('recoengine facade', () => {
  it('exposes the core and every battery from one import', () => {
    // A pinch from each package: core, strategies, modifiers, features, diversity.
    expect(typeof createEngine).toBe('function')
    expect(typeof popularityStrategy).toBe('function')
    expect(typeof fatigueModifier).toBe('function')
    expect(typeof interactionCountExtractor).toBe('function')
    expect(typeof mmrDiversifier).toBe('function')
    expect(typeof cosineSimilarity).toBe('function')
  })

  it('builds and runs an engine assembled entirely through the facade', async () => {
    const engine = createEngine<{ plays: number }>()
      .use({
        id: 'library',
        version: '1.0.0',
        provide: async () => [
          { id: itemId('a'), type: 'track', payload: { plays: 10 } },
          { id: itemId('b'), type: 'track', payload: { plays: 9000 } },
        ],
      })
      .use({
        id: 'plays',
        version: '1.0.0',
        provides: [
          {
            key: featureKey('popularity_global'),
            kind: 'numeric',
            defaultValue: 0,
            description: 'plays',
            owner: 'plays',
            ownerVersion: '1.0.0',
          },
        ],
        extract: async (set, out) => {
          const column = out.columnMut(featureKey('popularity_global'))
          for (let row = 0; row < set.size; row++) column[row] = set.at(row).item.payload.plays
        },
      })
      .use(popularityStrategy({ cohortFeature: null }))
      .configure({ limits: { maxCandidates: 100, maxLimit: 10, timeoutMs: 200 }, weights: { popularity: 1 } })
      .build()

    const { recommendations } = await engine.recommend({
      user: { id: userId('u1'), payload: { plays: 0 } },
      history: { userId: userId('u1'), events: [] },
      limit: 10,
      explain: 'reasons',
    })

    expect(recommendations.map((r) => r.item.id)).toEqual(['b', 'a']) // more plays wins
  })
})
