#!/usr/bin/env node
/**
 * Full-scale performance check for the worst allowed input:
 * 100 000 distinct A values × 100 000 distinct B values, 100 000 targets.
 *
 * This mirrors the algorithm in src/lib/solver.ts (BigInt bitset, per-target
 * shifted AND — no pair enumeration). It exits non-zero if the decision pass
 * exceeds the 6-second budget. Run with: npm run perf
 */

const BUDGET_MS = 6000
const SHIM_MAX = 200000
const TARGET_MAX = 400000
const WORD_BITS = 30

function xorshiftValues(n, max, seed) {
  let x = seed >>> 0 || 1
  const out = new Set()
  while (out.size < n) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out.add(x % (max + 1))
  }
  return [...out]
}

function buildBitset(values, maxValue, reverse = false) {
  const wordCount = ((maxValue / WORD_BITS) | 0) + 1
  const words = new Uint32Array(wordCount)
  for (const v of values) {
    const r = reverse ? maxValue - v : v
    words[(r / WORD_BITS) | 0] |= (1 << (r % WORD_BITS))
  }
  let mask = 0n
  for (let i = 0; i < wordCount; i++) {
    if (words[i] !== 0) mask |= BigInt(words[i]) << BigInt(i * WORD_BITS)
  }
  return mask
}

const a = xorshiftValues(100000, SHIM_MAX, 20260917)
const b = xorshiftValues(100000, SHIM_MAX, 424243)
const targets = []
for (let i = 0; i < 100000; i++) targets.push((i * 39916801) % (TARGET_MAX + 1))

const t0 = performance.now()
const maskA = buildBitset(a, SHIM_MAX)
const revB = buildBitset(b, SHIM_MAX, true)
const tBuilt = performance.now()

const delta = BigInt(SHIM_MAX)
let reachableCount = 0
for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  let hit = false
  if (t <= 2 * SHIM_MAX) {
    const shifted = t <= SHIM_MAX ? maskA << (delta - BigInt(t)) : maskA >> (BigInt(t) - delta)
    if ((shifted & revB) !== 0n) hit = true
  }
  if (hit) reachableCount++
}
const elapsed = performance.now() - t0

console.log(
  `full-scale 100000x100000, 100000 targets: ` +
    `build ${(tBuilt - t0).toFixed(0)} ms, total ${elapsed.toFixed(0)} ms, ` +
    `${reachableCount} reachable`,
)

if (elapsed > BUDGET_MS) {
  console.error(`FAIL: exceeded ${BUDGET_MS} ms budget`)
  process.exit(1)
}
console.log(`PASS: within ${BUDGET_MS} ms budget`)
