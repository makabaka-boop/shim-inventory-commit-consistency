import type { StorageLike } from './repository'

export interface FakeStorageOptions {
  /** Byte-ish budget; null = unlimited. */
  quota?: number | null
  /** Keys whose setItem must throw (after N calls if > 1). */
  failWrites?: Map<string, { times: number; error: Error }>
  /** Corrupt the bytes stored for a key immediately after setItem. */
  corruptWrites?: Set<string>
  /** getItem returns a different string than was written (flip bit on read). */
  readbackSwap?: Map<string, string>
}

/**
 * Scriptable localStorage double for acceptance tests:
 *  - quota enforcement (capacity exhaustion)
 *  - per-key write exceptions, optionally only after N successful calls
 *  - write corruption and read-back substitution
 *  - full key enumeration like the real adapter
 */
export class FakeStorage implements StorageLike {
  private map = new Map<string, string>()
  remaining: number | null
  private _failWrites: Map<string, { times: number; error: Error }>
  private readonly failSeen = new Map<string, number>()
  corruptWrites: Set<string>
  readbackSwap: Map<string, string>
  readonly writes: { key: string; bytes: number; committed: boolean }[] = []
  readonly removes: string[] = []

  constructor(initial: Record<string, string> = {}, options: FakeStorageOptions = {}) {
    for (const [k, v] of Object.entries(initial)) this.map.set(k, v)
    this.remaining = options.quota === undefined ? null : options.quota
    this._failWrites = options.failWrites ?? new Map()
    this.corruptWrites = options.corruptWrites ?? new Set()
    this.readbackSwap = options.readbackSwap ?? new Map()
  }

  /** Replacing the fault plan resets per-key attempt counters. */
  set failWrites(value: Map<string, { times: number; error: Error }>) {
    this._failWrites = value
    this.failSeen.clear()
  }

  get failWrites(): Map<string, { times: number; error: Error }> {
    return this._failWrites
  }

  getItem(key: string): string | null {
    if (this.readbackSwap.has(key)) return this.readbackSwap.get(key)!
    return this.map.has(key) ? this.map.get(key)! : null
  }

  setItem(key: string, value: string): void {
    const plan = this.failWrites.get(key)
    if (plan) {
      const seen = (this.failSeen.get(key) ?? 0) + 1
      this.failSeen.set(key, seen)
      if (seen <= plan.times) throw plan.error
    }
    const oldSize = this.map.get(key)?.length ?? 0
    const delta = value.length - oldSize
    if (this.remaining !== null && delta > this.remaining) {
      const err = new Error("Failed to execute 'setItem': Setting the value exceeded the quota.")
      err.name = 'QuotaExceededError'
      throw err
    }
    this.map.set(key, value)
    if (this.remaining !== null) this.remaining -= delta
    if (this.corruptWrites.has(key)) {
      this.map.set(key, value === '' ? '' : value.slice(0, -1) + (value.endsWith('x') ? 'y' : 'x'))
    }
    let committed = false
    try {
      const parsed = JSON.parse(value) as { committed?: unknown }
      committed = parsed.committed === true
    } catch {
      /* raw/non-envelope writes */
    }
    this.writes.push({ key, bytes: value.length, committed })
  }

  removeItem(key: string): void {
    const size = this.map.get(key)?.length ?? 0
    this.map.delete(key)
    if (this.remaining !== null) this.remaining += size
    this.removes.push(key)
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  /** Test helper: raw storage size. */
  size(): number {
    let n = 0
    for (const v of this.map.values()) n += v.length
    return n
  }

  /** Test helper: snapshot all raw key/value pairs (refresh simulation). */
  dump(): Record<string, string> {
    return Object.fromEntries(this.map.entries())
  }

  /** Test helper: expose a stage key's presence. */
  hasStageFor(id: string): boolean {
    return this.map.has(`shim-stocktake:${id}::stage`)
  }

  dataKeyFor(id: string): string {
    return `shim-stocktake:${id}`
  }
}

export function quotaError(): Error {
  const err = new Error('QuotaExceeded')
  err.name = 'QuotaExceededError'
  return err
}
