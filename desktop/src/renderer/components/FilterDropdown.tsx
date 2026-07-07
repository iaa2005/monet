import { useState, useRef, useEffect } from 'react'
import { Filter, ChevronDown, ChevronRight, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type FilterOption = {
  label: string
  value: string
}

type Submenu = {
  label: string
  options: FilterOption[]
  selected: string
  onSelect: (value: string) => void
}

const STATUS_OPTS: FilterOption[] = [
  { label: 'Active', value: 'active' },
  { label: 'Archived', value: 'archived' },
  { label: 'All', value: 'all' },
]
const ACTIVITY_OPTS: FilterOption[] = [
  { label: '1d', value: '1d' },
  { label: '3d', value: '3d' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: 'All', value: 'all' },
]
const GROUP_OPTS: FilterOption[] = [
  { label: 'Date', value: 'date' },
  { label: 'State', value: 'state' },
  { label: 'PR status', value: 'pr' },
  { label: 'Custom groups', value: 'custom' },
  { label: '—', value: 'divider' },
  { label: 'None', value: 'none' },
]
const SORT_OPTS: FilterOption[] = [
  { label: 'Recency', value: 'recency' },
  { label: 'Name', value: 'name' },
  { label: 'Activity', value: 'activity' },
]

export function FilterDropdown(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<string | null>(null)
  const [status, setStatus] = useState('all')
  const [activity, setActivity] = useState('all')
  const [group, setGroup] = useState('none')
  const [sort, setSort] = useState('recency')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const subs: Submenu[] = [
    { label: 'Status', options: STATUS_OPTS, selected: status, onSelect: setStatus },
    { label: 'Last activity', options: ACTIVITY_OPTS, selected: activity, onSelect: setActivity },
    { label: 'Group by', options: GROUP_OPTS, selected: group, onSelect: setGroup },
    { label: 'Sort by', options: SORT_OPTS, selected: sort, onSelect: setSort },
  ]

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
        <Filter size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-50 w-44 rounded-lg border border-border bg-popover p-1 shadow-md text-xs">
          {submenu ? (
            <>
              <button onClick={() => setSubmenu(null)}
                className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                <ChevronRight size={10} className="rotate-180" /> {submenu}
              </button>
              <div className="my-1 border-t border-border" />
              {subs.find(s => s.label === submenu)?.options.map(o => (
                <button key={o.value}
                  onClick={() => {
                    if (o.value !== 'divider') {
                      subs.find(s => s.label === submenu)?.onSelect(o.value)
                      setSubmenu(null)
                    }
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded px-2 py-1.5 hover:bg-accent hover:text-foreground',
                    o.value === 'divider' && 'pointer-events-none',
                  )}
                >
                  {o.value === 'divider' ? (
                    <span className="w-full border-t border-border my-0.5" />
                  ) : (
                    <>
                      <span>{o.label}</span>
                      {subs.find(s => s.label === submenu)?.selected === o.value && <Check size={12} />}
                    </>
                  )}
                </button>
              ))}
            </>
          ) : (
            subs.map(s => (
              <button key={s.label}
                onClick={() => setSubmenu(s.label)}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 hover:bg-accent hover:text-foreground"
              >
                <span>{s.label}</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  {s.selected !== 'all' && s.selected !== 'none' ? s.selected : 'All'}
                  <ChevronRight size={10} />
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
