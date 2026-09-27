/**
 * Input validation for shim reachability.
 *
 * Contract:
 *   - root object must contain exactly the keys `a`, `b`, `targets`
 *   - `a`, `b`, `targets` are arrays
 *   - `a`, `b` contain 1..100_000 integers in [0, 200_000]
 *   - `targets` contains 1..100_000 integers in [0, 400_000]
 *
 * Any violation (including malformed JSON) rejects with the sentinel
 * message INVALID_INPUT. Duplicate values are allowed by the contract;
 * they represent the same physical shim specification and are deduplicated
 * downstream.
 */

export const SHIM_MIN = 0
export const SHIM_MAX = 200_000
export const SHIM_LIST_MIN_LEN = 1
export const SHIM_LIST_MAX_LEN = 100_000
export const TARGET_MIN = 0
export const TARGET_MAX = 400_000
export const TARGET_LIST_MIN_LEN = 1
export const TARGET_LIST_MAX_LEN = 100_000

export const INVALID_INPUT = 'INVALID_INPUT'

export interface ReachabilityInput {
  a: number[]
  b: number[]
  targets: number[]
}

export class InvalidInputError extends Error {
  constructor() {
    super(INVALID_INPUT)
    this.name = 'InvalidInputError'
  }
}

/**
 * Parse and validate user-supplied JSON text.
 * Throws InvalidInputError for malformed JSON or any contract violation.
 */
export function parseInput(text: string): ReachabilityInput {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new InvalidInputError()
  }
  return validateInput(data)
}

export function validateInput(data: unknown): ReachabilityInput {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new InvalidInputError()
  }
  const obj = data as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  if (keys.length !== 3 || keys[0] !== 'a' || keys[1] !== 'b' || keys[2] !== 'targets') {
    throw new InvalidInputError()
  }
  const a = validateIntegerArray(obj.a, SHIM_LIST_MIN_LEN, SHIM_LIST_MAX_LEN, SHIM_MIN, SHIM_MAX)
  const b = validateIntegerArray(obj.b, SHIM_LIST_MIN_LEN, SHIM_LIST_MAX_LEN, SHIM_MIN, SHIM_MAX)
  const targets = validateIntegerArray(obj.targets, TARGET_LIST_MIN_LEN, TARGET_LIST_MAX_LEN, TARGET_MIN, TARGET_MAX)
  return { a, b, targets }
}

function validateIntegerArray(
  value: unknown,
  minLen: number,
  maxLen: number,
  min: number,
  max: number,
): number[] {
  if (!Array.isArray(value)) throw new InvalidInputError()
  if (value.length < minLen || value.length > maxLen) throw new InvalidInputError()
  const result: number[] = new Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max) {
      throw new InvalidInputError()
    }
    result[i] = item
  }
  return result
}
