import { describe, it, expect } from 'vitest'
import { FakeStorage, quotaError } from './fake-storage'
import { InventoryRepository, STORAGE_PREFIX } from './repository'
import { InventoryStore } from './store'
import type { LineDraft } from './schema'

const lines: LineDraft[] = [
  { level: 'A', spec: 10, bookQty: 5 },
  { level: 'B', spec: 20, bookQty: 7 },
]

function setup(initial?: Record<string, string>) {
  const storage = new FakeStorage(initial ?? {})
  const repo = new InventoryRepository(storage)
  const store = new InventoryStore(repo)
  store.load()
  return { storage, repo, store }
}

function fullBatch(store: InventoryStore): string {
  const created = store.createBatch({ name: '验收', lines })
  expect(created.ok).toBe(true)
  const id = created.id!
  expect(store.startCounting(id).ok).toBe(true)
  const batch = store.getSnapshot().batches.find((b) => b.id === id)!
  store.recordCount(id, batch.lines[0].id, 6)
  store.recordCount(id, batch.lines[1].id, 7)
  return id
}

describe('InventoryStore — snapshot only changes after durable commit', () => {
  it('create -> counting -> review -> completed and reload restores everything', () => {
    const { store, storage } = setup()
    const id = fullBatch(store)
    let result = store.advance(id)
    expect(result.ok).toBe(true)
    expect(store.getSnapshot().batches[0].status).toBe('review_required')

    const diffLine = store.getSnapshot().batches[0].lines[0]
    expect(store.resolveDifference(id, diffLine.id, 'actual_correct', '调账').ok).toBe(true)
    expect(store.advance(id).ok).toBe(true)
    expect(store.getSnapshot().batches[0].status).toBe('completed')

    // Simulate refresh: new repository/store over the same persisted bytes.
    const refreshed = new InventoryStore(
      new InventoryRepository(new FakeStorage(storage.dump())),
    )
    refreshed.load()
    const snap = refreshed.getSnapshot()
    expect(snap.quarantined).toHaveLength(0)
    expect(snap.batches).toHaveLength(1)
    const b = snap.batches[0]
    expect(b.id).toBe(id)
    expect(b.status).toBe('completed')
    expect(b.lines[0].actualQty).toBe(6)
    expect(b.lines[0].disposition).toBe('actual_correct')
    expect(b.lines[0].dispositionNote).toBe('调账')
    expect(b.lines[1].actualQty).toBe(7)
  })

  it('gate failures are rule errors and never touch storage or snapshot', () => {
    const { store, storage } = setup()
    const created = store.createBatch({ name: 'g', lines })
    const id = created.id!
    store.startCounting(id)
    const writesBefore = storage.writes.length
    const result = store.advance(id) // nothing counted yet
    expect(result.ok).toBe(false)
    expect(result.ruleError?.code).toBe('NOT_ALL_COUNTED')
    expect(storage.writes.length).toBe(writesBefore)
    expect(store.getSnapshot().failure).toBeNull()
    expect(store.getSnapshot().batches[0].status).toBe('counting')
  })

  it('read-only batch rejects all actions at the store level', () => {
    const { store } = setup()
    const id = fullBatch(store)
    store.advance(id)
    const line = store.getSnapshot().batches[0].lines[0]
    store.resolveDifference(id, line.id, 'book_correct')
    store.advance(id)
    expect(store.getSnapshot().batches[0].status).toBe('completed')

    const count = store.recordCount(id, line.id, 1)
    expect(count.ok).toBe(false)
    expect(count.ruleError?.code).toBe('INVALID_STATUS')
    expect(store.advance(id).ruleError?.code).toBe('INVALID_STATUS')
  })
})

describe('InventoryStore — storage failures show last good version + retry', () => {
  it('failed create does not appear in snapshot or storage', () => {
    // A tiny quota makes even the staging write overflow.
    const storage = new FakeStorage({}, { quota: 50 })
    const store = new InventoryStore(new InventoryRepository(storage))
    store.load()

    const result = store.createBatch({ name: 'x', lines })
    expect(result.ok).toBe(false)
    expect(result.storageError?.quota).toBe(true)
    expect(result.storageError?.stage).toBe('stage')
    expect(store.getSnapshot().batches).toHaveLength(0)
    expect(store.getSnapshot().failure).not.toBeNull()
    // No live record leaked, no stage residue.
    expect(storage.keys().filter((k) => !k.endsWith('::stage'))).toHaveLength(0)
    expect(storage.keys().filter((k) => k.endsWith('::stage'))).toHaveLength(0)
  })

  it('keeps last successful version when an update fails, and retry commits it', () => {
    const { store, storage } = setup()
    const id = fullBatch(store)
    expect(store.getSnapshot().batches[0].status).toBe('counting')

    const liveKey = `${STORAGE_PREFIX}${id}`
    storage.failWrites = new Map([[liveKey, { times: 1, error: quotaError() }]])

    const failed = store.advance(id) // counting -> review
    expect(failed.ok).toBe(false)
    expect(failed.storageError?.stage).toBe('commit')
    // Snapshot keeps the last committed state.
    expect(store.getSnapshot().batches[0].status).toBe('counting')
    expect(store.getSnapshot().failure?.quota).toBe(true)

    // Storage layer also still serves the old committed record.
    const reloaded = new InventoryRepository(storage).load()
    expect(reloaded.batches[0].status).toBe('counting')

    // Same operation retried verbatim now succeeds.
    storage.failWrites = new Map()
    const retried = store.retry()
    expect(retried.ok).toBe(true)
    expect(store.getSnapshot().batches[0].status).toBe('review_required')
    expect(store.getSnapshot().failure).toBeNull()

    const line = store.getSnapshot().batches[0].lines[0]
    store.resolveDifference(id, line.id, 'recheck')
    expect(store.advance(id).ok).toBe(true)
    expect(store.getSnapshot().batches[0].status).toBe('completed')
  })

  it('load quarantines bad records but keeps good batches usable', () => {
    const goodEnvelope = JSON.stringify({
      version: 2,
      committed: true,
      savedAt: 1,
      batch: {
        id: 'good',
        name: '好批次',
        createdAt: 1,
        updatedAt: 1,
        status: 'draft',
        lines: [{ id: 'l1', level: 'A', spec: 3, bookQty: 1, actualQty: null }],
      },
    })
    const storage = new FakeStorage({
      [`${STORAGE_PREFIX}good`]: goodEnvelope,
      [`${STORAGE_PREFIX}broken`]: 'not-json{',
    })
    const store = new InventoryStore(new InventoryRepository(storage))
    store.load()
    const snap = store.getSnapshot()
    expect(snap.batches).toHaveLength(1)
    expect(snap.batches[0].id).toBe('good')
    expect(snap.quarantined).toHaveLength(1)
    expect(snap.quarantined[0].reason).toBe('unparseable')

    // The good batch is still fully operable.
    expect(store.startCounting('good').ok).toBe(true)
    const line = store.getSnapshot().batches[0].lines[0]
    store.recordCount('good', line.id, 1)
    expect(store.advance('good').ok).toBe(true)
    expect(store.getSnapshot().batches[0].status).toBe('completed')
  })
})
