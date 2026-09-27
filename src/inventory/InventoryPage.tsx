import { useEffect, useState } from 'react'
import { QUARANTINE_REASON_LABEL } from './types'
import { useInventoryStore, type InventoryStore } from './store'
import { BatchList } from './components/BatchList'
import { BatchDetail } from './components/BatchDetail'
import { BatchForm } from './components/BatchForm'

interface InventoryPageProps {
  store: InventoryStore
}

/**
 * Physical shim-kit stocktake. State lives entirely in the injected store
 * (localStorage-backed by default) and is independent of the reachability
 * calculator's state — switching the top-level tabs never overwrites either
 * side.
 */
export function InventoryPage({ store }: InventoryPageProps) {
  const { snapshot, actions } = useInventoryStore(store)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Load once on mount; the store validates records one by one and isolates
  // anything corrupt or incompatible instead of failing the whole batch set.
  useEffect(() => {
    store.load()
  }, [store])

  const selected = selectedId ? snapshot.batches.find((b) => b.id === selectedId) ?? null : null

  if (!snapshot.loaded) {
    return (
      <div className="inventory-page">
        <p className="hint">正在读取本地盘点记录…</p>
      </div>
    )
  }

  return (
    <div className="inventory-page">
      <header className="page-header">
        <h1>实物垫片套装盘点</h1>
        <p className="subtitle">
          创建包含 A/B 级规格与账面数量的批次，逐项录入实点数并为差异填写处置结论；
          进度自动保存在浏览器本地存储，刷新后继续，结案后只读。
        </p>
      </header>

      {snapshot.loadError && (
        <div className="banner banner-error" role="alert">
          读取本地存储失败：{snapshot.loadError}
          <button type="button" onClick={() => actions.load()}>
            重新加载
          </button>
        </div>
      )}

      {snapshot.failure && (
        <div className="banner banner-error" role="alert">
          <strong>{snapshot.failure.quota ? '本地存储容量不足' : '写入失败'}</strong>
          <span>{snapshot.failure.message}。界面仍显示最后成功保存的版本。</span>
          <div className="actions">
            <button type="button" className="primary" onClick={() => actions.retry()}>
              重试本次写入
            </button>
            <button type="button" onClick={() => actions.dismissFailure()}>
              放弃并重试稍后
            </button>
          </div>
        </div>
      )}

      {snapshot.quarantined.length > 0 && (
        <div className="banner banner-warn" role="alert">
          <p>
            发现 {snapshot.quarantined.length}{' '}
            条损坏或不兼容的记录，已隔离，不影响其他批次盘点：
          </p>
          <ul className="quarantine-list">
            {snapshot.quarantined.map((entry) => (
              <li key={entry.storageKey}>
                <code>{entry.storageKey}</code> · {QUARANTINE_REASON_LABEL[entry.reason]} ·{' '}
                {entry.detail}
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              className="danger"
              onClick={() => actions.purgeQuarantine()}
            >
              清除隔离记录
            </button>
          </div>
        </div>
      )}

      {creating ? (
        <BatchForm
          submitLabel="创建草稿批次"
          onCancel={() => setCreating(false)}
          onSubmit={(input) => {
            const result = actions.createBatch(input)
            if (result.ok && result.id) {
              setCreating(false)
              setSelectedId(result.id)
            } else if (result.ruleError) {
              alert(result.ruleError.message)
            }
          }}
        />
      ) : selected ? (
        <BatchDetail
          batch={selected}
          actions={actions}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <BatchList
          batches={snapshot.batches}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={() => setCreating(true)}
          onDelete={(id) => {
            const batch = snapshot.batches.find((b) => b.id === id)
            if (batch && confirm(`删除草稿批次「${batch.name}」？`)) {
              actions.deleteBatch(id)
            }
          }}
        />
      )}
    </div>
  )
}
