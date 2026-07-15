import type { EventId, ItemId, Timestamp, UserId } from './ids.js'

/**
 * Something being recommended: a track, a movie, a product, an article.
 *
 * The engine never looks inside `payload`. Domain knowledge reaches the pipeline
 * through feature extractors, which are the only components allowed to read it.
 */
export interface Item<P = unknown> {
  readonly id: ItemId
  /** Free-form discriminator: `'track'`, `'movie'`, `'product'`. */
  readonly type: string
  readonly payload: P
}

/** The person a recommendation is for. `payload` is domain data, opaque to the engine. */
export interface User<P = unknown> {
  readonly id: UserId
  readonly payload: P
}

/**
 * What a user did with an item: `'play'`, `'like'`, `'skip'`, `'purchase'`, `'view'`.
 *
 * An open string rather than an enum, because an enum would drag the domain into the
 * core: music has `skip`, a shop has `add_to_cart`. Meaning is assigned by config
 * (`eventWeights`), not by the type system — the engine only counts and times them.
 */
export type EventType = string

/** A single interaction. The atom of history. */
export interface Event<P = unknown> {
  readonly id: EventId
  readonly userId: UserId
  readonly itemId: ItemId
  readonly type: EventType
  readonly at: Timestamp
  /** Rating, listen duration, order total — semantics belong to the domain. */
  readonly value?: number
  readonly payload?: P
}

/** Raw history as the host application stores it. Indexed into a `HistoryIndex` per request. */
export interface History {
  readonly userId: UserId
  readonly events: readonly Event[]
}
