/**
 * Why a score moved, as data rather than prose.
 *
 * `{ code: 'favorite_artist', params: { artist: 'The Beatles', plays: 143 } }` — never
 * the string "Любимый исполнитель". Rendering lives outside the core, because i18n,
 * A/B-tested wording and per-channel phrasing (a push notification is not a tooltip)
 * are not the engine's business. A hardcoded human sentence in here would make the
 * library unusable for anyone whose users do not speak that language.
 */
export interface Reason {
  /** Stable key. Renderers and analytics both key on this, so treat it as public API. */
  readonly code: string
  readonly polarity: 'positive' | 'negative' | 'neutral'
  /** How strong the reason is in itself, [0..1]. Distinct from its weighted contribution. */
  readonly strength: number
  /** Values the renderer interpolates: artist names, counts, percentiles. */
  readonly params?: Readonly<Record<string, string | number>>
}
