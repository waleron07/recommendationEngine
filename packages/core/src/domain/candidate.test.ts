import { describe, expect, it } from 'vitest'
import { CandidateSetBuilder } from './candidate.js'
import type { Item } from './entities.js'
import { itemId } from './ids.js'

const track = (id: string): Item<{ title: string }> => ({
  id: itemId(id),
  type: 'track',
  payload: { title: id },
})

describe('CandidateSetBuilder', () => {
  it('keeps insertion order, since row order is the contract with the matrix', () => {
    const set = new CandidateSetBuilder().add('library', [track('a'), track('b'), track('c')]).build()

    expect(set.candidates.map((c) => c.item.id)).toEqual(['a', 'b', 'c'])
    expect(set.indexOf(itemId('b'))).toBe(1)
  })

  it('deduplicates across providers and unions their ids', () => {
    // Providers overlapping is the normal path: the library provider and the
    // "similar to recent" provider will both return the same track.
    const set = new CandidateSetBuilder()
      .add('library', [track('a')])
      .add('similar', [track('a')])
      .build()

    expect(set.size).toBe(1)
    expect([...set.at(0).sources].sort()).toEqual(['library', 'similar'])
  })

  it('keeps the highest retrieval score rather than summing incomparable scales', () => {
    const set = new CandidateSetBuilder()
      .add('ann', [track('a')], 0.9)
      .add('bm25', [track('a')], 12.4)
      .add('popular', [track('a')], 0.1)
      .build()

    expect(set.at(0).retrievalScore).toBe(12.4)
  })

  it('reports -1 for an absent item, never a wrong row', () => {
    const set = new CandidateSetBuilder().add('library', [track('a')]).build()
    expect(set.indexOf(itemId('ghost'))).toBe(-1)
  })

  it('throws on an out-of-range row instead of returning undefined', () => {
    const set = new CandidateSetBuilder().add('library', [track('a')]).build()
    expect(() => set.at(3)).toThrow(/out of range/)
  })

  it('renumbers rows after filtering so indexOf stays truthful', () => {
    // The prefilter stage drops rows before the matrix is allocated; a stale index
    // here would silently attach one candidate's features to another's score.
    const set = new CandidateSetBuilder()
      .add('library', [track('a'), track('b'), track('c')])
      .filter((c) => c.item.id !== 'b')
      .build()

    expect(set.candidates.map((c) => c.item.id)).toEqual(['a', 'c'])
    expect(set.indexOf(itemId('c'))).toBe(1)
    expect(set.indexOf(itemId('b'))).toBe(-1)
  })

  it('carries sources and scores through a filter', () => {
    const set = new CandidateSetBuilder()
      .add('library', [track('a')], 5)
      .add('similar', [track('a')])
      .filter(() => true)
      .build()

    expect([...set.at(0).sources].sort()).toEqual(['library', 'similar'])
    expect(set.at(0).retrievalScore).toBe(5)
  })

  it('does not mutate the original when filtering', () => {
    const builder = new CandidateSetBuilder().add('library', [track('a'), track('b')])
    builder.filter(() => false)

    expect(builder.build().size).toBe(2)
  })

  it('handles zero candidates', () => {
    const set = new CandidateSetBuilder().add('library', []).build()

    expect(set.size).toBe(0)
    expect(set.candidates).toEqual([])
  })
})
