/// <reference lib="webworker" />
/**
 * Worker: keeps the (up to 100k × 100k) computation off the UI thread so
 * the page stays responsive while exact reachability is solved.
 */
import { parseInput, InvalidInputError } from './lib/validation'
import { solve } from './lib/solver'

export type SolveRequest = { id: number; text: string }
export type SolveResponse =
  | {
      id: number
      kind: 'ok'
      targets: number[]
      reachable: boolean[]
      distinctA: number
      distinctB: number
      elapsedMs: number
    }
  | { id: number; kind: 'invalid' }
  | { id: number; kind: 'error'; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<SolveRequest>) => {
  const { id, text } = event.data
  try {
    const { a, b, targets } = parseInput(text)
    const started = ctx.performance.now()
    const { reachable, distinctA, distinctB } = solve(a, b, targets)
    const elapsedMs = ctx.performance.now() - started
    const response: SolveResponse = {
      id,
      kind: 'ok',
      targets,
      reachable,
      distinctA: distinctA.length,
      distinctB: distinctB.length,
      elapsedMs,
    }
    ctx.postMessage(response)
  } catch (err) {
    if (err instanceof InvalidInputError) {
      const response: SolveResponse = { id, kind: 'invalid' }
      ctx.postMessage(response)
    } else {
      const response: SolveResponse = {
        id,
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      }
      ctx.postMessage(response)
    }
  }
}
