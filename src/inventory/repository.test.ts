import { describe, it, expect } from 'vitest'
import { FakeStorage, quotaError } from './fake-storage'
import {
  CURRENT_RECORD_VERSION,
  MigrationError,
} from './migrations'
import {
  InventoryRepository,
  STORAGE_PREFIX,
  StorageWriteError,
  type StorageLike,
} from './repository'
import { createBatch, recordCount, startCounting, submitForReview, resolveDifference, advance } from './operations'
import type { StocktakeBatch } from './types'

function makeBatch(): StocktakeBatch[] {
  return createBatch([], {
    name: '验收批次',
    lines: [
      { level: 'A', spec: 10, bookQty: 5 },
      { level: 'B', spec: 20, bookQty: 7 },
    ],
    now: 1000,
  })
}

/** envelope -> JSON for the live data key */
function envelope(batch: unknown, version = CURRENT_RECORD_VERSION, committed = true): string {
  return JSON.stringify({ version, committed, savedAt: 123, batch })
}

describe('repository — commit protocol', () => {
  it('writes stage then live record with committed marker and sweeps stage', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    const batches = makeBatch()
    const returned = repo.commit(batches[0])

    // stage write happened first (uncommitted marker), live write second
    const writes = storage.writes.filter((w) => w.key.includes(batches[0].id))
    expect(writes[0].key.endsWith('::stage')).toBe(true)
    expect(writes[0].committed).toBe(false)
    expect(writes[1].committed).toBe(true)
    expect(storage.hasStageFor(batches[0].id)).toBe(false)

    // state adopts the read-back batch
    expect(returned.id).toBe(batches[0].id)
    const loaded = repo.load()
    expect(loaded.batches).toHaveLength(1)
    expect(loaded.quarantined).toHaveLength(0)
  })

  it('STAGE quota failure: live record is never created, no leak', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    const batches = makeBatch()
    const stageKey = `${STORAGE_PREFIX}${batches[0].id}::stage`
    storage.failWrites = new Map([[stageKey, { times: 1, error: quotaError() }]])

    let err: unknown
    try {
      repo.commit(batches[0])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StorageWriteError)
    expect((err as StorageWriteError).quota).toBe(true)
    expect((err as StorageWriteError).stage).toBe('stage')

    // Nothing for this id may be readable as a valid record.
    const loaded = repo.load()
    expect(loaded.batches).toHaveLength(0)
    expect(storage.hasStageFor(batches[0].id)).toBe(false)
  })

  it('STAGE read-back inconsistency: aborts before touching the live key', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    const batches = makeBatch()
    const stageKey = `${STORAGE_PREFIX}${batches[0].id}::stage`
    storage.corruptWrites = new Set([stageKey])

    let err: unknown
    try {
      repo.commit(batches[0])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StorageWriteError)
    expect((err as StorageWriteError).stage).toBe('stage')

    const liveRaw = storage.getItem(`${STORAGE_PREFIX}${batches[0].id}`)
    expect(liveRaw).toBeNull()
    expect(repo.load().batches).toHaveLength(0)
  })

  it('COMMIT quota failure: previous version is preserved and reload shows it', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    let batches = makeBatch()
    repo.commit(batches[0]) // v1 persisted

    // advance to counting, then make the live write fail with quota
    batches = startCounting(batches, batches[0].id)
    batches = recordCount(batches, batches[0].id, batches[0].lines[0].id, 5)
    batches = recordCount(batches, batches[0].id, batches[0].lines[1].id, 7)
    batches = submitForReview(batches, batches[0].id) // no diffs -> completed candidate
    const liveKey = `${STORAGE_PREFIX}${batches[0].id}`
    storage.failWrites = new Map([[liveKey, { times: 1, error: quotaError() }]])

    let err: unknown
    try {
      repo.commit(batches[0])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StorageWriteError)
    expect((err as StorageWriteError).stage).toBe('commit')
    expect((err as StorageWriteError).quota).toBe(true)

    // Last successful version is still served.
    const loaded = repo.load()
    expect(loaded.batches).toHaveLength(1)
    expect(loaded.batches[0].status).toBe('draft')
    expect(storage.hasStageFor(batches[0].id)).toBe(false)

    // Free quota and retry the same candidate: now commits.
    storage.failWrites = new Map()
    repo.commit(batches[0])
    expect(repo.load().batches[0].status).toBe('completed')
  })

  it('COMMIT read-back mismatch: rolls back to the previous raw record', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    let batches = makeBatch()
    repo.commit(batches[0])

    batches = startCounting(batches, batches[0].id)
    const liveKey = `${STORAGE_PREFIX}${batches[0].id}`
    // The live write "succeeds" but every read *after* that write returns
    // different bytes (bit-flip in transit). Reads before it (previousRaw)
    // must still see the genuinely committed record.
    const tampered = JSON.stringify({
      version: CURRENT_RECORD_VERSION,
      committed: true,
      savedAt: 9,
      batch: { tampered: true },
    })
    let liveWritten = false
    const flaky: StorageLike = {
      getItem: (key) => (key === liveKey && liveWritten ? tampered : storage.getItem(key)),
      setItem: (key, value) => {
        storage.setItem(key, value)
        if (key === liveKey) liveWritten = true
      },
      removeItem: (key) => storage.removeItem(key),
      keys: () => storage.keys(),
    }
    const flakyRepo = new InventoryRepository(flaky)
    expect(() => flakyRepo.commit(batches[0])).toThrow(StorageWriteError)

    // Rollback restored the exact previous text into the underlying store.
    const reloaded = new InventoryRepository(storage).load()
    expect(reloaded.batches).toHaveLength(1)
    expect(reloaded.batches[0].status).toBe('draft')
  })

  it('failed writes never leak: repository stays internally consistent across a full lifecycle with flaky storage', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    let batches = makeBatch()
    const id = batches[0].id
    const liveKey = `${STORAGE_PREFIX}${id}`

    // Fail one live write at each advance stage; candidate never becomes truth.
    batches = startCounting(batches, id)
    storage.failWrites = new Map([[liveKey, { times: 1, error: quotaError() }]])
    expect(() => repo.commit(batches[0])).toThrow(StorageWriteError)
    storage.failWrites = new Map()
    repo.commit(batches[0])
    expect(repo.load().batches[0].status).toBe('counting')

    batches = recordCount(batches, id, batches[0].lines[0].id, 6)
    batches = recordCount(batches, id, batches[0].lines[1].id, 7)
    batches = submitForReview(batches, id) // one diff -> review_required
    storage.failWrites = new Map([[liveKey, { times: 1, error: quotaError() }]])
    expect(() => repo.commit(batches[0])).toThrow(StorageWriteError)
    storage.failWrites = new Map()
    repo.commit(batches[0])
    expect(repo.load().batches[0].status).toBe('review_required')

    batches = resolveDifference(batches, id, batches[0].lines[0].id, 'recheck')
    batches = advance(batches, id)
    storage.failWrites = new Map([[liveKey, { times: 1, error: quotaError() }]])
    expect(() => repo.commit(batches[0])).toThrow(StorageWriteError)
    storage.failWrites = new Map()
    const finalBatch = repo.commit(batches[0])
    expect(finalBatch.status).toBe('completed')
    expect(repo.load().batches[0].status).toBe('completed')
  })

  it('delete verifies the record is gone', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    const batches = makeBatch()
    repo.commit(batches[0])
    repo.remove(batches[0].id)
    expect(repo.load().batches).toHaveLength(0)
  })

  it('COMMIT verify failure + failed rollback: flags ambiguous and keeps evidence', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    let batches = makeBatch()
    repo.commit(batches[0]) // draft committed
    batches = startCounting(batches, batches[0].id)
    const liveKey = `${STORAGE_PREFIX}${batches[0].id}`
    const stageKey = `${liveKey}::stage`

    // After the live write lands, every read returns null and every further
    // live write (the rollback) throws: the commit result is unverifiable.
    let landed = false
    const broken: StorageLike = {
      getItem: (key) => (key === liveKey && landed ? null : storage.getItem(key)),
      setItem: (key, value) => {
        if (key === liveKey) {
          if (landed) throw quotaError() // rollback write fails
          storage.setItem(key, value)
          landed = true
        } else {
          storage.setItem(key, value)
        }
      },
      removeItem: (key) => storage.removeItem(key),
      keys: () => storage.keys(),
    }
    const brokenRepo = new InventoryRepository(broken)

    let err: unknown
    try {
      brokenRepo.commit(batches[0])
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StorageWriteError)
    expect((err as StorageWriteError).stage).toBe('commit')
    expect((err as StorageWriteError).indoubt).toBe(true)

    // The unconfirmed candidate physically landed...
    const raw = JSON.parse(storage.getItem(liveKey)!)
    expect(raw.committed).toBe(true)
    expect(raw.batch.status).toBe('counting')
    // ...and durable evidence survives next to it.
    const evidence = JSON.parse(storage.getItem(stageKey)!)
    expect(evidence.committed).toBe(false)
    expect(evidence.indoubt).toBe(true)
    expect(typeof evidence.previousRaw).toBe('string')
    const previous = JSON.parse(evidence.previousRaw)
    expect(previous.batch.status).toBe('draft')
  })

  it('refresh after an ambiguous push isolates the unconfirmed batch instead of loading it', () => {
    const { storage, id } = seedAmbiguous()

    // A healthy new tab loads the same bytes: the candidate that landed must
    // NOT silently become the effective batch.
    const fresh = new InventoryRepository(new FakeStorage(storage.dump())).load()
    expect(fresh.batches).toHaveLength(0)
    expect(fresh.quarantined).toHaveLength(1)
    const entry = fresh.quarantined[0]
    expect(entry.reason).toBe('ambiguous_commit')
    expect(entry.storageKey).toBe(`${STORAGE_PREFIX}${id}`)
    expect(entry.resolution?.kind).toBe('ambiguous_commit')
    expect(entry.resolution?.batchId).toBe(id)
    expect(entry.resolution?.candidateStatus).toBe('counting')
    expect(entry.resolution?.previousStatus).toBe('draft')
  })

  it('ambiguous push can be explicitly adopted, after which refresh loads counting', () => {
    const { storage, id } = seedAmbiguous()
    const repoStorage = new FakeStorage(storage.dump())
    const repo = new InventoryRepository(repoStorage)
    const entry = repo.load().quarantined[0]

    const adopted = repo.resolveAmbiguous(entry, 'adopt')
    expect(adopted?.id).toBe(id)
    expect(adopted?.status).toBe('counting')

    const reloaded = new InventoryRepository(new FakeStorage(repoStorage.dump())).load()
    expect(reloaded.quarantined).toHaveLength(0)
    expect(reloaded.batches).toHaveLength(1)
    expect(reloaded.batches[0].status).toBe('counting')
    expect(repoStorage.hasStageFor(id)).toBe(false)
  })

  it('ambiguous push can be explicitly reverted, after which refresh loads the draft', () => {
    const { storage, id } = seedAmbiguous()
    const repoStorage = new FakeStorage(storage.dump())
    const repo = new InventoryRepository(repoStorage)
    const entry = repo.load().quarantined[0]

    const reverted = repo.resolveAmbiguous(entry, 'revert')
    expect(reverted).toBeNull()

    const reloaded = new InventoryRepository(new FakeStorage(repoStorage.dump())).load()
    expect(reloaded.quarantined).toHaveLength(0)
    expect(reloaded.batches).toHaveLength(1)
    expect(reloaded.batches[0].id).toBe(id)
    expect(reloaded.batches[0].status).toBe('draft')
    expect(repoStorage.hasStageFor(id)).toBe(false)
  })

  it('indoubt evidence is auto-cleared when the live bytes provably equal the previous version', () => {
    const { storage, id, previousRaw } = seedAmbiguous()
    // Simulate that the rollback actually durably restored the old bytes,
    // even though the original tab could not verify it (hijacked reads).
    storage.setItem(`${STORAGE_PREFIX}${id}`, previousRaw)

    const repoStorage = new FakeStorage(storage.dump())
    const reloaded = new InventoryRepository(repoStorage).load()
    expect(reloaded.quarantined).toHaveLength(0)
    expect(reloaded.batches).toHaveLength(1)
    expect(reloaded.batches[0].status).toBe('draft')
    expect(repoStorage.hasStageFor(id)).toBe(false)
  })

  it('indoubt evidence with a missing live record auto-restores the previous version', () => {
    const { storage, id } = seedAmbiguous()
    storage.removeItem(`${STORAGE_PREFIX}${id}`)

    const repoStorage = new FakeStorage(storage.dump())
    const reloaded = new InventoryRepository(repoStorage).load()
    expect(reloaded.quarantined).toHaveLength(0)
    expect(reloaded.batches).toHaveLength(1)
    expect(reloaded.batches[0].status).toBe('draft')
    expect(repoStorage.hasStageFor(id)).toBe(false)
  })
})

/**
 * Seed the exact reported failure: draft -> counting push whose read-back
 * verification fails while the candidate physically landed, and whose
 * rollback cannot be verified. Returns the raw bytes a refresh would see.
 */
function seedAmbiguous(): { storage: FakeStorage; id: string; previousRaw: string } {
  const storage = new FakeStorage()
  let batches = makeBatch()
  new InventoryRepository(storage).commit(batches[0])
  const id = batches[0].id
  const liveKey = `${STORAGE_PREFIX}${id}`
  const previousRaw = storage.getItem(liveKey)!
  batches = startCounting(batches, id)

  let landed = false
  const broken: StorageLike = {
    getItem: (key) => (key === liveKey && landed ? null : storage.getItem(key)),
    setItem: (key, value) => {
      if (key === liveKey) {
        if (landed) throw quotaError()
        storage.setItem(key, value)
        landed = true
      } else {
        storage.setItem(key, value)
      }
    },
    removeItem: (key) => storage.removeItem(key),
    keys: () => storage.keys(),
  }
  expect(() => new InventoryRepository(broken).commit(batches[0])).toThrow(StorageWriteError)
  return { storage, id, previousRaw }
}

describe('repository — load validation & quarantine', () => {
  function put(storage: FakeStorage, id: string, raw: string) {
    storage.setItem(`${STORAGE_PREFIX}${id}`, raw)
  }

  it('isolates corrupt / incompatible records while valid batches remain countable', () => {
    const storage = new FakeStorage()
    const good = makeBatch()[0]
    put(storage, 'good', envelope(good))
    put(storage, 'syntax-broken', '{not json')
    put(storage, 'no-version', JSON.stringify({ committed: true, batch: {} }))
    put(storage, 'bad-envelope', JSON.stringify({ version: 2, committed: 'nope', batch: {} }))
    put(
      storage,
      'future',
      envelope({ id: 'z' }, CURRENT_RECORD_VERSION + 1),
    )
    put(storage, 'uncommitted', envelope(good, 2, false))
    put(storage, 'invalid-batch', envelope({ id: 'x', name: '', lines: [] }))

    // leftover stage key from a crash: swept, not quarantined
    storage.setItem(`${STORAGE_PREFIX}some-id::stage`, envelope(good, 2, false))

    const repo = new InventoryRepository(storage)
    const { batches, quarantined } = repo.load()

    expect(batches).toHaveLength(1)
    expect(batches[0].id).toBe(good.id)
    const reasons = Object.fromEntries(
      quarantined.map((q) => [q.storageKey.split(':').pop(), q.reason]),
    )
    expect(reasons['syntax-broken']).toBe('unparseable')
    expect(reasons['no-version']).toBe('bad_envelope')
    expect(reasons['bad-envelope']).toBe('bad_envelope')
    expect(reasons['future']).toBe('unsupported_version')
    expect(reasons['uncommitted']).toBe('uncommitted_record')
    expect(reasons['invalid-batch']).toBe('invalid_batch')
    expect(storage.hasStageFor('some-id')).toBe(false)

    // Good batch is fully workable despite the quarantine neighborhood.
    expect(batches[0].status).toBe('draft')
  })

  it('illegal migration isolates the record instead of crashing load', () => {
    const storage = new FakeStorage()
    put(
      storage,
      'legacy-bad',
      JSON.stringify({
        version: 1,
        committed: true,
        savedAt: 1,
        batch: { id: 'legacy-bad', title: '', entries: [] },
      }),
    )
    const good = makeBatch()[0]
    put(storage, 'good', envelope(good))

    const repo = new InventoryRepository(storage)
    const { batches, quarantined } = repo.load()
    expect(batches).toHaveLength(1)
    expect(batches[0].id).toBe(good.id)
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0].reason).toBe('invalid_migration')
  })

  it('a v1 record migrated by an injected throwing migration is isolated', () => {
    const storage = new FakeStorage()
    put(
      storage,
      'legacy',
      JSON.stringify({ version: 1, committed: true, savedAt: 1, batch: { id: 'legacy' } }),
    )
    const repo = new InventoryRepository(storage, {
      migrate: () => {
        throw new MigrationError('注入的非法迁移')
      },
    })
    const { batches, quarantined } = repo.load()
    expect(batches).toHaveLength(0)
    expect(quarantined[0].reason).toBe('invalid_migration')
    expect(quarantined[0].detail).toContain('注入的非法迁移')
  })

  it('purgeQuarantine removes only the isolated keys', () => {
    const storage = new FakeStorage()
    put(storage, 'good', envelope(makeBatch()[0]))
    put(storage, 'bad', '{')
    const repo = new InventoryRepository(storage)
    const { quarantined } = repo.load()
    const removed = repo.purgeQuarantine(quarantined)
    expect(removed).toBe(1)
    expect(storage.getItem(`${STORAGE_PREFIX}bad`)).toBeNull()
    expect(storage.getItem(`${STORAGE_PREFIX}good`)).not.toBeNull()
  })

  it('progress and dispositions survive a reload (refresh simulation)', () => {
    const storage = new FakeStorage()
    const repo = new InventoryRepository(storage)
    let batches = makeBatch()
    const id = batches[0].id
    repo.commit(batches[0])
    batches = startCounting(batches, id)
    repo.commit(batches[0])
    batches = recordCount(batches, id, batches[0].lines[0].id, 9)
    batches = recordCount(batches, id, batches[0].lines[1].id, 7)
    repo.commit(batches[0])
    batches = submitForReview(batches, id)
    repo.commit(batches[0])
    batches = resolveDifference(batches, id, batches[0].lines[0].id, 'write_off', '破损报废')
    repo.commit(batches[0])

    const fresh = new InventoryRepository(new FakeStorage(storageCopy(storage))).load()
    expect(fresh.batches).toHaveLength(1)
    const b = fresh.batches[0]
    expect(b.status).toBe('review_required')
    expect(b.lines[0].actualQty).toBe(9)
    expect(b.lines[0].disposition).toBe('write_off')
    expect(b.lines[0].dispositionNote).toBe('破损报废')
    expect(b.lines[1].actualQty).toBe(7)
  })
})

function storageCopy(storage: FakeStorage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of storage.keys()) {
    const v = storage.getItem(key)
    if (v !== null) out[key] = v
  }
  return out
}
