/**
 * Top-K by score, without ordering what nobody will read.
 *
 * Sorting 5000 candidates to show 20 is 4980 comparisons spent on an order no one sees.
 * A bounded min-heap keeps only the best K: O(n log k) instead of O(n log n), and — more
 * importantly at the 5000-row ceiling — it allocates an array of K rather than of n.
 *
 * The heap is a *min*-heap even though we want the maximum: its root is the weakest of
 * the current best K, which is exactly the value each new candidate has to beat. That
 * comparison is the whole algorithm, and it is why the root must be the one we discard.
 *
 * @param scoreOf   row → score. Higher is better.
 * @param tieBreak  row → number. Lower wins ties. Determinism lives here: two candidates
 *                  with equal scores must come back in the same order on every request, or
 *                  a golden test is measuring the heap's internal shuffling.
 */
export function topK(
  rows: number,
  k: number,
  scoreOf: (row: number) => number,
  tieBreak: (row: number) => number = (row) => row,
): number[] {
  if (k <= 0 || rows <= 0) return []
  const limit = Math.min(k, rows)

  // Row indices, arranged as a binary min-heap by (score, -tieBreak).
  const heap: number[] = []
  const weaker = (a: number, b: number): boolean => {
    const scoreA = scoreOf(a)
    const scoreB = scoreOf(b)
    if (scoreA !== scoreB) return scoreA < scoreB
    // Equal scores: the one that loses the tie-break is the weaker, so it leaves first.
    return tieBreak(a) > tieBreak(b)
  }

  for (let row = 0; row < rows; row++) {
    if (heap.length < limit) {
      heap.push(row)
      siftUp(heap, heap.length - 1, weaker)
      continue
    }
    // The root is the weakest of the best K so far. Anything that cannot beat it cannot
    // enter, and that single comparison rejects most of the catalogue in one step.
    if (weaker(heap[0] as number, row)) {
      heap[0] = row
      siftDown(heap, 0, weaker)
    }
  }

  // The heap holds the right K in the wrong order — it only ever promised its root. K is
  // the page size, so ordering it now is cheap, and this is where it gets ordered.
  return heap.sort((a, b) => scoreOf(b) - scoreOf(a) || tieBreak(a) - tieBreak(b))
}

function siftUp(heap: number[], start: number, weaker: (a: number, b: number) => boolean): void {
  let index = start
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (!weaker(heap[index] as number, heap[parent] as number)) break
    swap(heap, index, parent)
    index = parent
  }
}

function siftDown(heap: number[], start: number, weaker: (a: number, b: number) => boolean): void {
  let index = start
  for (;;) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index

    if (left < heap.length && weaker(heap[left] as number, heap[smallest] as number)) smallest = left
    if (right < heap.length && weaker(heap[right] as number, heap[smallest] as number)) smallest = right
    if (smallest === index) break

    swap(heap, index, smallest)
    index = smallest
  }
}

function swap(heap: number[], a: number, b: number): void {
  const held = heap[a] as number
  heap[a] = heap[b] as number
  heap[b] = held
}
