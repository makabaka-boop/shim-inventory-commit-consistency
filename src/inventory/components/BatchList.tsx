import { STATUS_LABEL, type StocktakeBatch } from '../types'

interface BatchListProps {
  batches: StocktakeBatch[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

function diffCount(batch: StocktakeBatch): number {
  return batch.lines.reduce(
    (n, l) => n + (l.actualQty !== null && l.actualQty !== l.bookQty ? 1 : 0),
    0,
  )
}

function countedCount(batch: StocktakeBatch): number {
  return batch.lines.reduce((n, l) => n + (l.actualQty !== null ? 1 : 0), 0)
}

export function BatchList({
  batches,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: BatchListProps) {
  return (
    <div className="batch-list">
      <div className="batch-list-header">
        <h2>盘点批次</h2>
        <button type="button" className="primary" onClick={onCreate}>
          新建批次
        </button>
      </div>

      {batches.length === 0 ? (
        <p className="muted empty-batches">
          还没有盘点批次。点击「新建批次」录入 A/B 级规格与账面数量。
        </p>
      ) : (
        <ul className="batch-items">
          {batches.map((batch) => {
            const diffs = diffCount(batch)
            const counted = countedCount(batch)
            return (
              <li
                key={batch.id}
                className={`batch-item ${batch.id === selectedId ? 'selected' : ''} status-${batch.status}`}
              >
                <button
                  type="button"
                  className="batch-item-main"
                  onClick={() => onSelect(batch.id)}
                >
                  <span className="batch-name">{batch.name}</span>
                  <span className="batch-sub">
                    <span className={`status-pill status-${batch.status}`}>
                      {STATUS_LABEL[batch.status]}
                    </span>
                    <span className="muted">
                      {batch.lines.length} 行
                      {batch.status !== 'draft' &&
                        ` · 已计 ${counted}/${batch.lines.length}`}
                      {diffs > 0 && ` · ${diffs} 项差异`}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={batch.status === 'completed' ? '删除批次' : '删除批次（仅草稿可删除）'}
                  disabled={batch.status !== 'draft'}
                  onClick={() => onDelete(batch.id)}
                >
                  🗑
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
