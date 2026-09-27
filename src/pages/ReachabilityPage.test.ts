import { describe, it, expect } from 'vitest'
import { applyResponse } from './ReachabilityPage'

/**
 * Regression coverage for the original tool's UI contract, without needing a
 * DOM worker:
 *  - pasted JSON results populate targets + reachable in the same order
 *  - repeated targets repeat their verdicts
 *  - INVALID_INPUT clears any previous answers
 *  - stale worker responses (mismatched request id) are discarded
 */
describe('reachability page response contract', () => {
  const okResponse = {
    id: 1,
    kind: 'ok' as const,
    targets: [0, 1, 3, 4, 53, 400000, 0],
    reachable: [true, true, true, true, true, true, true],
    distinctA: 4,
    distinctB: 5,
    elapsedMs: 12.5,
  }

  it('applies an ok response with ordered targets and verdicts', () => {
    const next = applyResponse(okResponse, 1)!
    expect(next).not.toBeNull()
    expect(next.status.kind).toBe('ok')
    expect(next.targets).toEqual([0, 1, 3, 4, 53, 400000, 0])
    expect(next.reachable).toHaveLength(7)
    if (next.status.kind === 'ok') {
      expect(next.status.reachableCount).toBe(7)
      expect(next.status.distinctA).toBe(4)
      expect(next.status.distinctB).toBe(5)
    }
  })

  it('keeps duplicate targets in order with matching verdicts', () => {
    const res = { ...okResponse, targets: [5, 5, 9, 5], reachable: [false, false, true, false] }
    const next = applyResponse(res, 1)!
    expect(next.targets).toEqual([5, 5, 9, 5])
    expect(next.reachable).toEqual([false, false, true, false])
    if (next.status.kind === 'ok') expect(next.status.reachableCount).toBe(1)
  })

  it('INVALID_INPUT clears any previous answers', () => {
    const next = applyResponse({ id: 2, kind: 'invalid' as const }, 2)!
    expect(next.status).toEqual({ kind: 'invalid' })
    expect(next.targets).toEqual([])
    expect(next.reachable).toEqual([])
  })

  it('error responses also clear previous answers', () => {
    const next = applyResponse({ id: 3, kind: 'error' as const, message: 'boom' }, 3)!
    expect(next.targets).toEqual([])
    expect(next.status).toEqual({ kind: 'error', message: 'boom' })
  })

  it('discards stale responses whose id does not match the latest request', () => {
    expect(applyResponse(okResponse, 2)).toBeNull()
    expect(applyResponse({ id: 9, kind: 'invalid' as const }, 2)).toBeNull()
  })
})
