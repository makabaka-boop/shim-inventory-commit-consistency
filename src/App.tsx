import { useRef, useState } from 'react'
import { ReachabilityPage } from './pages/ReachabilityPage'
import { InventoryPage } from './inventory/InventoryPage'
import { InventoryStore } from './inventory/store'
import {
  InventoryRepository,
  LocalStorageAdapter,
} from './inventory/repository'

type Tab = 'reachability' | 'inventory'

const TABS: { id: Tab; label: string }[] = [
  { id: 'reachability', label: '可达性计算' },
  { id: 'inventory', label: '实物垫片套装盘点' },
]

/**
 * Top-level shell: the reachability calculator and the physical-kit
 * stocktake are two并列 entries. Both pages stay mounted while the app runs
 * and are toggled with CSS, so each side keeps its own state/data and neither
 * overwrites the other.
 */
export default function App() {
  const [tab, setTab] = useState<Tab>('reachability')
  const inventoryStoreRef = useRef<InventoryStore | null>(null)
  if (inventoryStoreRef.current === null) {
    inventoryStoreRef.current = new InventoryStore(
      new InventoryRepository(new LocalStorageAdapter()),
    )
  }

  return (
    <div className="app-shell">
      <nav className="top-nav" aria-label="主导航">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-tab ${tab === item.id ? 'active' : ''}`}
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div hidden={tab !== 'reachability'}>
        <ReachabilityPage />
      </div>
      <div hidden={tab !== 'inventory'}>
        <InventoryPage store={inventoryStoreRef.current} />
      </div>
    </div>
  )
}
