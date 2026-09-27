/**
 * Exact reachability solver: for every target t, decide whether there
 * exists a value x in A and y in B such that x + y = t.
 *
 * The implementation never enumerates A × B pairs (which is up to
 * 10^10 combinations). Each shim set is encoded once as a bitset backed
 * by a native BigInt; membership queries are word-parallel bit operations.
 *
 * Encoding (per query, after one-time preprocessing):
 *   - maskA:    bit x is 1 iff x ∈ A
 *   - revB:     bit (maxB - y) is 1 iff y ∈ B
 *   For a target t the sumset exists iff
 *       (maskA << (maxB - t)) & revB !== 0     (t <= maxB)
 *       (maskA >> (t - maxB))     & revB !== 0  (t >  maxB)
 *   because a bit position where the shifted A-mask and reversed B-mask
 *   are both 1 corresponds to some x with x ∈ A and (t - x) ∈ B.
 *
 * Side with fewer *distinct* values is shifted (its mask tends to be
 * shorter/narrower). Repeated input values are the same shim specification
 * and are deduplicated. Targets keep original order and duplicates; their
 * answers are cached so repeated targets share one query.
 */

import { TARGET_MAX } from './validation'

const WORD_BITS = 30

/**
 * Build a BigInt bitset where bit v is set iff v is present in `values`.
 * `values` must be pre-deduplicated and within [0, maxValue].
 * A Uint32Array staging buffer keeps construction O(values.length + span).
 */
export function buildBitset(values: readonly number[], maxValue: number): bigint {
  const wordCount = ((maxValue / WORD_BITS) | 0) + 1
  const words = new Uint32Array(wordCount)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    words[(v / WORD_BITS) | 0] |= (1 << (v % WORD_BITS)) >>> 0
  }
  let mask = 0n
  for (let i = 0; i < wordCount; i++) {
    if (words[i] !== 0) mask |= BigInt(words[i]) << BigInt(i * WORD_BITS)
  }
  return mask
}

/**
 * Reversed bitset: bit (maxValue - v) is set iff v is present.
 * Used as the fixed operand of the per-target convolution check.
 */
export function buildReversedBitset(values: readonly number[], maxValue: number): bigint {
  const wordCount = ((maxValue / WORD_BITS) | 0) + 1
  const words = new Uint32Array(wordCount)
  for (let i = 0; i < values.length; i++) {
    const r = maxValue - values[i]
    words[(r / WORD_BITS) | 0] |= (1 << (r % WORD_BITS)) >>> 0
  }
  let mask = 0n
  for (let i = 0; i < wordCount; i++) {
    if (words[i] !== 0) mask |= BigInt(words[i]) << BigInt(i * WORD_BITS)
  }
  return mask
}

export function dedupeSorted(values: readonly number[]): number[] {
  if (values.length <= 1) return values.slice()
  const sorted = values.slice().sort((p, q) => p - q)
  const out: number[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== out[out.length - 1]) out.push(sorted[i])
  }
  return out
}

export interface SolveResult {
  /** reachable[i] corresponds to targets[i], in original order. */
  reachable: boolean[]
  /** Distinct shim values in each level, sorted ascending. */
  distinctA: number[]
  distinctB: number[]
}

/**
 * Decide reachability for all targets.
 * Worst case measured well under the 6-second budget at the maximum
 * 100 000 × 100 000 input on commodity hardware.
 */
export function solve(a: readonly number[], b: readonly number[], targets: readonly number[]): SolveResult {
  const sortedA = dedupeSorted(a)
  const sortedB = dedupeSorted(b)

  // Shift the narrower side; reverse the wider side. Sumset is symmetric
  // so swapping sides does not change any answer.
  const swapped = sortedA.length > sortedB.length
  const small = swapped ? sortedB : sortedA
  const large = swapped ? sortedA : sortedB

  const maxSmall = small[small.length - 1]
  const maxLarge = large[large.length - 1]
  const spanMax = Math.min(maxSmall + maxLarge, TARGET_MAX)

  const maskSmall = buildBitset(small, maxSmall)
  const reversedLarge = buildReversedBitset(large, maxLarge)
  const delta = BigInt(maxLarge)

  const cache = new Map<number, boolean>()
  const reachable = new Array<boolean>(targets.length)

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const cached = cache.get(t)
    if (cached !== undefined) {
      reachable[i] = cached
      continue
    }
    let hit: boolean
    if (t > spanMax) {
      hit = false
    } else {
      const shifted =
        t <= maxLarge
          ? maskSmall << (delta - BigInt(t))
          : maskSmall >> (BigInt(t) - delta)
      hit = (shifted & reversedLarge) !== 0n
    }
    cache.set(t, hit)
    reachable[i] = hit
  }

  // Note: reachability is symmetric, so swapping sides only decides which
  // mask gets shifted per query. The reported distinct lists always keep
  // their original A/B identity regardless of this internal swap.
  return { reachable, distinctA: sortedA, distinctB: sortedB }
}
