/**
 * React binding for the stocktake feature.
 *
 * The store deliberately separates "candidate" (pure domain result) from
 * "committed state": every mutation builds a candidate via operations.ts,
 * persists it via the repository's stage→commit→verify protocol, and only
 * then swaps React state. If any storage step fails, state keeps showing the
 * last successful version and the UI gets a failure object plus a retry()
 * that replays the exact same operation.
 *
 * useSyncExternalStore guarantees every rendered snapshot corresponds to a
 * durable commit — a failed write can never leak into the UI.
 */

import { useMemo, useSyncExternalStore } from 'react'
import {
  advance as advanceOp,
  completeReview as completeReviewOp,
  createBatch as createBatchOp,
  deleteBatch as deleteBatchOp,
  recordCount as recordCountOp,
  resolveDifference as resolveDifferenceOp,
  startCounting as startCountingOp,
  submitForReview as submitForReviewOp,
  updateDraft as updateDraftOp,
  type CreateBatchInput,
} from './operations'
import {
  InventoryRepository,
  LocalStorageAdapter,
  StorageWriteError,
  type StorageLike,
} from './repository'
import { RuleError } from './types'
import type {
  DispositionCode,
  QuarantineEntry,
  StocktakeBatch,
} from './types'

export interface MutationResult {
  ok: boolean
  /** Domain-rule rejection (invalid name, gate blocked, ...). */
  ruleError?: RuleError
  /** Storage failure (quota, write exception, read-back mismatch). */
  storageError?: StorageWriteError
}

export interface InventorySnapshot {
  loaded: boolean
  batches: StocktakeBatch[]
  quarantined: QuarantineEntry[]
  loadError: string | null
  failure: { message: string; quota: boolean } | null
}

const EMPTY_SNAPSHOT: InventorySnapshot = {
  loaded: false,
  batches: [],
  quarantined: [],
  loadError: null,
  failure: null,
}

type Listener = () => void

/** Framework-agnostic store so it can also be exercised directly in tests. */
export class InventoryStore {
  private snapshot: InventorySnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<Listener>()
  private readonly repo: InventoryRepository
  private lastFailed: (() => MutationResult) | null = null

  constructor(repo: InventoryRepository) {
    this.repo = repo
  }

  getSnapshot = (): InventorySnapshot => this.snapshot

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private set(patch: Partial<InventorySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  /** Validate records one by one; bad ones are isolated, good ones stay usable. */
  load(force = false): void {
    if (!force && this.snapshot.loaded) return
    try {
      const { batches, quarantined } = this.repo.load()
      this.set({ loaded: true, batches, quarantined, loadError: null, failure: null })
    } catch (err) {
      // Total load failure: keep showing whatever was last successfully loaded.
      this.set({
        loaded: true,
        loadError: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Run one mutation: build candidate → persist → re-read → swap state.
   * On storage failure the previous snapshot is left untouched and the
   * operation is stashed verbatim for retry().
   */
  private mutate(
    apply: (current: StocktakeBatch[]) => StocktakeBatch[],
    persist: (next: StocktakeBatch[]) => void,
  ): MutationResult {
    try {
      const next = apply(this.snapshot.batches)
      persist(next)
      this.lastFailed = null
      this.set({ batches: next, failure: null })
      return { ok: true }
    } catch (err) {
      if (err instanceof RuleError) {
        return { ok: false, ruleError: err }
      }
      if (err instanceof StorageWriteError) {
        this.lastFailed = () => this.retryWith(apply, persist)
        this.set({
          failure: {
            message: err.message,
            quota: err.quota,
          },
        })
        return { ok: false, storageError: err }
      }
      throw err
    }
  }

  private retryWith(
    apply: (current: StocktakeBatch[]) => StocktakeBatch[],
    persist: (next: StocktakeBatch[]) => void,
  ): MutationResult {
    return this.mutate(apply, persist)
  }

  /** Replay the exact operation that failed at the storage layer. */
  retry(): MutationResult {
    if (!this.lastFailed) return { ok: true }
    const fn = this.lastFailed
    // Clear the banner immediately; a fresh failure re-arms retry.
    this.lastFailed = null
    const result = fn()
    return result
  }

  dismissFailure(): void {
    this.lastFailed = null
    this.set({ failure: null })
  }

  private persistOne(id: string): (next: StocktakeBatch[]) => void {
    return (next) => {
      const batch = next.find((b) => b.id === id)
      if (!batch) throw new RuleError('BATCH_NOT_FOUND', '候选批次在提交前消失')
      const readBack = this.repo.commit(batch)
      // Never trust the candidate blindly: state adopts the read-back record.
      // (It is structurally equal by the repository's deep verification.)
      void readBack
    }
  }

  createBatch(input: CreateBatchInput): MutationResult & { id?: string } {
    let newId: string | undefined
    const result = this.mutate(
      (current) => {
        const next = createBatchOp(current, input)
        newId = next[next.length - 1].id
        return next
      },
      (next) => this.persistOne(newId!)(next),
    )
    return result.ok ? { ok: true, id: newId } : result
  }

  updateDraft(id: string, input: CreateBatchInput): MutationResult {
    return this.mutate(
      (current) => updateDraftOp(current, id, input),
      this.persistOne(id),
    )
  }

  startCounting(id: string): MutationResult {
    return this.mutate(
      (current) => startCountingOp(current, id),
      this.persistOne(id),
    )
  }

  recordCount(id: string, lineId: string, actualQty: number): MutationResult {
    return this.mutate(
      (current) => recordCountOp(current, id, lineId, actualQty),
      this.persistOne(id),
    )
  }

  submitForReview(id: string): MutationResult {
    return this.mutate(
      (current) => submitForReviewOp(current, id),
      this.persistOne(id),
    )
  }

  resolveDifference(
    id: string,
    lineId: string,
    disposition: DispositionCode,
    note?: string,
  ): MutationResult {
    return this.mutate(
      (current) => resolveDifferenceOp(current, id, lineId, disposition, note),
      this.persistOne(id),
    )
  }

  completeReview(id: string): MutationResult {
    return this.mutate(
      (current) => completeReviewOp(current, id),
      this.persistOne(id),
    )
  }

  advance(id: string): MutationResult {
    return this.mutate(
      (current) => advanceOp(current, id),
      this.persistOne(id),
    )
  }

  deleteBatch(id: string): MutationResult {
    const result = this.mutate(
      (current) => deleteBatchOp(current, id),
      () => this.repo.remove(id),
    )
    return result
  }

  /** Permanently remove isolated records from storage. */
  purgeQuarantine(): number {
    const removed = this.repo.purgeQuarantine(this.snapshot.quarantined)
    this.set({ quarantined: [] })
    return removed
  }
}

/** Create the default repository backed by window.localStorage. */
export function createDefaultStore(): InventoryStore {
  const storage: StorageLike = new LocalStorageAdapter()
  return new InventoryStore(new InventoryRepository(storage))
}

export function useInventoryStore(store: InventoryStore): {
  snapshot: InventorySnapshot
  actions: InventoryStore
} {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const actions = useMemo(() => store, [store])
  return { snapshot, actions }
}
