import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Input, Spin } from 'antd'
import type { InputRef } from 'antd'
import {
  ApartmentOutlined, ClusterOutlined, CloudServerOutlined, GlobalOutlined,
  SearchOutlined, AimOutlined, TagsOutlined, HistoryOutlined,
} from '@ant-design/icons'
import { api } from '../api'
import type { SearchResult, SearchResultType } from '../api'

interface Props {
  onAsset: (assetId: number) => void
  onRoom: (roomId: number) => void
  onRack: (roomId: number, rackId: number) => void
  onIpam: () => void
  onTag: () => void
  onSearchAll: (query: string) => void
}

const typeMeta: Record<SearchResultType, { label: string; icon: ReactNode }> = {
  asset: { label: '资产', icon: <CloudServerOutlined /> },
  room: { label: '数据中心', icon: <ApartmentOutlined /> },
  rack: { label: '机柜', icon: <ClusterOutlined /> },
  tag: { label: '标签', icon: <TagsOutlined /> },
  subnet: { label: '网段', icon: <GlobalOutlined /> },
  ip: { label: 'IP 地址', icon: <AimOutlined /> },
}

const kindLabels: Record<string, string> = { host: '物理机', vm: '虚拟机', switch: '交换机' }
const statusLabels: Record<string, string> = {
  online: '在线', offline: '离线', running: '运行中', stopped: '已停止', paused: '已暂停', unknown: '未知',
}

const typeOrder: SearchResultType[] = ['asset', 'tag', 'ip', 'room', 'rack', 'subnet']

export function GlobalSearch({ onAsset, onRoom, onRack, onIpam, onTag, onSearchAll }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('linkcmdb-recent-searches') ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 6) : []
    } catch {
      return []
    }
  })
  const inputRef = useRef<InputRef>(null)
  const requestRef = useRef(0)

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  useEffect(() => {
    const keyword = query.trim()
    if (keyword.length < 2) {
      requestRef.current++
      setResults([])
      setLoading(false)
      setError('')
      return
    }
    const requestId = ++requestRef.current
    setLoading(true)
    setError('')
    const timer = window.setTimeout(() => {
      void api<SearchResult[]>('/search?q=' + encodeURIComponent(keyword))
        .then(data => {
          if (requestId !== requestRef.current) return
          setResults(data)
          setActive(0)
          setOpen(true)
        })
        .catch(() => {
          if (requestId !== requestRef.current) return
          setResults([])
          setError('搜索失败，请稍后重试')
        })
        .finally(() => {
          if (requestId === requestRef.current) setLoading(false)
        })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query])

  function rememberSearch(term: string) {
    const value = term.trim()
    if (value.length < 2) return
    const next = [value, ...recent.filter(item => item.toLowerCase() !== value.toLowerCase())].slice(0, 6)
    setRecent(next)
    try {
      localStorage.setItem('linkcmdb-recent-searches', JSON.stringify(next))
    } catch {
      // Recent searches still work for this session.
    }
  }

  function runRecent(term: string) {
    setQuery(term)
    setOpen(true)
    inputRef.current?.focus()
  }

  function clearRecent() {
    setRecent([])
    try {
      localStorage.removeItem('linkcmdb-recent-searches')
    } catch {
      // Ignore unavailable storage.
    }
  }

  function searchAll() {
    const term = query.trim()
    if (!term) return
    rememberSearch(term)
    setOpen(false)
    setQuery('')
    setResults([])
    onSearchAll(term)
  }

  function choose(result: SearchResult) {
    rememberSearch(query)
    setOpen(false)
    setQuery('')
    setResults([])
    if (result.type === 'asset') onAsset(result.assetId ?? result.id)
    else if (result.type === 'room' && result.roomId) onRoom(result.roomId)
    else if (result.type === 'rack' && result.roomId && result.rackId) onRack(result.roomId, result.rackId)
    else if (result.type === 'tag') onTag()
    else onIpam()
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (!flat.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(index => Math.min(flat.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(index => Math.max(0, index - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = flat[active]
      if (result) choose(result)
    }
  }

  function resultDetail(result: SearchResult) {
    if (result.type === 'asset') {
      return [kindLabels[result.kind ?? ''] ?? result.kind, statusLabels[result.status ?? ''] ?? result.status, result.detail]
        .filter(Boolean).join(' · ')
    }
    return result.detail
  }

  const visible = open && (query.trim().length >= 2 || (!query.trim() && recent.length > 0))
  const grouped = typeOrder
    .map(type => ({ type, items: results.filter(result => result.type === type) }))
    .filter(group => group.items.length > 0)
  const flat = grouped.flatMap(group => group.items)

  return (
    <div className="global-search">
      <Input
        ref={inputRef}
        allowClear prefix={<SearchOutlined />}
        placeholder="搜索资产、标签、机柜、IP…"
        value={query}
        autoComplete="off"
        suffix={<kbd className="global-search-kbd">Ctrl K</kbd>}
        onChange={event => {
          const value = event.target.value
          setQuery(value)
          setOpen(value.trim().length >= 2 || value.trim().length === 0)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKeyDown}
      />
      {visible && (
        <div className="global-search-panel" onMouseDown={event => event.preventDefault()}>
          {!query.trim() ? (
            <>
              <div className="global-search-group">
                <div className="global-search-group-title">最近搜索</div>
                {recent.map(term => (
                  <button key={term} type="button" className="global-search-recent" onClick={() => runRecent(term)}>
                    <HistoryOutlined />
                    <span>{term}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="global-search-clear" onClick={clearRecent}>清空最近搜索</button>
            </>
          ) : (
            <>
              {loading && <div className="global-search-state"><Spin size="small" /> 搜索中…</div>}
              {!loading && error && <div className="global-search-state">{error}</div>}
              {!loading && !error && results.length === 0 && <div className="global-search-state">没有匹配结果</div>}
              {!loading && !error && grouped.map(group => (
                <div key={group.type} className="global-search-group">
                  <div className="global-search-group-title">{typeMeta[group.type].label}</div>
                  {group.items.map(result => {
                    const index = flat.findIndex(item => item.type === result.type && item.id === result.id)
                    return (
                      <button
                        key={`${result.type}-${result.id}`} type="button"
                        className={`global-search-result${index === active ? ' active' : ''}`}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(result)}
                      >
                        <span className="global-search-icon">{typeMeta[result.type].icon}</span>
                        <span className="global-search-copy">
                          <strong>{result.label}</strong>
                          <span>{resultDetail(result)}</span>
                        </span>
                        <span className="global-search-type">{typeMeta[result.type].label}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
              <div className="global-search-footer">
                <button type="button" onClick={searchAll}>在全部资产中搜索「{query.trim()}」</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
