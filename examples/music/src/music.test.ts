/**
 * The music example, end to end — stage 9's acceptance criterion: "works on a real dataset".
 *
 * It is also the standing proof that the abstraction does not leak. Every import is either a
 * published `@recoengine/*` package or a domain extractor from this example; nothing reaches
 * into the core, and the core has no line of music in it. If this file compiles and passes,
 * a domain was served with zero changes to the engine.
 */
import { itemId } from '@recoengine/core'
import { describe, expect, it } from 'vitest'
import { byId } from './catalogue.js'
import { buildMusicEngine, listenRequest } from './engine.js'

const artistOf = (id: string) => byId.get(id)?.artistId

describe('music recommendations', () => {
  it('puts the user’s most-played artist on top, with reasons', async () => {
    const { recommendations } = await buildMusicEngine().recommend(listenRequest())
    const top = recommendations[0]
    // The Beatles dominate the history (t1 twice, t2 twice, t3 once), so a Beatles track
    // leads — driven by artist affinity plus recent interaction, both of which it explains.
    expect(top?.item.payload.artistName).toBe('The Beatles')
    expect(top?.explanation.reasons.map((r) => r.code)).toContain('high_affinity')
  })

  it('caps the feed at two tracks per artist (the attribute quota)', async () => {
    const { recommendations } = await buildMusicEngine().recommend(listenRequest())
    const beatles = recommendations.filter((r) => r.item.payload.artistId === 'beatles')
    // Three Beatles tracks exist and all score well, but the quota keeps only the top two.
    expect(beatles).toHaveLength(2)
    for (const [artist, count] of countByArtist(recommendations)) {
      expect(count, `artist ${artist}`).toBeLessThanOrEqual(2)
    }
  })

  it('surfaces a brand-new, barely-played track on freshness alone', async () => {
    const { recommendations } = await buildMusicEngine().recommend(listenRequest())
    const fresh = recommendations.find((r) => r.item.id === 't8')
    // 500 plays against millions would be invisible on popularity; recency puts it on the map.
    expect(fresh).toBeDefined()
    expect(fresh?.explanation.reasons.map((r) => r.code)).toContain('fresh')
  })

  it('explains why a track is NOT in the feed: dropped by the quota', async () => {
    const engine = buildMusicEngine()
    // t3 (Yesterday) is a third Beatles track — it scores well but the quota drops it.
    const why = await engine.explain(itemId('t3'), listenRequest())
    expect(artistOf('t3')).toBe('beatles')
    expect(why.status).toBe('diversified_out')
    expect(why.lostAt).toBe('diversification')
    // It still carries a full explanation, because it was scored before being dropped.
    expect(why.explanation).toBeDefined()
    expect(why.explanation?.trace).toBeDefined()
  })

  it('explains a track no provider returned', async () => {
    const why = await buildMusicEngine().explain(itemId('does-not-exist'), listenRequest())
    expect(why.status).toBe('not_retrieved')
    expect(why.item).toBeUndefined()
  })

  it('is deterministic: the same request twice gives the same feed', async () => {
    const engine = buildMusicEngine()
    const first = await engine.recommend(listenRequest())
    const second = await engine.recommend(listenRequest())
    expect(first.recommendations.map((r) => r.item.id)).toEqual(second.recommendations.map((r) => r.item.id))
  })

  it('scores everything with no warnings — the wiring holds together', async () => {
    const { recommendations, diagnostics } = await buildMusicEngine().recommend(listenRequest())
    expect(diagnostics.warnings).toEqual([])
    expect(diagnostics.retrieved).toBe(8)
    for (const rec of recommendations) {
      expect(rec.score).toBeGreaterThanOrEqual(0)
      expect(rec.score).toBeLessThanOrEqual(100)
    }
  })
})

function countByArtist(recs: readonly { item: { payload: { artistId: string } } }[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const rec of recs) {
    const a = rec.item.payload.artistId
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  return counts
}
