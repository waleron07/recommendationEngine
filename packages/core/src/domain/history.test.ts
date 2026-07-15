import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Event } from './entities.js'
import { MapHistoryIndex } from './history.js'
import { eventId, itemId, timestamp, userId } from './ids.js'

const U = userId('u1')

let counter = 0
const ev = (item: string, at: number, type = 'play'): Event => ({
  id: eventId(`e${counter++}`),
  userId: U,
  itemId: itemId(item),
  type,
  at: timestamp(at),
})

const indexOf = (...events: Event[]) => new MapHistoryIndex({ userId: U, events })

describe('MapHistoryIndex', () => {
  it('sorts events chronologically, so no strategy has to sort defensively', () => {
    const index = indexOf(ev('a', 300), ev('a', 100), ev('a', 200))

    expect(index.eventsFor(itemId('a')).map((e) => e.at)).toEqual([100, 200, 300])
    expect(index.firstAt).toBe(100)
    expect(index.lastAt).toBe(300)
  })

  it('counts per item and per event type', () => {
    const index = indexOf(ev('a', 1), ev('a', 2), ev('a', 3, 'skip'), ev('b', 4))

    expect(index.countFor(itemId('a'))).toBe(3)
    expect(index.countFor(itemId('a'), 'play')).toBe(2)
    expect(index.countFor(itemId('a'), 'skip')).toBe(1)
    expect(index.countFor(itemId('b'))).toBe(1)
  })

  it('reports zero for an unseen item rather than undefined', () => {
    // Callers multiply this straight into a fatigue curve; undefined would become NaN
    // and silently poison the score of everything the user has never touched.
    const index = indexOf(ev('a', 1))

    expect(index.countFor(itemId('ghost'))).toBe(0)
    expect(index.countFor(itemId('ghost'), 'play')).toBe(0)
    expect(index.eventsFor(itemId('ghost'))).toEqual([])
    expect(index.hasSeen(itemId('ghost'))).toBe(false)
    expect(index.lastAtFor(itemId('ghost'))).toBeUndefined()
  })

  it('tracks last contact overall and per type', () => {
    const index = indexOf(ev('a', 100), ev('a', 500, 'skip'), ev('a', 300))

    expect(index.lastAtFor(itemId('a'))).toBe(500)
    expect(index.lastAtFor(itemId('a'), 'play')).toBe(300)
    expect(index.lastAtFor(itemId('a'), 'skip')).toBe(500)
    expect(index.lastAtFor(itemId('a'), 'like')).toBeUndefined()
  })

  it('handles empty history', () => {
    const index = indexOf()

    expect(index.size).toBe(0)
    expect(index.firstAt).toBeUndefined()
    expect(index.lastAt).toBeUndefined()
  })

  describe('aggregate', () => {
    it('groups by a domain-supplied key without the core knowing what the key means', () => {
      const artists: Record<string, string> = { a: 'beatles', b: 'beatles', c: 'bowie' }
      const index = indexOf(ev('a', 1), ev('b', 2), ev('c', 3), ev('a', 4))

      const counts = index.aggregate('artist', (e) => artists[e.itemId])

      expect(counts.get('beatles')).toBe(3)
      expect(counts.get('bowie')).toBe(1)
    })

    it('skips events the key function cannot classify', () => {
      const index = indexOf(ev('a', 1), ev('unknown', 2))
      const counts = index.aggregate('artist', (e) => (e.itemId === 'a' ? 'beatles' : undefined))

      expect(counts.get('beatles')).toBe(1)
      expect(counts.size).toBe(1)
    })

    it('memoises per key, so eight extractors cost one pass', () => {
      const index = indexOf(ev('a', 1), ev('b', 2))
      let passes = 0

      const first = index.aggregate('artist', (e) => {
        passes++
        return e.itemId
      })
      const second = index.aggregate('artist', (e) => {
        passes++
        return e.itemId
      })

      expect(passes).toBe(2) // one pass over two events, not two passes
      expect(second).toBe(first)
    })

    it('counts every event exactly once', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 1000 })), {
            maxLength: 50,
          }),
          (pairs) => {
            const index = indexOf(...pairs.map(([item, at]) => ev(item, at)))
            const counts = index.aggregate('item', (e) => e.itemId)
            const total = [...counts.values()].reduce((a, b) => a + b, 0)

            expect(total).toBe(pairs.length)
          },
        ),
      )
    })
  })

  describe('slice and ofType', () => {
    it('slices a half-open interval [from, to)', () => {
      const index = indexOf(ev('a', 100), ev('b', 200), ev('c', 300))
      const window = index.slice(timestamp(100), timestamp(300))

      expect(window.size).toBe(2)
      expect(window.hasSeen(itemId('c'))).toBe(false)
    })

    it('filters by type', () => {
      const index = indexOf(ev('a', 1), ev('b', 2, 'skip'))
      const skips = index.ofType('skip')

      expect(skips.size).toBe(1)
      expect(skips.hasSeen(itemId('b'))).toBe(true)
    })

    it('leaves the original untouched — derived views never mutate their source', () => {
      const index = indexOf(ev('a', 100), ev('b', 200))
      index.slice(timestamp(0), timestamp(150))

      expect(index.size).toBe(2)
    })

    it('never returns more events than it started with', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 30 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          (times, a, b) => {
            const index = indexOf(...times.map((t) => ev('x', t)))
            const [from, to] = a <= b ? [a, b] : [b, a]
            const window = index.slice(timestamp(from), timestamp(to))

            expect(window.size).toBeLessThanOrEqual(index.size)
            for (const event of window.eventsFor(itemId('x'))) {
              expect(event.at).toBeGreaterThanOrEqual(from)
              expect(event.at).toBeLessThan(to)
            }
          },
        ),
      )
    })
  })
})
