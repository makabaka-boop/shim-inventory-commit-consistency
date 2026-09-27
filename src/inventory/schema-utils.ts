/** Small structural helpers shared by validation, migrations and storage. */

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Structural equality for JSON-shaped values. Used for read-back verification:
 * after a write the repository parses the stored string and requires it to be
 * deeply equal to the candidate that was written. Comparison follows JSON
 * round-trip semantics: a property whose value is `undefined` is treated as
 * absent (JSON.stringify drops it).
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // null/undefined both have no JSON representation of their own.
  if (a === undefined || b === undefined) return a === b
  if (typeof a !== typeof b) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!jsonDeepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
    if (ka.length !== kb.length) return false
    for (const key of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!jsonDeepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}
