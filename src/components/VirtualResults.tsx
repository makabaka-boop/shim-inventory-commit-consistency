import { memo, useEffect, useRef, useState } from 'react'

export const ROW_HEIGHT = 30
const OVERSCAN = 10

export interface ResultRowProps {
  index: number
  target: number
  reachable: boolean
}

function ResultRowComponent({ index, target, reachable }: ResultRowProps) {
  return (
    <div
      className={`result-row ${reachable ? 'is-reachable' : 'is-unreachable'}`}
      style={{ top: index * ROW_HEIGHT }}
    >
      <span className="cell-index">#{index + 1}</span>
      <span className="cell-target">{target}</span>
      <span className="cell-verdict">{reachable ? 'true' : 'false'}</span>
    </div>
  )
}

const MemoizedRow = memo(ResultRowComponent)

interface VirtualResultsProps {
  targets: number[]
  reachable: boolean[]
}

export function VirtualResults({ targets, reachable }: VirtualResultsProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const totalCount = targets.length

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setViewportHeight(entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Reset scroll when a fresh result set arrives.
  useEffect(() => {
    setScrollTop(0)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }, [targets])

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const end = Math.min(totalCount, start + visibleCount)
  const rows = []
  for (let i = start; i < end; i++) {
    rows.push(
      <MemoizedRow
        key={i}
        index={i}
        target={targets[i]}
        reachable={reachable[i]}
      />,
    )
  }

  return (
    <div
      className="results-viewport"
      ref={viewportRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className="results-spacer" style={{ height: totalCount * ROW_HEIGHT }}>
        {rows}
      </div>
    </div>
  )
}
