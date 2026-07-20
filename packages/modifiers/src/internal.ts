import type { EventType, HistoryIndex, ItemId } from '@recoengine/core'

/** [0..1], NaN → 0. */
export const clamp01 = (x: number): number => (x > 1 ? 1 : x > 0 ? x : 0)

/**
 * How concentrated the user's history is, in [0..1]: 1 when every interaction lands on
 * one item, → 0 when spread evenly across many. This is the "profile saturation" of §15,
 * computed from the item distribution alone — no domain grouping, no profile feature, so
 * a modifier (which sees neither) can still ask it.
 *
 * `1 − H/ln(unique)` normalises Shannon entropy by its maximum for the observed number of
 * distinct items, so saturation measures *evenness*, not *volume*: ten plays of one track
 * and a thousand plays of one track are equally saturated, which is what "the user is
 * stuck in a rut" should mean.
 */
export function saturationOf(history: HistoryIndex, eventType: EventType | undefined): number {
  const distribution = history.aggregate(`modifiers:saturation:${eventType ?? '*'}`, (event) =>
    eventType !== undefined && event.type !== eventType ? undefined : (event.itemId as ItemId),
  )

  let total = 0
  for (const count of distribution.values()) total += count
  if (total === 0) return 0

  const unique = distribution.size
  if (unique <= 1) return 1

  let entropy = 0
  for (const count of distribution.values()) {
    const p = count / total
    entropy -= p * Math.log(p)
  }
  return clamp01(1 - entropy / Math.log(unique))
}
