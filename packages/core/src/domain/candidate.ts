import { RecoError } from '../kernel/errors.js'
import type { Item } from './entities.js'
import type { ItemId } from './ids.js'

/** An item in the running, plus what retrieval knows about it. */
export interface Candidate<P = unknown> {
  readonly item: Item<P>
  /**
   * Ids of the providers that returned this item.
   *
   * Not bookkeeping: an item found by three providers is more likely relevant than one
   * found by a single provider, which makes this a scoring signal; and it feeds the
   * explanation ("similar to what you played" *and* "popular with users like you").
   */
  readonly sources: ReadonlySet<string>
  /** Best score any provider reported — ANN distance, BM25, popularity rank. */
  readonly retrievalScore: number
}

/**
 * The candidates of one request, in a fixed order.
 *
 * Row order is the contract that ties everything downstream together: row `i` of the
 * feature matrix, of every score column and of the board all mean *this* candidate.
 * The set is built once and never reordered — ranking permutes indices, not rows.
 */
export interface CandidateSet<P = unknown> {
  readonly candidates: readonly Candidate<P>[]
  readonly size: number
  /** Row of an item, or `-1` if absent. */
  indexOf(id: ItemId): number
  at(row: number): Candidate<P>
}

/**
 * Merges what the providers returned into one deduplicated set.
 *
 * Providers overlap by design — the library provider and the "similar to recent" provider
 * will both return the same track — so dedup is the normal path, not an edge case.
 */
export class CandidateSetBuilder<P = unknown> {
  private readonly items: Item<P>[] = []
  private readonly sources: Set<string>[] = []
  private readonly scores: number[] = []
  private readonly rowOf = new Map<ItemId, number>()

  /**
   * Adds one provider's results. Repeat items merge: sources union, retrieval score
   * keeps the maximum.
   *
   * Max rather than sum: scores come from different providers on incomparable scales
   * (a cosine distance and a BM25 score), so adding them would be arithmetic on
   * apples and oranges. Max at least means "the most confident provider's opinion".
   * Anything more principled belongs in a strategy, where normalization has happened.
   */
  add(providerId: string, items: readonly Item<P>[], retrievalScore = 0): this {
    for (const item of items) {
      const existing = this.rowOf.get(item.id)
      if (existing === undefined) {
        this.rowOf.set(item.id, this.items.length)
        this.items.push(item)
        this.sources.push(new Set([providerId]))
        this.scores.push(retrievalScore)
      } else {
        ;(this.sources[existing] as Set<string>).add(providerId)
        this.scores[existing] = Math.max(this.scores[existing] as number, retrievalScore)
      }
    }
    return this
  }

  get size(): number {
    return this.items.length
  }

  /** Drops rows failing `keep`. Used by the prefilter stage. */
  filter(keep: (candidate: Candidate<P>, row: number) => boolean): CandidateSetBuilder<P> {
    const next = new CandidateSetBuilder<P>()
    for (let row = 0; row < this.items.length; row++) {
      const candidate = this.candidateAt(row)
      if (!keep(candidate, row)) continue
      next.rowOf.set(candidate.item.id, next.items.length)
      next.items.push(candidate.item)
      next.sources.push(new Set(candidate.sources))
      next.scores.push(candidate.retrievalScore)
    }
    return next
  }

  build(): CandidateSet<P> {
    const candidates = this.items.map((_, row) => this.candidateAt(row))
    const rowOf = new Map(this.rowOf)

    return {
      candidates,
      size: candidates.length,
      indexOf: (id) => rowOf.get(id) ?? -1,
      at: (row) => {
        const candidate = candidates[row]
        if (candidate === undefined) {
          throw new RecoError(
            'INVALID_CONFIG',
            `Row ${row} is out of range for ${candidates.length} candidates.`,
          )
        }
        return candidate
      },
    }
  }

  private candidateAt(row: number): Candidate<P> {
    return {
      item: this.items[row] as Item<P>,
      sources: this.sources[row] as Set<string>,
      retrievalScore: this.scores[row] as number,
    }
  }
}
