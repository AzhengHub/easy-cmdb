import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert, App as AntApp, Button, Card, ConfigProvider, Descriptions,
  Divider, Drawer, Dropdown, Empty, Form, Input, Layout, List, Menu, Select,
  Space, Spin, Table, Tag, Tooltip, Upload, theme,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  ApartmentOutlined, ApiOutlined, CloudServerOutlined, DatabaseOutlined,
  DesktopOutlined, DownloadOutlined, EditOutlined, GlobalOutlined, HistoryOutlined,
  HomeOutlined, LockOutlined, LogoutOutlined, MenuOutlined, MoonOutlined, PlusOutlined, ReloadOutlined,
  SearchOutlined, SettingOutlined, SunOutlined, UploadOutlined, UserOutlined,
} from '@ant-design/icons'
import { api, apiCSV, APIError } from './api'
import type { Asset, AssetFields, Captcha, Change, Kind, Link, LinkKind, Subnet, User } from './api'
import { assetLocations, locationLabel } from './facilities'
import type { AssetLocation, Facilities } from './facilities'
import type { Page } from './types'
import { AssetEditor } from './components/AssetEditor'
import { ChangeList } from './components/ChangeList'
import { ChangePassword } from './components/ChangePassword'
import { Dashboard } from './components/Dashboard'
import { FacilityView } from './components/FacilityView'
import { IpamView } from './components/IpamView'

const { Header, Sider, Content } = Layout

type NavLeaf = { key: Page; label: string; icon: ReactNode }
type NavGroup = { key: string; label: string; icon: ReactNode; children: NavLeaf[] }

const navigation: (NavLeaf | NavGroup)[] = [
  { key: 'home', label: '首页', icon: <HomeOutlined /> },
  { key: 'host', label: '物理机', icon: <CloudServerOutlined /> },
  { key: 'vm', label: '虚拟机', icon: <DesktopOutlined /> },
  { key: 'switch', label: '交换机', icon: <ApiOutlined /> },
  { key: 'facilities', label: '数据中心', icon: <ApartmentOutlined /> },
  { key: 'ipam', label: 'IPAM', icon: <GlobalOutlined /> },
  {
    key: 'system', label: '系统管理', icon: <SettingOutlined />,
    children: [
      { key: 'changes', label: '变更记录', icon: <HistoryOutlined /> },
      { key: 'password', label: '更改密码', icon: <LockOutlined /> },
    ],
  },
]
const navLeaves = navigation.flatMap(item => 'children' in item ? item.children : [item])


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
const pageSize = 10

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
  const [collapsed, setCollapsed] = useState(false)

  const [assets, setAssets] = useState<Asset[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [changes, setChanges] = useState<Change[]>([])
  const [facilities, setFacilities] = useState<Facilities>({ rooms: [], racks: [], placements: [] })
  const [subnets, setSubnets] = useState<Subnet[]>([])

  const [keyword, setKeyword] = useState('')
  const [platformFilter, setPlatformFilter] = useState<string | undefined>()
  const [lifecycleFilter, setLifecycleFilter] = useState('active')
  const [pagination, setPagination] = useState(1)
  const [importing, setImporting] = useState(false)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [editor, setEditor] = useState(false)
  const [newKind, setNewKind] = useState<Kind>('host')
  const [saving, setSaving] = useState(false)
  const [drawerError, setDrawerError] = useState('')
  const [assetChanges, setAssetChanges] = useState<Change[]>([])
  const [showRelationForm, setShowRelationForm] = useState(false)
  const [relationChoice, setRelationChoice] = useState('')
  const [relationTarget, setRelationTarget] = useState(0)
  const [facilityFocus, setFacilityFocus] = useState<AssetLocation | null>(null)

  const activePage = navLeaves.find(item => item.key === page)!
  const editable = user?.role !== 'viewer'
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
    if (page === 'home' || page === 'changes' || page === 'password' || page === 'facilities' || page === 'ipam') return []
    return assets.filter(asset => asset.kind === page)
  }, [assets, page])
  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return scoped.filter(asset => {
      if (lifecycleFilter && asset.lifecycle !== lifecycleFilter) return false
      if (platformFilter && asset.platform !== platformFilter) return false
      return !query || [asset.name, asset.address, asset.owner, asset.environment, ...(vmRelations.get(asset.id) ?? [])]
        .some(value => value?.toLowerCase().includes(query))
    })
  }, [scoped, lifecycleFilter, platformFilter, keyword, vmRelations])

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
    if (!chosenRelation && relationOptions.length) setRelationChoice(relationOptions[0].id)
  }, [relationOptions, chosenRelation])

  async function loadAll() {
    setBusy(true)
    setError('')
    try {
      const [nextAssets, nextLinks, nextChanges, nextFacilities, nextSubnets] = await Promise.all([
        api<Asset[]>('/assets'), api<Link[]>('/links'), api<Change[]>('/changes'),
        api<Facilities>('/facilities'), api<Subnet[]>('/subnets'),
      ])
      setAssets(nextAssets)
      setLinks(nextLinks)
      setChanges(nextChanges)
      setFacilities(nextFacilities)
      setSubnets(nextSubnets)
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
    if (window.innerWidth < 992) setCollapsed(true)
    setKeyword('')
    setPlatformFilter(undefined)
    setLifecycleFilter('active')
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
    setEditor(false)
    setDrawerError('')
    setShowRelationForm(false)
    setDrawerOpen(true)
    try {
      setAssetChanges(await api<Change[]>('/changes?assetId=' + id))
    } catch (e) {
      handleError(e, true)
    }
  }

  function startNew() {
    setSelectedId(null)
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

  function exportCSV() {
    const rows: (string | number)[][] = [[
      '资源名称', '类型', '平台', '状态', '生命周期', '地址 / IP', 'CPU', '内存 MiB', '负责人', '环境', '备注', '扩展属性',
    ]]
    for (const asset of filtered) {
      rows.push([
        asset.name, kinds[asset.kind].label, platformLabel(asset), statusOf(asset).label,
        asset.lifecycle === 'retired' ? '已退役' : '在册', asset.address, asset.cpu, asset.memoryMiB,
        asset.owner, asset.environment, asset.notes, JSON.stringify(asset.attributes),
      ])
    }
    downloadCSV('easy-cmdb-assets.csv', rows)
  }

  function downloadTemplate() {
    downloadCSV('easy-cmdb-import-template.csv', [[
      '资源名称', '类型', '平台', '状态', '生命周期', '地址 / IP', 'CPU', '内存 MiB', '负责人', '环境', '备注', '扩展属性',
    ]])
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

  const columns: TableColumnsType<Asset> = [
    {
      title: '资源名称', key: 'name', width: 260,
      render: (_, asset) => (
        <Button type="link" className="asset-link" onClick={() => void openAsset(asset.id)}>
          {kinds[asset.kind].icon}
          <span>{asset.name}</span>
          {asset.environment && <span className="asset-sub">{asset.environment}</span>}
        </Button>
      ),
    },
    { title: '类型', key: 'kind', width: 90, render: (_, asset) => kinds[asset.kind].label },
    { title: '状态', key: 'status', width: 100, render: (_, asset) => <Tag color={statusOf(asset).color}>{statusOf(asset).label}</Tag> },
    { title: page === 'vm' ? '宿主机' : '平台', key: 'meta', width: 130, render: (_, asset) => page === 'vm' ? hostName(asset) : platformLabel(asset) },
    { title: '地址 / IP', dataIndex: 'address', key: 'address', width: 170, render: value => <span className="mono">{value || '—'}</span> },
    { title: '负责人', dataIndex: 'owner', key: 'owner', width: 120, render: value => value || '—' },
    { title: '', key: 'actions', width: 72, render: (_, asset) => <Button type="link" size="small" onClick={() => void openAsset(asset.id)}>查看</Button> },
  ]

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
  ] : []

  if (checking) return <div className="app-loading"><Spin size="large" /></div>

  if (!user) {
    return (
      <div className="login-page">
        <ThemeToggle dark={dark} onToggleTheme={onToggleTheme} className="login-theme-toggle" />
        <Card className="login-card" variant="borderless">
          <div className="login-brand"><DatabaseOutlined /> Easy CMDB</div>
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
      </div>
    )
  }

  return (
    <Layout className="app-layout">
      <Sider
        className="app-sider" width={200} collapsedWidth={0} collapsed={collapsed}
        breakpoint="lg" trigger={null} onCollapse={setCollapsed}
      >
        <div className="brand" onClick={() => goTo('home')}>
          <DatabaseOutlined className="brand-icon" />
          <span>Easy CMDB</span>
        </div>
        <Menu
          className="app-menu" mode="inline" selectedKeys={[page]} defaultOpenKeys={['system']}
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
          <Space>
            <Button type="text" onClick={() => setCollapsed(value => !value)}><MenuOutlined /></Button>
          </Space>
          <Space size={4}>
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
          <div className="page-header">
            <div>
              <h1>{activePage.label}</h1>
            </div>
            {(page === 'host' || page === 'vm' || page === 'switch') && editable && (
              <Button type="primary" onClick={startNew}><PlusOutlined /> 新增资产</Button>
            )}
          </div>

          {error && <Alert type="error" showIcon closable message={error} className="page-alert" onClose={() => setError('')} />}

          {page === 'home' && (
            <Dashboard
              assets={assets} subnets={subnets} facilities={facilities} changes={changes}
              onGo={goTo} onOpenAsset={id => void openAsset(id)} dark={dark}
            />
          )}

          {page === 'changes' && (
            <Card variant="borderless" title="变更记录"><ChangeList changes={changes} onOpen={id => void openAsset(id)} /></Card>
          )}

          {page === 'password' && <ChangePassword onSubmit={changePassword} />}

          {page === 'facilities' && (
            <FacilityView
              layout={facilities} assets={assets} links={links} editable={editable}
              focus={facilityFocus} reload={loadAll} dark={dark}
              onOpenAsset={id => void openAsset(id)}
              onSessionError={e => handleError(e)}
            />
          )}

          {page === 'ipam' && (
            <IpamView
              editable={editable}
              onSessionError={e => handleError(e)}
              onChanged={() => void loadAll()}
            />
          )}

          {(page === 'host' || page === 'vm' || page === 'switch') && (
            <Card
              variant="borderless"
              title={<Space><span>{activePage.label}列表</span><Tag>{filtered.length} 条</Tag></Space>}
              extra={(
                <Space wrap>
                  <Upload
                    accept=".csv,text/csv" showUploadList={false}
                    beforeUpload={file => { void importCSV(file); return false }}
                  >
                    <Button loading={importing}><UploadOutlined /> 导入 CSV</Button>
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
                </Space>
              </div>
              <Table<Asset>
                rowKey="id" columns={columns} dataSource={filtered} loading={busy} size="middle"
                scroll={{ x: 900 }} locale={{ emptyText: '暂无匹配资源' }}
                pagination={{
                  current: pagination, pageSize, total: filtered.length, showSizeChanger: false,
                  showTotal: total => `共 ${total} 条`, onChange: setPagination,
                }}
              />
            </Card>
          )}
        </Content>
      </Layout>

      <Drawer
        open={drawerOpen} width={560} title={editor ? (selected ? '编辑资产' : '新增资产') : (selected?.name ?? '资产详情')}
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
            <Space className="detail-tags">
              <Tag color={statusOf(selected).color}>{statusOf(selected).label}</Tag>
              <Tag>{kinds[selected.kind].label}</Tag>
            </Space>
            {drawerError && <Alert type="error" showIcon message={drawerError} className="drawer-alert" />}
            {editable && <Button type="primary" className="drawer-edit" onClick={() => setEditor(true)}><EditOutlined /> 编辑</Button>}
            <Descriptions bordered size="small" column={1} items={descriptions} className="detail-descriptions" />
            {selected.notes && <p className="detail-notes">{selected.notes}</p>}

            <Divider titlePlacement="start">资源关系</Divider>
            {editable && relationOptions.length > 0 && <Button size="small" onClick={startRelation}><PlusOutlined /> 添加</Button>}
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

            {Object.keys(selected.attributes).length > 0 && (
              <>
                <Divider titlePlacement="start">扩展信息</Divider>
                <Descriptions
                  bordered size="small" column={1}
                  items={Object.entries(selected.attributes).map(([key, value]) => ({
                    key, label: key, children: typeof value === 'object' ? JSON.stringify(value) : String(value),
                  }))}
                />
              </>
            )}

            <Divider titlePlacement="start">变更记录</Divider>
            <ChangeList changes={assetChanges} hideAsset />
          </>
        ) : null}
      </Drawer>
    </Layout>
  )
}

