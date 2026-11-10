import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert, App as AntApp, Button, Card, Checkbox, ConfigProvider, Descriptions,
  Drawer, Dropdown, Empty, Form, Input, Layout, List, Menu, Modal, Popover, Radio, Select,
  Space, Spin, Table, Tabs, Tag, Tooltip, Upload, theme,
} from 'antd'
import type { TableColumnsType } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import {
  ApartmentOutlined, ApiOutlined, CloudServerOutlined,
  DeleteOutlined, DesktopOutlined, DownloadOutlined, EditOutlined, FilterOutlined, GlobalOutlined, HistoryOutlined,
  HddOutlined, HomeOutlined, LockOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoonOutlined, PlusOutlined, ReloadOutlined,
  SearchOutlined, SettingOutlined, StarFilled, StarOutlined, SunOutlined, TagsOutlined, UploadOutlined, UserOutlined,
} from '@ant-design/icons'
import { api, apiCSV, APIError } from './api'
import type { Asset, AssetFields, Captcha, Change, ImportPreview, Kind, Link, LinkKind, Subnet, Tag as TagItem, User } from './api'
import { assetLocations, locationLabel } from './facilities'
import type { AssetLocation, Facilities } from './facilities'
import type { Page } from './types'
import { AssetEditor } from './components/AssetEditor'
import { AssetRelationGraph } from './components/AssetRelationGraph'
import { ChangeList } from './components/ChangeList'
import { ChangePassword } from './components/ChangePassword'
import { Dashboard } from './components/Dashboard'
import { FacilityView } from './components/FacilityView'
import { GlobalSearch } from './components/GlobalSearch'
import { IpamView } from './components/IpamView'
import { TagManager } from './components/TagManager'
import { Wordmark } from './components/Wordmark'

const { Header, Sider, Content } = Layout

type NavLeaf = { key: string; label: ReactNode; icon: ReactNode }
type NavGroup = { key: string; label: ReactNode; icon: ReactNode; children: NavLeaf[] }

const kinds: Record<Kind, { label: string; icon: ReactNode }> = {
  host: { label: '物理机', icon: <CloudServerOutlined /> },
  vm: { label: '虚拟机', icon: <DesktopOutlined /> },
  switch: { label: '交换机', icon: <ApiOutlined /> },
}
const statuses: Record<string, { label: string; color: string }> = {
  online: { label: '在线', color: 'green' },
  running: { label: '运行中', color: 'green' },
  stopped: { label: '已停止', color: 'default' },
  paused: { label: '已暂停', color: 'orange' },
  offline: { label: '离线', color: 'red' },
  unknown: { label: '未知', color: 'default' },
}
const relations: { kind: LinkKind; from: Kind; to: Kind[]; outgoing: string; incoming: string }[] = [
  { kind: 'hosts', from: 'host', to: ['vm'], outgoing: '承载虚拟机', incoming: '所在宿主机' },
]
const defaultPageSize = 10
const defaultAssetColumns = ['name', 'kind', 'status', 'tags', 'meta', 'address', 'owner', 'actions']
const assetColumnKeys = ['name', 'kind', 'status', 'tags', 'meta', 'address', 'owner', 'environment', 'capacity', 'updated', 'actions']

interface AssetFilterPreset {
  id: string
  name: string
  keyword: string
  platform?: string
  lifecycle: string
  status?: string
  tagIds?: number[]
  tagMatch?: 'all' | 'any'
  tagId?: number
}

function platformLabel(asset: Pick<Asset, 'platform'>) {
  return asset.platform === 'pve' ? 'Proxmox VE' : asset.platform === 'kvm' ? 'KVM' : '—'
}
function statusOf(asset: Asset) {
  if (asset.lifecycle === 'retired') return { label: '已退役', color: 'default' }
  return statuses[asset.status] ?? statuses.unknown
}
function messageText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败'
}

function initialDark() {
  try {
    const saved = localStorage.getItem('easy-cmdb-theme')
    if (saved === 'dark') return true
    if (saved === 'light') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function ThemeToggle({ dark, onToggleTheme, className }: { dark: boolean; onToggleTheme: () => void; className?: string }) {
  return (
    <Tooltip title={dark ? '切换到浅色模式' : '切换到暗色模式'}>
      <Button
        type="text" className={className} onClick={onToggleTheme}
        aria-label={dark ? '切换到浅色模式' : '切换到暗色模式'}
      >
        {dark ? <SunOutlined /> : <MoonOutlined />}
      </Button>
    </Tooltip>
  )
}

export default function App() {
  const [dark, setDark] = useState(initialDark)

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try {
      localStorage.setItem('easy-cmdb-theme', dark ? 'dark' : 'light')
    } catch {
      // Storage may be unavailable in private browsing.
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141414' : '#f5f5f5')
  }, [dark])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 6,
          colorBgContainer: dark ? '#1f1f1f' : '#ffffff',
          colorBgLayout: dark ? '#141414' : '#f5f5f5',
          colorBgElevated: dark ? '#262626' : '#ffffff',
        },
      }}
    >
      <AntApp>
        <Shell dark={dark} onToggleTheme={() => setDark(value => !value)} />
      </AntApp>
    </ConfigProvider>
  )
}

function Shell({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { message } = AntApp.useApp()
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [captcha, setCaptcha] = useState<Captcha | null>(null)
  const [captchaCode, setCaptchaCode] = useState('')
  const [captchaLoading, setCaptchaLoading] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState<Page>('home')
  const [facilityRoomId, setFacilityRoomId] = useState<number | null>(null)
  const [facilityRackId, setFacilityRackId] = useState<number | null>(null)
  const [ipamSubnetId, setIpamSubnetId] = useState<number | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  const [assets, setAssets] = useState<Asset[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [changes, setChanges] = useState<Change[]>([])
  const [facilities, setFacilities] = useState<Facilities>({ rooms: [], racks: [], placements: [] })
  const [subnets, setSubnets] = useState<Subnet[]>([])

  const [keyword, setKeyword] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string | undefined>()
  const [lifecycleFilter, setLifecycleFilter] = useState('active')
  const [statusFilter, setStatusFilter] = useState<string | undefined>()
  const [tagFilter, setTagFilter] = useState<number[]>([])
  const [tagFilterMode, setTagFilterMode] = useState<'all' | 'any'>('all')
  const [filterPresets, setFilterPresets] = useState<AssetFilterPreset[]>([])
  const [filterName, setFilterName] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<string[]>(defaultAssetColumns)
  const [pagination, setPagination] = useState(1)
  const [pageSize, setPageSize] = useState(() => {
    const stored = Number(localStorage.getItem('easy-cmdb-page-size'))
    return [10, 20, 50].includes(stored) ? stored : defaultPageSize
  })
  const [importing, setImporting] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [pendingImport, setPendingImport] = useState<File | null>(null)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editor, setEditor] = useState(false)
  const [newKind, setNewKind] = useState<Kind>('host')
  const [saving, setSaving] = useState(false)
  const [drawerError, setDrawerError] = useState('')
  const [assetTab, setAssetTab] = useState('overview')
  const [assetChanges, setAssetChanges] = useState<Change[]>([])
  const [assetTags, setAssetTags] = useState<TagItem[]>([])
  const [allTags, setAllTags] = useState<TagItem[]>([])
  const [bookmarks, setBookmarks] = useState<number[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('easy-cmdb-bookmarks') ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : []
    } catch {
      return []
    }
  })
  const [rackBookmarks, setRackBookmarks] = useState<number[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('easy-cmdb-rack-bookmarks') ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : []
    } catch {
      return []
    }
  })
  const [subnetBookmarks, setSubnetBookmarks] = useState<number[]>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('easy-cmdb-subnet-bookmarks') ?? '[]')
      return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : []
    } catch {
      return []
    }
  })
  const [tagOpen, setTagOpen] = useState(false)
  const [tagSaving, setTagSaving] = useState(false)
  const [tagError, setTagError] = useState('')
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([])
  const [showRelationForm, setShowRelationForm] = useState(false)
  const [relationChoice, setRelationChoice] = useState('')
  const [relationTarget, setRelationTarget] = useState(0)
  const [facilityFocus, setFacilityFocus] = useState<AssetLocation | null>(null)
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkError, setBulkError] = useState('')
  const [bulkForm] = Form.useForm()
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkTagMode, setBulkTagMode] = useState<'add' | 'remove' | 'replace'>('add')
  const [bulkTagIds, setBulkTagIds] = useState<number[]>([])
  const [bulkTagSaving, setBulkTagSaving] = useState(false)
  const [bulkTagError, setBulkTagError] = useState('')

  const navigation: (NavLeaf | NavGroup)[] = [
    { key: 'home', label: '首页', icon: <HomeOutlined /> },
    { key: 'assets', label: '全部资产', icon: <HddOutlined /> },
    { key: 'host', label: '物理机', icon: <CloudServerOutlined /> },
    { key: 'vm', label: '虚拟机', icon: <DesktopOutlined /> },
    { key: 'switch', label: '交换机', icon: <ApiOutlined /> },
    { key: 'facilities', label: '数据中心', icon: <ApartmentOutlined /> },
    { key: 'ipam', label: 'IPAM', icon: <GlobalOutlined /> },
    {
      key: 'system', label: '系统管理', icon: <SettingOutlined />,
      children: [
        { key: 'changes', label: '变更记录', icon: <HistoryOutlined /> },
        { key: 'tags', label: '标签管理', icon: <TagsOutlined /> },
        { key: 'password', label: '更改密码', icon: <LockOutlined /> },
      ],
    },
  ]
  const navLeaves = navigation.flatMap(item => 'children' in item ? item.children : [item])
  const activePage = navLeaves.find(item => item.key === page)!
  const selectedRoom = facilities.rooms.find(room => room.id === facilityRoomId)
  const pageTitle = page === 'facilities' ? (selectedRoom?.name ?? '数据中心') : activePage.label
  const editable = user?.role !== 'viewer'
  const assetPage = page === 'assets' || page === 'host' || page === 'vm' || page === 'switch'

  const byId = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets])
  const locations = useMemo(() => assetLocations(facilities, links), [facilities, links])
  const selected = assets.find(asset => asset.id === selectedId) ?? null
  const selectedLocation = selected ? locations.get(selected.id) : undefined
  const related = links.filter(link => link.fromId === selectedId || link.toId === selectedId)
  const vmRelations = useMemo(() => {
    const data = new Map<number, string[]>()
    for (const link of links) {
      if (link.kind !== 'hosts') continue
      const names = data.get(link.toId) ?? []
      names.push(link.fromName)
      data.set(link.toId, names)
    }
    return data
  }, [links])

  const scoped = useMemo(() => {
    if (page === 'assets') return assets
    if (page === 'home' || page === 'changes' || page === 'password' || page === 'facilities' || page === 'ipam') return []
    return assets.filter(asset => asset.kind === page)
  }, [assets, page])
  const filtered = useMemo(() => {

    const query = keyword.trim().toLowerCase()
    return scoped.filter(asset => {
      if (lifecycleFilter && asset.lifecycle !== lifecycleFilter) return false
      if (platformFilter && asset.platform !== platformFilter) return false
      if (statusFilter && asset.status !== statusFilter) return false
      if (tagFilter.length) {
        const match = tagFilterMode === 'any'
          ? tagFilter.some(id => asset.tags?.some(tag => tag.id === id))
          : tagFilter.every(id => asset.tags?.some(tag => tag.id === id))
        if (!match) return false
      }

      return !query || [asset.name, asset.address, asset.owner, asset.environment, ...(asset.tags?.map(tag => tag.name) ?? []), ...(vmRelations.get(asset.id) ?? [])]
        .some(value => value?.toLowerCase().includes(query))
    })
  }, [scoped, lifecycleFilter, platformFilter, statusFilter, tagFilter, tagFilterMode, keyword, vmRelations])

  const relationOptions = useMemo(() => {
    if (!selected) return []
    return relations.flatMap(relation => {
      const items: { id: string; label: string; direction: 'out' | 'in'; relation: typeof relation }[] = []
      if (relation.from === selected.kind) items.push({ id: relation.kind + '-out', label: relation.outgoing, direction: 'out', relation })
      if (relation.to.includes(selected.kind)) items.push({ id: relation.kind + '-in', label: relation.incoming, direction: 'in', relation })
      return items
    })
  }, [selected])
  const chosenRelation = relationOptions.find(option => option.id === relationChoice)
  const targets = useMemo(() => {
    if (!chosenRelation) return []
    const active = assets.filter(asset => asset.lifecycle === 'active')
    return active.filter(asset => {
      if (asset.id === selectedId) return false
      if (chosenRelation.direction === 'in') return asset.kind === chosenRelation.relation.from
      return chosenRelation.relation.to.includes(asset.kind)
    })
  }, [assets, chosenRelation, selectedId])

  useEffect(() => {
    void (async () => {
      try {
        setUser(await api<User>('/me'))
        await loadAll()
      } catch (e) {
        if (!(e instanceof APIError && e.status === 401)) setError(messageText(e))
      } finally {
        setChecking(false)
      }
    })()
  }, [])

  useEffect(() => {
    setPagination(1)
  }, [keyword, platformFilter, lifecycleFilter, page])

  useEffect(() => {
    try {
      localStorage.setItem('easy-cmdb-bookmarks', JSON.stringify(bookmarks))
    } catch {
      // Bookmarks still work for this session when storage is unavailable.
    }
  }, [bookmarks])

  useEffect(() => {
    try {
      localStorage.setItem('easy-cmdb-rack-bookmarks', JSON.stringify(rackBookmarks))
      localStorage.setItem('easy-cmdb-subnet-bookmarks', JSON.stringify(subnetBookmarks))
    } catch {
      // Favorites still work for this session when storage is unavailable.
    }
  }, [rackBookmarks, subnetBookmarks])

  useEffect(() => {
    try {
      localStorage.setItem('easy-cmdb-page-size', String(pageSize))
    } catch {
      // Page size still applies for this session when storage is unavailable.
    }
  }, [pageSize])

  useEffect(() => {
    setSelectedAssetIds([])
  }, [page, keyword, platformFilter, lifecycleFilter, statusFilter, tagFilter, tagFilterMode, pageSize, pagination])

  useEffect(() => {
    if (!assetPage) return
    setFilterOpen(false)
    setFilterName('')
    try {
      const raw = localStorage.getItem('easy-cmdb-filters:' + page)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) {
        setFilterPresets(parsed.filter((item): item is AssetFilterPreset => (
          !!item && typeof item === 'object' && typeof (item as AssetFilterPreset).name === 'string'
        )))
      }
    } catch {
      setFilterPresets([])
    }
    try {
      const raw = localStorage.getItem('easy-cmdb-columns:' + page)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      const valid = Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === 'string' && assetColumnKeys.includes(key))
        : []
      setVisibleColumns(valid.length ? assetColumnKeys.filter(key => valid.includes(key)) : defaultAssetColumns)
    } catch {
      setVisibleColumns(defaultAssetColumns)
    }
  }, [assetPage, page])

  useEffect(() => {
    if (!chosenRelation && relationOptions.length) setRelationChoice(relationOptions[0].id)
  }, [relationOptions, chosenRelation])

  async function loadAll() {
    setBusy(true)
    setError('')
    try {
      const [nextAssets, nextLinks, nextChanges, nextFacilities, nextSubnets, nextTags] = await Promise.all([
        api<Asset[]>('/assets'), api<Link[]>('/links'), api<Change[]>('/changes'),
        api<Facilities>('/facilities'), api<Subnet[]>('/subnets'), api<TagItem[]>('/tags'),
      ])
      setAssets(nextAssets)
      setLinks(nextLinks)
      setChanges(nextChanges)
      setFacilities(nextFacilities)
      setSubnets(nextSubnets)
      setAllTags(nextTags)
    } catch (e) {
      handleError(e)
    } finally {
      setBusy(false)
    }
  }

  function handleError(e: unknown, inDrawer = false) {
    if (e instanceof APIError && e.status === 401 && user) {
      closeDrawer()
      setUser(null)
    }
    if (inDrawer && user) setDrawerError(messageText(e))
    else setError(messageText(e))
  }

  useEffect(() => {
    if (!checking && !user) void loadCaptcha()
  }, [checking, user, dark])

  async function loadCaptcha() {
    setCaptchaLoading(true)
    try {
      setCaptcha(await api<Captcha>(`/captcha?theme=${dark ? 'dark' : 'light'}`))
      setCaptchaCode('')
    } catch (e) {
      setError('验证码加载失败，请刷新重试')
      if (e instanceof APIError && e.status === 401) setUser(null)
    } finally {
      setCaptchaLoading(false)
    }
  }

  async function login() {
    if (!captcha) {
      setError('验证码尚未加载，请刷新验证码')
      return
    }
    setLoginBusy(true)
    setError('')
    try {
      setUser(await api<User>('/login', 'POST', {
        ...loginForm,
        captchaId: captcha.id,
        captchaCode,
      }))
      setLoginForm({ username: loginForm.username, password: '' })
      setCaptcha(null)
      setCaptchaCode('')
      await loadAll()
    } catch (e) {
      setError(messageText(e))
      setCaptchaCode('')
      await loadCaptcha()
    } finally {
      setLoginBusy(false)
    }
  }

  async function logout() {
    try {
      await api('/logout', 'POST')
      closeDrawer()
      setUser(null)
      setAssets([])
      setLinks([])
      setChanges([])
      setFacilities({ rooms: [], racks: [], placements: [] })
      setSubnets([])
      goTo('home')
    } catch (e) {
      handleError(e)
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    await api('/me/password', 'POST', { currentPassword, newPassword })
    void message.success('密码已修改，请使用新密码重新登录')
    closeDrawer()
    setUser(null)
    setAssets([])
    setLinks([])
    setChanges([])
    setFacilities({ rooms: [], racks: [], placements: [] })
    setSubnets([])
    setPage('home')
  }

  function goTo(next: Page) {
    setPage(next)
    if (next !== 'facilities') setFacilityRackId(null)
    if (window.innerWidth < 992) setCollapsed(true)
    setKeyword('')
    setPlatformFilter(undefined)
    setLifecycleFilter('active')
    setStatusFilter(undefined)
    setTagFilter([])
    setTagFilterMode('all')
    setPagination(1)
    setFacilityFocus(null)
  }

  function closeDrawer() {
    if (saving) return
    setDrawerOpen(false)
    setSelectedId(null)
    setEditor(false)
    setDrawerError('')
    setShowRelationForm(false)
  }

  async function openAsset(id: number) {
    setSelectedId(id)
    setAssetChanges([])
    setAssetTags([])
    setAssetTab('overview')
    setEditor(false)
    setDrawerError('')
    setShowRelationForm(false)
    setDrawerOpen(true)
    try {
      const [changes, tags] = await Promise.all([
        api<Change[]>('/changes?assetId=' + id),
        api<TagItem[]>('/assets/' + id + '/tags'),
      ])
      setAssetChanges(changes)
      setAssetTags(tags)
    } catch (e) {
      handleError(e, true)
    }
  }

  function startNew() {
    setSelectedId(null)
    setAssetTags([])
    setNewKind(page === 'vm' ? 'vm' : page === 'switch' ? 'switch' : 'host')
    setEditor(true)
    setDrawerError('')
    setDrawerOpen(true)
  }

  async function saveAsset(fields: AssetFields & { version: number }) {
    setSaving(true)
    setDrawerError('')
    try {
      const id = selectedId
      const saved = await api<Asset>(id ? '/assets/' + id : '/assets', id ? 'PUT' : 'POST', fields)
      await loadAll()
      await openAsset(saved.id)
      void message.success(id ? '资产已更新' : '资产已添加')
    } catch (e) {
      handleError(e, true)
    } finally {
      setSaving(false)
    }
  }

  function openBulkEdit() {
    setBulkError('')
    bulkForm.resetFields()
    setBulkOpen(true)
  }

  function toggleBookmark(id: number) {
    setBookmarks(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id])
  }

  function toggleRackBookmark(id: number) {
    setRackBookmarks(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id])
  }

  function toggleSubnetBookmark(id: number) {
    setSubnetBookmarks(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id])
  }

  function openRack(roomId: number, rackId: number) {
    setFacilityRoomId(roomId)
    setFacilityRackId(rackId)
    goTo('facilities')
  }

  function openSubnet(id: number) {
    setIpamSubnetId(id)
    goTo('ipam')
  }

  function showTagAssets(tagId: number) {
    goTo('assets')
    setTagFilter([tagId])
    setTagFilterMode('all')
  }

  function searchAllAssets(term: string) {
    goTo('assets')
    setKeyword(term)
  }

  function openBulkTags() {
    setBulkTagError('')
    setBulkTagMode('add')
    setBulkTagIds([])
    setBulkTagOpen(true)
  }

  async function saveBulkTags() {
    if (bulkTagMode !== 'replace' && bulkTagIds.length === 0) {
      setBulkTagError('请选择要处理的标签')
      return
    }
    setBulkTagSaving(true)
    setBulkTagError('')
    try {
      const result = await api<{ updated: number }>('/assets/bulk/tags', 'POST', {
        ids: selectedAssetIds, tagIds: bulkTagIds, mode: bulkTagMode,
      })
      await loadAll()
      setSelectedAssetIds([])
      setBulkTagOpen(false)
      void message.success(`已更新 ${result.updated} 条资产的标签`)
    } catch (e) {
      setBulkTagError(messageText(e))
    } finally {
      setBulkTagSaving(false)
    }
  }

  async function saveBulkEdit(values: { status?: string; lifecycle?: string; owner?: string; environment?: string }) {
    setBulkSaving(true)
    setBulkError('')
    try {
      const fields: Record<string, string> = {}
      for (const key of ['status', 'lifecycle', 'owner', 'environment'] as const) {
        const value = values[key]?.trim()
        if (value) fields[key] = value
      }
      if (!Object.keys(fields).length) {
        setBulkError('请至少选择一项要修改的字段')
        return
      }
      const result = await api<{ updated: number }>('/assets/bulk', 'POST', {
        ids: selectedAssetIds, ...fields,
      })
      await loadAll()
      setSelectedAssetIds([])
      setBulkOpen(false)
      void message.success(`已更新 ${result.updated} 条资产`)
    } catch (e) {
      setBulkError(messageText(e))
    } finally {
      setBulkSaving(false)
    }
  }

  async function openTagEditor() {
    if (!selectedId || !selected) return
    setTagError('')
    try {
      setAllTags(await api<TagItem[]>('/tags'))
      setSelectedTagIds(assetTags.map(tag => tag.id))
      setTagOpen(true)
    } catch (e) {
      handleError(e, true)
    }
  }

  async function saveAssetTags() {
    if (!selectedId) return
    setTagSaving(true)
    setTagError('')
    try {
      const tags = await api<TagItem[]>('/assets/' + selectedId + '/tags', 'PUT', { tagIds: selectedTagIds })
      setAssetTags(tags)
      setTagOpen(false)
      await loadAll()
      void message.success('标签已更新')
    } catch (e) {
      setTagError(messageText(e))
    } finally {
      setTagSaving(false)
    }
  }

  function persistFilterPresets(next: AssetFilterPreset[]) {    setFilterPresets(next)
    try {
      localStorage.setItem('easy-cmdb-filters:' + page, JSON.stringify(next))
    } catch {
      // Storage can be unavailable in private browsing; the in-memory list still works.
    }
  }

  function saveFilterPreset() {
    const name = filterName.trim()
    if (!name) {
      void message.warning('请输入条件名称')
      return
    }
    const preset: AssetFilterPreset = {
      id: Date.now().toString(36),
      name,
      keyword: keyword.trim(),
      platform: platformFilter,
      lifecycle: lifecycleFilter,
      status: statusFilter,
      tagIds: tagFilter,
      tagMatch: tagFilterMode,
    }
    persistFilterPresets([...filterPresets.filter(item => item.name !== name), preset])
    setFilterName('')
    setFilterOpen(false)
  }

  function applyFilterPreset(preset: AssetFilterPreset) {
    setKeyword(preset.keyword)
    setPlatformFilter(preset.platform)
    setLifecycleFilter(preset.lifecycle)
    setStatusFilter(preset.status)
    setTagFilter(preset.tagIds ?? (preset.tagId ? [preset.tagId] : []))
    setTagFilterMode(preset.tagMatch ?? 'all')
    setPagination(1)
    setFilterOpen(false)
  }

  function removeFilterPreset(id: string) {
    persistFilterPresets(filterPresets.filter(item => item.id !== id))
  }

  function updateVisibleColumns(keys: string[]) {
    if (!keys.length) return
    const ordered = assetColumnKeys.filter(key => keys.includes(key))
    setVisibleColumns(ordered)
    try {
      localStorage.setItem('easy-cmdb-columns:' + page, JSON.stringify(ordered))
    } catch {
      // Keep the current in-memory column selection.
    }
  }

  function startRelation() {
    setShowRelationForm(true)
    setRelationChoice(relationOptions[0]?.id ?? '')
    setRelationTarget(0)
    setDrawerError('')
  }

  async function updateLink(removeId?: number) {
    const id = selectedId
    if (!id) return
    if (!removeId && (!chosenRelation || !relationTarget)) return
    setSaving(true)
    setDrawerError('')
    try {
      if (removeId) {
        await api('/links/' + removeId, 'DELETE')
      } else if (chosenRelation) {
        const [fromId, toId] = chosenRelation.direction === 'out' ? [id, relationTarget] : [relationTarget, id]
        await api('/links', 'POST', { kind: chosenRelation.relation.kind, fromId, toId })
      }
      await loadAll()
      await openAsset(id)
      void message.success(removeId ? '关系已解除' : '关系已添加')
    } catch (e) {
      handleError(e, true)
    } finally {
      setSaving(false)
    }
  }

  function showAssetLocation(location: AssetLocation) {
    closeDrawer()
    goTo('facilities')
    setFacilityFocus(location)
  }

  function csvCell(input: string | number) {
    const text = String(input)
    const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text
    return '"' + safe.replaceAll('"', '""') + '"'
  }

  function downloadCSV(filename: string, rows: (string | number)[][]) {
    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function downloadImportErrors() {
    if (!importPreview?.errors.length) return
    downloadCSV('easy-cmdb-import-errors.csv', [
      ['行号', '错误说明'],
      ...importPreview.errors.map(error => [error.row, error.message]),
    ])
  }

  function exportCSV() {
    const rows: (string | number)[][] = [[
      '资源名称', '类型', '平台', '状态', '生命周期', '地址 / IP', 'CPU', '内存 MiB', '负责人', '环境', '备注', '扩展属性', '标签',
    ]]
    for (const asset of filtered) {
      rows.push([
        asset.name, kinds[asset.kind].label, platformLabel(asset), statusOf(asset).label,
        asset.lifecycle === 'retired' ? '已退役' : '在册', asset.address, asset.cpu, asset.memoryMiB,
        asset.owner, asset.environment, asset.notes, JSON.stringify(asset.attributes),
        asset.tags?.map(tag => tag.name).join('; ') ?? '',
      ])
    }
    downloadCSV('easy-cmdb-assets.csv', rows)
  }

  function downloadTemplate() {
    downloadCSV('easy-cmdb-import-template.csv', [[
      '资源名称', '类型', '平台', '状态', '生命周期', '地址 / IP', 'CPU', '内存 MiB', '负责人', '环境', '备注', '扩展属性', '标签',
    ]])
  }

  async function previewCSV(file: File) {
    if (file.size > 16 * 1024 * 1024) {
      setError('CSV 文件不能超过 16 MiB')
      return
    }
    setPreviewing(true)
    setError('')
    try {
      const preview = await apiCSV<ImportPreview>('/assets/import/preview', file)
      setImportPreview(preview)
      setPendingImport(file)
    } catch (e) {
      handleError(e)
    } finally {
      setPreviewing(false)
    }
  }

  async function importCSV(file: File) {
    if (file.size > 16 * 1024 * 1024) {
      setError('CSV 文件不能超过 16 MiB')
      return
    }
    setImporting(true)
    setError('')
    try {
      const result = await apiCSV<{ imported: number }>('/assets/import', file)
      await loadAll()
      setImportPreview(null)
      setPendingImport(null)
      void message.success(`已导入 ${result.imported} 条资产`)
    } catch (e) {
      handleError(e)
    } finally {
      setImporting(false)
    }
  }

  function hostName(asset: Asset) {
    return links.find(link => link.kind === 'hosts' && link.toId === asset.id)?.fromName ?? '—'
  }

  function relationLabel(link: Link) {
    const type = relations.find(item => item.kind === link.kind)
    return (link.fromId === selectedId ? type?.outgoing : type?.incoming) ?? link.kind
  }

  function relatedId(link: Link) {
    return link.fromId === selectedId ? link.toId : link.fromId
  }

  const metaTitle = page === 'vm' ? '宿主机' : page === 'assets' ? '宿主机 / 平台' : '平台'
  const metaValue = (asset: Asset) => page === 'vm' || (page === 'assets' && asset.kind === 'vm')
    ? hostName(asset) : platformLabel(asset)
  const assetColumns: { key: string; label: string; column: TableColumnsType<Asset>[number] }[] = [
    {
      key: 'name', label: '资源名称',
      column: {
        title: '资源名称', key: 'name', width: 260,
        sorter: (left, right) => left.name.localeCompare(right.name, 'zh-CN'),
        render: (_, asset) => (
          <Button type="link" className="asset-link" onClick={() => void openAsset(asset.id)}>
            {kinds[asset.kind].icon}
            <span>{asset.name}</span>
            {asset.environment && <span className="asset-sub">{asset.environment}</span>}
          </Button>
        ),
      },
    },
    {
      key: 'kind', label: '类型',
      column: { title: '类型', key: 'kind', width: 90, sorter: (left, right) => kinds[left.kind].label.localeCompare(kinds[right.kind].label, 'zh-CN'), render: (_, asset) => kinds[asset.kind].label },
    },
    {
      key: 'status', label: '状态',
      column: { title: '状态', key: 'status', width: 100, sorter: (left, right) => statusOf(left).label.localeCompare(statusOf(right).label, 'zh-CN'), render: (_, asset) => <Tag color={statusOf(asset).color}>{statusOf(asset).label}</Tag> },
    },
    {
      key: 'tags', label: '标签',
      column: {
        title: '标签', key: 'tags', width: 180,
        sorter: (left, right) => (left.tags?.map(tag => tag.name).join(' ') ?? '').localeCompare(right.tags?.map(tag => tag.name).join(' ') ?? '', 'zh-CN'),
        render: (_, asset) => asset.tags?.length
          ? (
              <Space size={2} wrap>
                {asset.tags.slice(0, 3).map(tag => <Tag key={tag.id} color={tag.color}>{tag.name}</Tag>)}
                {asset.tags.length > 3 && (
                  <Tooltip title={asset.tags.slice(3).map(tag => tag.name).join('、')}>
                    <Tag>+{asset.tags.length - 3}</Tag>
                  </Tooltip>
                )}
              </Space>
            )
          : '—',
      },
    },
    {
      key: 'meta', label: metaTitle,
      column: { title: metaTitle, key: 'meta', width: 130, sorter: (left, right) => metaValue(left).localeCompare(metaValue(right), 'zh-CN'), render: (_, asset) => metaValue(asset) },
    },
    {
      key: 'address', label: '地址 / IP',
      column: { title: '地址 / IP', dataIndex: 'address', key: 'address', width: 170, sorter: (left, right) => left.address.localeCompare(right.address, 'zh-CN', { numeric: true }), render: value => <span className="mono">{value || '—'}</span> },
    },
    {
      key: 'owner', label: '负责人',
      column: { title: '负责人', dataIndex: 'owner', key: 'owner', width: 120, sorter: (left, right) => left.owner.localeCompare(right.owner, 'zh-CN'), render: value => value || '—' },
    },
    {
      key: 'environment', label: '环境',
      column: { title: '环境', dataIndex: 'environment', key: 'environment', width: 100, sorter: (left, right) => left.environment.localeCompare(right.environment, 'zh-CN'), render: value => value || '—' },
    },
    {
      key: 'capacity', label: 'CPU / 内存',
      column: {
        title: 'CPU / 内存', key: 'capacity', width: 140,
        sorter: (left, right) => left.cpu - right.cpu || left.memoryMiB - right.memoryMiB,
        render: (_, asset) => asset.kind === 'switch' ? '—' : `${asset.cpu || 0} 核 / ${asset.memoryMiB ? (asset.memoryMiB / 1024).toFixed(0) + ' GiB' : '—'}`,
      },
    },
    {
      key: 'updated', label: '更新时间',
      column: {
        title: '更新时间', dataIndex: 'updatedAt', key: 'updated', width: 165,
        sorter: (left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
        render: value => value ? new Date(String(value)).toLocaleString('zh-CN', { hour12: false }) : '—',
      },
    },
    {
      key: 'actions', label: '操作',
      column: {
        title: '', key: 'actions', width: 112,
        render: (_, asset) => (
          <Space size={0}>
            <Tooltip title={bookmarks.includes(asset.id) ? '取消收藏' : '收藏'}>
              <Button
                type="text" size="small"
                aria-label={bookmarks.includes(asset.id) ? '取消收藏' : '收藏'}
                icon={bookmarks.includes(asset.id) ? <StarFilled /> : <StarOutlined />}
                onClick={() => toggleBookmark(asset.id)}
              />
            </Tooltip>
            <Button type="link" size="small" onClick={() => void openAsset(asset.id)}>查看</Button>
          </Space>
        ),
      },
    },
  ]
  const columns = assetColumns.filter(item => visibleColumns.includes(item.key)).map(item => item.column)

  const descriptions = selected ? [
    { key: 'platform', label: '平台', children: platformLabel(selected) },
    { key: 'owner', label: '负责人', children: selected.owner || '—' },
    { key: 'environment', label: '环境', children: selected.environment || '—' },
    { key: 'address', label: '管理地址 / IP', children: <span className="mono">{selected.address || '—'}</span> },
    ...(selected.kind === 'host' || selected.kind === 'vm' ? [{
      key: 'capacity', label: 'CPU / 内存',
      children: `${selected.cpu || '—'} 核 · ${selected.memoryMiB ? selected.memoryMiB / 1024 + ' GiB' : '—'}`,
    }] : []),
    ...(selectedLocation ? [{
      key: 'location', label: '数据中心位置',
      children: (
        <div>
          <Button type="link" className="inline-link" onClick={() => showAssetLocation(selectedLocation)}>{locationLabel(selectedLocation)}</Button>
          {selectedLocation.placement.assetId !== selected.id && (
            <div className="muted">随 {byId.get(selectedLocation.placement.assetId)?.name} 定位</div>
          )}
        </div>
      ),
    }] : []),
    {
      key: 'updated', label: '最近更新',
      children: new Date(selected.updatedAt).toLocaleString('zh-CN', { hour12: false }),
    },
  ] : []

  if (checking) return <div className="app-loading"><Spin size="large" /></div>

  if (!user) {
    return (
      <main className="login-page">
        <section className="login-visual" aria-label="Easy CMDB 简介">
          <div className="login-visual-content">
            <p className="login-visual-title">让资产与关系清晰可见</p>
            <p className="login-visual-description">集中管理基础设施资产、网络与配置。</p>
          </div>
        </section>
        <section className="login-panel" aria-label="登录">
          <ThemeToggle dark={dark} onToggleTheme={onToggleTheme} className="login-theme-toggle" />
          <Card className="login-card" variant="borderless">
            <div className="login-brand"><Wordmark /></div>
            {error && <Alert type="error" showIcon message={error} className="login-alert" />}
            <Form layout="vertical" onFinish={login}>
              <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入账号' }]}>
                <Input
                  size="large" autoComplete="username" value={loginForm.username}
                  onChange={event => setLoginForm(current => ({ ...current, username: event.target.value }))}
                />
              </Form.Item>
              <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
                <Input.Password
                  size="large" autoComplete="current-password" value={loginForm.password}
                  onChange={event => setLoginForm(current => ({ ...current, password: event.target.value }))}
                />
              </Form.Item>
              <Form.Item label="验证码" required>
                <div className="captcha-row">
                  <Input
                    size="large" value={captchaCode} maxLength={8} autoComplete="off" placeholder="请输入右侧字符"
                    onChange={event => setCaptchaCode(event.target.value)}
                  />
                  <button
                    type="button" className="captcha-image-button" title="点击刷新验证码"
                    aria-label="刷新验证码" onClick={() => void loadCaptcha()} disabled={captchaLoading}
                  >
                    {captcha ? <img src={captcha.image} alt="验证码" /> : <span className="captcha-placeholder">加载中</span>}
                  </button>
                  <Button
                    type="text" icon={<ReloadOutlined />} aria-label="刷新验证码"
                    loading={captchaLoading} onClick={() => void loadCaptcha()}
                  />
                </div>
              </Form.Item>
              <Button
                type="primary" htmlType="submit" block size="large"
                loading={loginBusy} disabled={captchaLoading || !captcha || !captchaCode.trim()}
              >登录</Button>
            </Form>
          </Card>
        </section>
      </main>
    )
  }

  return (
    <Layout className="app-layout">
      <Sider
        className="app-sider" width={200} collapsedWidth={0} collapsed={collapsed}
        breakpoint="lg" trigger={null} onCollapse={setCollapsed}
      >
        <div className="brand">
          <span className="brand-word" onClick={() => goTo('home')}><Wordmark /></span>
          <Button
            className="brand-collapse" type="text" icon={<MenuFoldOutlined />}
            aria-label="收起菜单" onClick={() => setCollapsed(true)}
          />
        </div>
        <Menu
          className="app-menu" mode="inline" selectedKeys={[page]}
          defaultOpenKeys={['system']}
          items={navigation.map(item => 'children' in item
            ? {
                key: item.key, icon: item.icon, label: item.label,
                children: item.children.map(child => ({ key: child.key, icon: child.icon, label: child.label })),
              }
            : { key: item.key, icon: item.icon, label: item.label })}
          onClick={({ key }) => { if (key !== 'system') goTo(key as Page) }}
        />
      </Sider>

      <Layout>
        <Header className="app-header">
          <div className="app-header-title">
            {collapsed && (
              <Button type="text" onClick={() => setCollapsed(false)} aria-label="展开菜单"><MenuUnfoldOutlined /></Button>
            )}
            <h1>{pageTitle}</h1>
            <GlobalSearch
              onAsset={id => void openAsset(id)}
              onRoom={id => {
                setFacilityRoomId(id)
                setFacilityRackId(null)
                goTo('facilities')
              }}
              onRack={(roomId, rackId) => {
                setFacilityRoomId(roomId)
                setFacilityRackId(rackId)
                goTo('facilities')
              }}
              onIpam={() => goTo('ipam')}
              onTag={() => goTo('tags')}
              onSearchAll={searchAllAssets}
            />
          </div>
          <Space size={6}>
            {(page === 'assets' || page === 'host' || page === 'vm' || page === 'switch') && editable && (
              <Button type="primary" size="small" onClick={startNew}><PlusOutlined /> 新增资产</Button>
            )}
            <ThemeToggle dark={dark} onToggleTheme={onToggleTheme} />
            <Tooltip title="刷新">
              <Button type="text" loading={busy} onClick={() => void loadAll()}><ReloadOutlined /></Button>
            </Tooltip>
            <Dropdown
              menu={{
                items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录' }],
                onClick: ({ key }) => { if (key === 'logout') void logout() },
              }}
            >
              <Button type="text"><UserOutlined /> {user.username}</Button>
            </Dropdown>
          </Space>
        </Header>

        <Content className="app-content">
          {error && <Alert type="error" showIcon closable message={error} className="page-alert" onClose={() => setError('')} />}

          {page === 'home' && (
            <Dashboard
              assets={assets} subnets={subnets} facilities={facilities} changes={changes}
              bookmarks={bookmarks} rackBookmarks={rackBookmarks} subnetBookmarks={subnetBookmarks} tags={allTags}
              onGo={goTo} onOpenAsset={id => void openAsset(id)}
              onOpenRack={openRack} onOpenSubnet={openSubnet} dark={dark}
            />
          )}

          {page === 'changes' && (
            <Card variant="borderless" title="变更记录"><ChangeList changes={changes} onOpen={id => void openAsset(id)} /></Card>
          )}

          {page === 'tags' && <TagManager editable={editable} onSessionError={e => handleError(e)} onChanged={setAllTags} onShowAssets={showTagAssets} />}

          {page === 'password' && <ChangePassword onSubmit={changePassword} />}

          {page === 'facilities' && (
            <FacilityView
              roomId={facilityRoomId} onRoomChange={setFacilityRoomId}
              openRackId={facilityRackId} onRackOpened={() => setFacilityRackId(null)}
              layout={facilities} assets={assets} links={links} editable={editable}
              focus={facilityFocus} reload={loadAll} dark={dark}
              bookmarkedRacks={rackBookmarks} onToggleRackBookmark={toggleRackBookmark}
              onOpenAsset={id => void openAsset(id)}
              onSessionError={e => handleError(e)}
            />
          )}

          {page === 'ipam' && (
            <IpamView
              editable={editable}
              openSubnetId={ipamSubnetId} onSubnetOpened={() => setIpamSubnetId(null)}
              bookmarkedSubnets={subnetBookmarks} onToggleSubnetBookmark={toggleSubnetBookmark}
              onSessionError={e => handleError(e)}
              onChanged={() => void loadAll()}
            />
          )}

          {(page === 'assets' || page === 'host' || page === 'vm' || page === 'switch') && (
            <Card
              variant="borderless"
              title={<Space><span>{activePage.label}列表</span><Tag>{filtered.length} 条</Tag></Space>}
              extra={(
                <Space wrap>
                  <Upload
                    accept=".csv,text/csv" showUploadList={false}
                    beforeUpload={file => { void previewCSV(file); return false }}
                  >
                    <Button loading={importing || previewing}><UploadOutlined /> 导入 CSV</Button>
                  </Upload>
                  <Button onClick={downloadTemplate}><DownloadOutlined /> 下载模板</Button>
                  <Button disabled={!filtered.length} onClick={exportCSV}><DownloadOutlined /> 导出 CSV</Button>
                </Space>
              )}
            >
              <div className="table-toolbar">
                <Input
                  className="table-search" allowClear placeholder="搜索名称、IP、宿主机…"
                  prefix={<SearchOutlined />} value={keyword}
                  onChange={event => setKeyword(event.target.value)}
                />
                <Space wrap>
                  <Select
                    style={{ width: 145 }} allowClear placeholder="全部平台" value={platformFilter}
                    onChange={setPlatformFilter}
                    options={[{ value: 'pve', label: 'Proxmox VE' }, { value: 'kvm', label: 'KVM' }]}
                  />
                  <Select
                    style={{ width: 135 }} value={lifecycleFilter} onChange={setLifecycleFilter}
                    options={[
                      { value: 'active', label: '在册' }, { value: 'retired', label: '已退役' }, { value: '', label: '全部生命周期' },
                    ]}
                  />
                  <Select
                    style={{ width: 120 }} allowClear placeholder="全部状态" value={statusFilter}
                    onChange={setStatusFilter}
                    options={Object.entries(statuses).map(([value, item]) => ({ value, label: item.label }))}
                  />
                  <Select
                    mode="multiple" maxTagCount="responsive"
                    style={{ width: 200 }} allowClear
                    placeholder={tagFilterMode === 'any' ? '匹配任一标签' : '同时包含标签'} value={tagFilter}
                    onChange={setTagFilter}
                    options={allTags.map(tag => ({
                      value: tag.id,
                      label: tag.name,
                      optionRender: () => <span className="tag-color-option"><i style={{ background: tag.color }} />{tag.name}</span>,
                    }))}
                  />
                  {tagFilter.length > 1 && (
                    <Select
                      style={{ width: 100 }} value={tagFilterMode}
                      onChange={setTagFilterMode}
                      options={[{ value: 'all', label: '同时满足' }, { value: 'any', label: '任一匹配' }]}
                    />
                  )}
                  <Popover
                    open={filterOpen} onOpenChange={setFilterOpen} trigger="click" placement="bottomRight"
                    content={(
                      <div className="filter-popover">
                        <div className="filter-preset-form">
                          <Input
                            size="small" placeholder="条件名称" value={filterName}
                            onChange={event => setFilterName(event.target.value)}
                            onPressEnter={saveFilterPreset}
                          />
                          <Button size="small" type="primary" onClick={saveFilterPreset}>保存</Button>
                        </div>
                        {filterPresets.length ? filterPresets.map(preset => (
                          <div key={preset.id} className="filter-preset-row">
                            <Button type="link" size="small" onClick={() => applyFilterPreset(preset)}>{preset.name}</Button>
                            <Button
                              type="text" size="small" danger icon={<DeleteOutlined />}
                              aria-label={`删除条件 ${preset.name}`} onClick={() => removeFilterPreset(preset.id)}
                            />
                          </div>
                        )) : <p className="muted filter-preset-empty">暂无保存条件</p>}
                      </div>
                    )}
                  >
                    <Button size="small" icon={<FilterOutlined />}>条件</Button>
                  </Popover>
                  <Popover
                    trigger="click" placement="bottomRight"
                    content={(
                      <div className="column-options">
                        <Checkbox.Group
                          value={visibleColumns}
                          onChange={values => updateVisibleColumns(values.map(String))}
                        >
                          <Space direction="vertical">
                            {assetColumns.map(item => <Checkbox key={item.key} value={item.key}>{item.label}</Checkbox>)}
                          </Space>
                        </Checkbox.Group>
                        <Button type="link" size="small" onClick={() => updateVisibleColumns(defaultAssetColumns)}>恢复默认</Button>
                      </div>
                    )}
                  >
                    <Button size="small" icon={<SettingOutlined />}>列</Button>
                  </Popover>
                </Space>
              </div>
              {editable && selectedAssetIds.length > 0 && (
                <div className="bulk-bar">
                  <span>已选择 <strong>{selectedAssetIds.length}</strong> 条资产</span>
                  <Space>
                    <Button size="small" onClick={openBulkTags}>批量标签</Button>
                    <Button size="small" type="primary" onClick={openBulkEdit}>批量编辑</Button>
                    <Button size="small" onClick={() => setSelectedAssetIds([])}>取消选择</Button>
                  </Space>
                </div>
              )}
              <Table<Asset>
                rowKey="id" columns={columns} dataSource={filtered} loading={busy} size="middle"
                scroll={{ x: 'max-content' }} locale={{ emptyText: '暂无匹配资源' }}
                sortDirections={['ascend', 'descend']}
                showSorterTooltip={{ title: '点击排序' }}
                rowSelection={editable ? {
                  selectedRowKeys: selectedAssetIds,
                  preserveSelectedRowKeys: true,
                  onChange: keys => setSelectedAssetIds(keys.map(Number)),
                } : undefined}
                pagination={{
                  current: pagination, pageSize, total: filtered.length, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'],
                  showTotal: total => `共 ${total} 条`,
                  onChange: (page, size) => {
                    if (size !== pageSize) {
                      setPageSize(size)
                      setPagination(1)
                    } else {
                      setPagination(page)
                    }
                  },
                }}
              />
            </Card>
          )}
        </Content>
      </Layout>

      <Modal
        open={!!importPreview} title="CSV 导入预检" width={940}
        footer={(
          <Space wrap>
            {importPreview?.errors.length ? (
              <Button icon={<DownloadOutlined />} onClick={downloadImportErrors}>下载错误报告</Button>
            ) : null}
            <Button disabled={importing} onClick={() => { setImportPreview(null); setPendingImport(null) }}>取消</Button>
            <Button
              type="primary" loading={importing}
              disabled={!importPreview || importPreview.errors.length > 0 || importPreview.valid === 0}
              onClick={() => { if (pendingImport) void importCSV(pendingImport) }}
            >确认导入 {importPreview?.valid ?? 0} 条</Button>
          </Space>
        )}
        onCancel={() => { if (!importing) { setImportPreview(null); setPendingImport(null) } }}
        destroyOnHidden
      >
        {importPreview && (
          <>
            <Alert
              type={importPreview.errors.length ? 'error' : 'success'} showIcon className="bulk-alert"
              message={importPreview.errors.length
                ? `预检发现 ${importPreview.errors.length} 个问题：共 ${importPreview.rows} 行，可导入 ${importPreview.valid} 行。`
                : `预检通过：共 ${importPreview.rows} 行，可导入 ${importPreview.valid} 行。`}
            />
            <p className="muted">预检不会写入数据；确认后才在一个事务中导入。</p>
            {importPreview.errors.length > 0 && (
              <div className="import-errors">
                {importPreview.errors.slice(0, 20).map((error, index) => (
                  <div key={`${error.row}-${index}`} className="import-error-row">
                    <strong>第 {error.row} 行</strong>
                    <span>{error.message}</span>
                  </div>
                ))}
                {importPreview.errors.length > 20 && (
                  <div className="muted">还有 {importPreview.errors.length - 20} 个问题未显示。</div>
                )}
              </div>
            )}
            {importPreview.sample.length > 0 && (
              <Table
                rowKey="row" size="small" pagination={false} dataSource={importPreview.sample}
                scroll={{ x: 'max-content' }}
                columns={[
                  { title: '行', dataIndex: 'row', width: 56 },
                  { title: '资源名称', dataIndex: 'name', width: 150 },
                  { title: '类型', dataIndex: 'kind', width: 80, render: value => kinds[value as Kind]?.label ?? value },
                  { title: '状态', dataIndex: 'status', width: 90, render: value => statuses[value]?.label ?? (value || '—') },
                  { title: '生命周期', dataIndex: 'lifecycle', width: 90, render: value => value === 'retired' ? '已退役' : '在册' },
                  { title: '负责人', dataIndex: 'owner', width: 110, render: value => value || '—' },
                  { title: '地址 / IP', dataIndex: 'address', width: 140, render: value => <span className="mono">{value || '—'}</span> },
                  { title: '标签', dataIndex: 'tags', width: 150, render: value => Array.isArray(value) && value.length ? value.join('; ') : '—' },
                ]}
              />
            )}
            {importPreview.valid > importPreview.sample.length && (
              <p className="muted">样例仅显示前 {importPreview.sample.length} 行可导入数据。</p>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={bulkTagOpen} title={`批量标签 ${selectedAssetIds.length} 条资产`} footer={null} width={500} destroyOnHidden
        onCancel={() => { if (!bulkTagSaving) setBulkTagOpen(false) }}
      >
        {bulkTagError && <Alert type="error" showIcon message={bulkTagError} className="bulk-alert" />}
        <Form layout="vertical" onFinish={() => void saveBulkTags()}>
          <Form.Item label="操作方式">
            <Radio.Group
              value={bulkTagMode} optionType="button" buttonStyle="solid"
              onChange={event => setBulkTagMode(event.target.value)}
              options={[
                { value: 'add', label: '添加标签' },
                { value: 'remove', label: '移除标签' },
                { value: 'replace', label: '替换全部标签' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="标签"
            extra={bulkTagMode === 'add' ? '给所选资产追加这些标签'
              : bulkTagMode === 'remove' ? '从所选资产移除这些标签'
                : '替换为所选标签；不选择表示清空全部标签'}
          >
            <Select
              mode="multiple" allowClear placeholder="选择标签"
              value={bulkTagIds} onChange={setBulkTagIds}
              options={allTags.map(tag => ({
                value: tag.id,
                label: tag.name,
                optionRender: () => <span className="tag-color-option"><i style={{ background: tag.color }} />{tag.name}</span>,
              }))}
            />
          </Form.Item>
          <div className="bulk-modal-actions">
            <Space>
              <Button type="primary" htmlType="submit" loading={bulkTagSaving}>应用标签</Button>
              <Button disabled={bulkTagSaving} onClick={() => setBulkTagOpen(false)}>取消</Button>
            </Space>
          </div>
        </Form>
      </Modal>

      <Modal
        open={bulkOpen} title={`批量编辑 ${selectedAssetIds.length} 条资产`}
        footer={null} width={520} destroyOnHidden
        onCancel={() => { if (!bulkSaving) { setBulkOpen(false); setBulkError('') } }}
      >
        {bulkError && <Alert type="error" showIcon message={bulkError} className="bulk-alert" />}
        <Form form={bulkForm} layout="vertical" onFinish={values => void saveBulkEdit(values)}>
          <Form.Item label="运行状态" name="status" extra="留空表示不修改">
            <Select
              allowClear placeholder="不修改"
              options={[
                { value: 'online', label: '在线' }, { value: 'offline', label: '离线' },
                { value: 'running', label: '运行中' }, { value: 'stopped', label: '已停止' },
                { value: 'paused', label: '已暂停' }, { value: 'unknown', label: '未知' },
              ]}
            />
          </Form.Item>
          <Form.Item label="生命周期" name="lifecycle" extra="留空表示不修改">
            <Select
              allowClear placeholder="不修改"
              options={[{ value: 'active', label: '在册' }, { value: 'retired', label: '已退役' }]}
            />
          </Form.Item>
          <Form.Item label="负责人" name="owner" extra="留空表示不修改">
            <Input maxLength={512} placeholder="例如：平台组" />
          </Form.Item>
          <Form.Item label="环境" name="environment" extra="留空表示不修改">
            <Input maxLength={128} placeholder="例如：生产" />
          </Form.Item>
          <div className="bulk-modal-actions">
            <Space>
              <Button type="primary" htmlType="submit" loading={bulkSaving}>保存修改</Button>
              <Button disabled={bulkSaving} onClick={() => setBulkOpen(false)}>取消</Button>
            </Space>
          </div>
        </Form>
      </Modal>

      <Modal
        open={tagOpen} title="编辑标签" footer={null} width={460} destroyOnHidden
        onCancel={() => { if (!tagSaving) setTagOpen(false) }}
      >
        {tagError && <Alert type="error" showIcon message={tagError} className="bulk-alert" />}
        <Select
          mode="multiple" allowClear style={{ width: '100%' }} placeholder="选择标签"
          value={selectedTagIds} onChange={setSelectedTagIds}
          optionFilterProp="label"
          options={allTags.map(tag => ({
            value: tag.id,
            label: tag.name,
            title: tag.description || tag.name,
            optionRender: () => (
              <span className="tag-color-option">
                <i style={{ background: tag.color }} />{tag.name}
                {tag.assetCount ? <span className="muted"> · {tag.assetCount} 个资产</span> : null}
              </span>
            ),
          }))}
        />
        <p className="muted tag-modal-hint">标签用于资产分组和筛选。新增或修改标签请前往「系统管理 → 标签管理」。</p>
        <div className="bulk-modal-actions">
          <Space>
            <Button type="primary" loading={tagSaving} onClick={() => void saveAssetTags()}>保存标签</Button>
            <Button disabled={tagSaving} onClick={() => setTagOpen(false)}>取消</Button>
          </Space>
        </div>
      </Modal>

      <Drawer
        open={drawerOpen} width={560}
        title={editor ? (selected ? '编辑资产' : '新增资产') : selected ? (
          <div className="asset-drawer-title">
            <span>{selected.name}</span>
            <Tag>{kinds[selected.kind].label}</Tag>
          </div>
        ) : '资产详情'}
        onClose={closeDrawer} destroyOnHidden
      >
        {editor ? (
          <AssetEditor
            asset={selected} defaultKind={newKind} busy={saving} error={drawerError}
            onSave={fields => void saveAsset(fields)}
            onCancel={() => { setEditor(false); if (!selectedId) closeDrawer() }}
          />
        ) : selected ? (
          <>
            <div className="asset-drawer-toolbar">
              <Space wrap>
                <Tag color={statusOf(selected).color}>{statusOf(selected).label}</Tag>
                {assetTags.map(tag => <Tag key={tag.id} color={tag.color}>{tag.name}</Tag>)}
              </Space>
              <Space>
                <Button
                  icon={bookmarks.includes(selected.id) ? <StarFilled /> : <StarOutlined />}
                  onClick={() => toggleBookmark(selected.id)}
                >{bookmarks.includes(selected.id) ? '已收藏' : '收藏'}</Button>
                {editable && <Button icon={<TagsOutlined />} onClick={() => void openTagEditor()}>标签</Button>}
                {editable && <Button type="primary" onClick={() => setEditor(true)}><EditOutlined /> 编辑</Button>}
              </Space>
            </div>
            {drawerError && <Alert type="error" showIcon message={drawerError} className="drawer-alert" />}
            <Tabs
              className="asset-drawer-tabs" activeKey={assetTab} onChange={setAssetTab}
              items={[
                {
                  key: 'overview', label: '概览',
                  children: (
                    <>
                      <Descriptions bordered size="small" column={1} items={descriptions} />
                      {selected.notes && <p className="detail-notes">{selected.notes}</p>}
                    </>
                  ),
                },
                {
                  key: 'relations', label: `资源关系 (${related.length})`,
                  children: (
                    <>
                      {related.length > 0 && <AssetRelationGraph asset={selected} links={related} assets={assets} dark={dark} />}
                      {editable && relationOptions.length > 0 && <Button size="small" onClick={startRelation}><PlusOutlined /> 添加关系</Button>}
                      {showRelationForm && (
                        <Form layout="inline" className="relation-form" onFinish={() => void updateLink()}>
                          <Form.Item>
                            <Select
                              style={{ width: 150 }} value={relationChoice} placeholder="关系类型"
                              onChange={value => { setRelationChoice(value); setRelationTarget(0) }}
                              options={relationOptions.map(option => ({ value: option.id, label: option.label }))}
                            />
                          </Form.Item>
                          <Form.Item>
                            <Select
                              style={{ width: 170 }} value={relationTarget || undefined} placeholder="选择资源"
                              onChange={setRelationTarget}
                              options={targets.map(target => ({ value: target.id, label: target.name }))}
                            />
                          </Form.Item>
                          <Space>
                            <Button type="primary" htmlType="submit" size="small" disabled={saving || !relationTarget}>保存</Button>
                            <Button size="small" onClick={() => setShowRelationForm(false)}>取消</Button>
                          </Space>
                        </Form>
                      )}
                      {related.length === 0 ? <Empty description="暂无关联资源" /> : (
                        <List
                          size="small" dataSource={related}
                          renderItem={link => (
                            <List.Item
                              actions={editable ? [<Button key="remove" type="link" danger onClick={() => void updateLink(link.id)}>解除</Button>] : []}
                            >
                              <Space>
                                <Tag>{relationLabel(link)}</Tag>
                                <Button type="link" onClick={() => void openAsset(relatedId(link))}>{byId.get(relatedId(link))?.name}</Button>
                              </Space>
                            </List.Item>
                          )}
                        />
                      )}
                    </>
                  ),
                },
                {
                  key: 'attributes', label: `扩展信息 (${Object.keys(selected.attributes).length})`,
                  children: Object.keys(selected.attributes).length > 0 ? (
                    <Descriptions
                      bordered size="small" column={1}
                      items={Object.entries(selected.attributes).map(([key, value]) => ({
                        key, label: key, children: typeof value === 'object' ? JSON.stringify(value) : String(value),
                      }))}
                    />
                  ) : <Empty description="暂无扩展信息" />,
                },
                {
                  key: 'changes', label: '变更记录',
                  children: <ChangeList changes={assetChanges} hideAsset />,
                },
              ]}
            />
          </>
        ) : null}
      </Drawer>
</Layout>
  )
}

