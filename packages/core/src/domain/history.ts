import type { Event, EventType, History } from './entities.js'
import type { ItemId, Timestamp, UserId } from './ids.js'

/**
 * History, indexed once per request.
 *
 * Naively every strategy does `history.events.filter(...)`, which is O(strategies ×
 * events). With eight strategies over 50k events that is two orders of magnitude of
 * waste. Build the index once, read it in O(1).
 *
 * Every accessor is keyed by `ItemId` — the core's own type. There is not one domain
 * string in this interface, and that is the point: `aggregateBy('artist')` would have
 * meant the core knows what an artist is. `aggregate()` takes the domain's function
 * instead, so the core *runs* domain logic without *containing* any.
 */
export interface HistoryIndex {
  readonly userId: UserId
  readonly size: number
  readonly firstAt: Timestamp | undefined
  readonly lastAt: Timestamp | undefined

  /** Events for one item, oldest first. Empty array if untouched. */
  eventsFor(itemId: ItemId): readonly Event[]
  countFor(itemId: ItemId, type?: EventType): number
  lastAtFor(itemId: ItemId, type?: EventType): Timestamp | undefined
  hasSeen(itemId: ItemId): boolean

  /**
   * Group events by any domain-defined key and count them.
   *
   * Memoised on `memoKey` for the lifetime of the index, so eight extractors asking for
   * the same grouping cost one pass, not eight. Events whose `keyFn` returns `undefined`
   * are skipped.
   *
   * @example
   * ```ts
   * history.aggregate('artist', (e) => catalogue.get(e.itemId)?.artistId)
   * ```
   */
  aggregate<K>(memoKey: string, keyFn: (event: Event) => K | undefined): ReadonlyMap<K, number>

  /** Events in `[from, to)`. */
  slice(from: Timestamp, to: Timestamp): HistoryIndex
  ofType(type: EventType): HistoryIndex
}

interface ItemStats {
  readonly events: Event[]
  readonly countByType: Map<EventType, number>
  readonly lastAtByType: Map<EventType, Timestamp>
  lastAt: Timestamp
}

export class MapHistoryIndex implements HistoryIndex {
  readonly userId: UserId
  readonly size: number
  readonly firstAt: Timestamp | undefined
  readonly lastAt: Timestamp | undefined

  private readonly events: readonly Event[]
  private readonly byItem: Map<ItemId, ItemStats>
  // `unknown` rather than a generic: one index memoises aggregations of different key
  // types, and the cast is contained to `aggregate()`, which owns the invariant that a
  // memoKey always maps to the same K.
  private readonly memo = new Map<string, ReadonlyMap<unknown, number>>()

  constructor(history: History) {
    this.userId = history.userId

    // Sorted once, ascending. Downstream code — recency decay, session windows, "last
    // played" — all assume chronological order; establishing it here means no strategy
    // has to sort defensively.
    const events = [...history.events].sort((a, b) => a.at - b.at)
    this.events = events
    this.size = events.length
    this.firstAt = events[0]?.at
    this.lastAt = events[events.length - 1]?.at

    this.byItem = new Map()
    for (const event of events) {
      let stats = this.byItem.get(event.itemId)
      if (stats === undefined) {
        stats = { events: [], countByType: new Map(), lastAtByType: new Map(), lastAt: event.at }
        this.byItem.set(event.itemId, stats)
      }
      stats.events.push(event)
      stats.countByType.set(event.type, (stats.countByType.get(event.type) ?? 0) + 1)
      stats.lastAtByType.set(event.type, event.at)
      stats.lastAt = event.at
    }
  }

  eventsFor(itemId: ItemId): readonly Event[] {
    return this.byItem.get(itemId)?.events ?? []
  }

  countFor(itemId: ItemId, type?: EventType): number {
    const stats = this.byItem.get(itemId)
    if (stats === undefined) return 0
    return type === undefined ? stats.events.length : (stats.countByType.get(type) ?? 0)
  }

  lastAtFor(itemId: ItemId, type?: EventType): Timestamp | undefined {
    const stats = this.byItem.get(itemId)
    if (stats === undefined) return undefined
    return type === undefined ? stats.lastAt : stats.lastAtByType.get(type)
  }

  hasSeen(itemId: ItemId): boolean {
    return this.byItem.has(itemId)
  }

  aggregate<K>(memoKey: string, keyFn: (event: Event) => K | undefined): ReadonlyMap<K, number> {
    const cached = this.memo.get(memoKey)
    if (cached !== undefined) return cached as ReadonlyMap<K, number>

    const counts = new Map<K, number>()
    for (const event of this.events) {
      const key = keyFn(event)
      if (key === undefined) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    this.memo.set(memoKey, counts as ReadonlyMap<unknown, number>)
    return counts
  }

  slice(from: Timestamp, to: Timestamp): HistoryIndex {
    return new MapHistoryIndex({
      userId: this.userId,
      events: this.events.filter((e) => e.at >= from && e.at < to),
    })
  }

  ofType(type: EventType): HistoryIndex {
    return new MapHistoryIndex({
      userId: this.userId,
      events: this.events.filter((e) => e.type === type),
    })
  }
}
