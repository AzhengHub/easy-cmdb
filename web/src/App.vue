<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import {
  Activity, ArrowDownToLine, ArrowRight, Box, Boxes, ChevronLeft, ChevronRight,
  Database, HardDrive, History, LayoutGrid, Link2, LogOut, MapPin, Menu, Monitor,
  Network, Pencil, Plus, Radio, RefreshCw, Search, Server, ShieldCheck, X,
} from '@lucide/vue'
import AssetEditor from './AssetEditor.vue'
import ChangeList from './ChangeList.vue'
import { api, APIError } from './api'
import type { Asset, AssetFields, Change, Kind, Link, LinkKind, SyncRun, User } from './api'
import { assetLocations, locationLabel } from './facilities'
import type { AssetLocation, Facilities } from './facilities'

const FacilityView = defineAsyncComponent(() => import('./FacilityView.vue'))

type Page = 'overview' | 'host' | 'vm' | 'infrastructure' | 'business' | 'sync' | 'changes' | 'facilities'
const navigation = [
  { id: 'overview', title: '资源总览', icon: LayoutGrid, description: '查看物理资源、虚拟化平台和业务归属。' },
  { id: 'host', title: '物理机', icon: Server, description: '维护物理硬件、计算节点和宿主机。' },
  { id: 'vm', title: '虚拟机', icon: Monitor, description: '查询虚拟机配置、运行状态和所在宿主机。' },
  { id: 'infrastructure', title: '集群与机箱', icon: Boxes, description: '管理 PVE 集群成员和物理机箱的节点关系。' },
  { id: 'facilities', title: '机房视图', icon: MapPin, description: '摆放机柜、管理设备 U 位，并在三维布局中定位资产。' },
  { id: 'business', title: '业务管理', icon: Network, description: '维护业务负责人、环境和关联资源。' },
  { id: 'sync', title: '采集状态', icon: Radio, description: '查看各虚拟化平台的采集结果和最后成功时间。' },
  { id: 'changes', title: '变更记录', icon: History, description: '追溯人工修改、配置同步和资源关系变化。' },
] as const

const kinds = {
  chassis: { label: '机箱', icon: Box },
  host: { label: '物理机', icon: Server },
  cluster: { label: '集群', icon: Boxes },
  vm: { label: '虚拟机', icon: Monitor },
  business: { label: '业务', icon: Network },
  switch: { label: '交换机', icon: Network },
}
const statuses: Record<string, { label: string; tone: string }> = {
  online: { label: '在线', tone: 'green' },
  running: { label: '运行中', tone: 'green' },
  stopped: { label: '已停止', tone: 'gray' },
  paused: { label: '已暂停', tone: 'amber' },
  offline: { label: '离线', tone: 'red' },
  unknown: { label: '未知', tone: 'gray' },
}
const relations: { kind: LinkKind; from: Kind; to: Kind[]; outgoing: string; incoming: string }[] = [
  { kind: 'contains', from: 'chassis', to: ['host'], outgoing: '容纳节点', incoming: '所在机箱' },
  { kind: 'member', from: 'cluster', to: ['host'], outgoing: '集群成员', incoming: '所属集群' },
  { kind: 'hosts', from: 'host', to: ['vm'], outgoing: '承载虚拟机', incoming: '所在宿主机' },
  { kind: 'uses', from: 'business', to: ['host', 'vm'], outgoing: '使用资源', incoming: '所属业务' },
]

const user = ref<User | null>(null)
const checking = ref(true)
const busy = ref(false)
const loginBusy = ref(false)
const loginForm = ref({ username: '', password: '' })
const error = ref('')
const toast = ref('')
const drawerError = ref('')
const saving = ref(false)
const page = ref<Page>('overview')
const menuOpen = ref(false)
const assets = ref<Asset[]>([])
const links = ref<Link[]>([])
const runs = ref<SyncRun[]>([])
const changes = ref<Change[]>([])
const facilities = ref<Facilities>({ rooms: [], racks: [], placements: [] })
const facilityFocus = ref<AssetLocation | null>(null)
const assetChanges = ref<Change[]>([])
const keyword = ref('')
const platformFilter = ref('')
const kindFilter = ref('')
const lifecycleFilter = ref('active')
const pagination = ref(1)
const pageSize = 10
const drawer = ref<HTMLDialogElement>()
const selectedId = ref<number | null>(null)
const editor = ref(false)
const newKind = ref<Kind>('host')
const showRelationForm = ref(false)
const relationChoice = ref('')
const relationTarget = ref(0)
const refreshedAt = ref('')
let toastTimeout = 0

const selected = computed(() => assets.value.find(a => a.id === selectedId.value) ?? null)
const activePage = computed(() => navigation.find(n => n.id === page.value)!)
const editable = computed(() => user.value?.role !== 'viewer')
const activeAssets = computed(() => assets.value.filter(a => a.lifecycle === 'active'))
const byId = computed(() => new Map(assets.value.map(a => [a.id, a])))
const locations = computed(() => assetLocations(facilities.value, links.value))
const selectedLocation = computed(() => selected.value && locations.value.get(selected.value.id))
const runByKey = computed(() => new Map(runs.value.map(run => [run.sourceKey, run])))
const related = computed(() => links.value.filter(l => l.fromId === selectedId.value || l.toId === selectedId.value))
const vmRelations = computed(() => {
  const data = new Map<number, string[]>()
  for (const link of links.value) {
    if (link.kind === 'hosts' || link.kind === 'uses') {
      const names = data.get(link.toId) ?? []
      names.push(link.fromName)
      data.set(link.toId, names)
    }
  }
  return data
})
const failedRuns = computed(() => runs.value.filter(r => r.status === 'failed').length)
const metrics = computed(() => [
  { label: '物理机', count: activeAssets.value.filter(a => a.kind === 'host').length, icon: Server, target: 'host', tone: 'blue',
    hint: '含独立主机与集群节点' },
  { label: '虚拟机', count: activeAssets.value.filter(a => a.kind === 'vm').length, icon: Monitor, target: 'vm', tone: 'violet',
    hint: activeAssets.value.filter(a => a.kind === 'vm' && a.status === 'running').length + ' 台运行中' },
  { label: '虚拟化集群', count: activeAssets.value.filter(a => a.kind === 'cluster').length, icon: Boxes, target: 'infrastructure', tone: 'teal',
    hint: '按集群查看计算节点' },
  { label: '业务', count: activeAssets.value.filter(a => a.kind === 'business').length, icon: Network, target: 'business', tone: 'amber',
    hint: '业务与资源归属' },
] as const)

const scope = computed(() => assets.value.filter(asset => {
  if (page.value === 'overview') return !kindFilter.value || asset.kind === kindFilter.value
  if (page.value === 'infrastructure') return asset.kind === 'chassis' || asset.kind === 'cluster'
  return asset.kind === page.value
}))
const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return scope.value.filter(a => {
    if (lifecycleFilter.value && a.lifecycle !== lifecycleFilter.value) return false
    if (platformFilter.value && a.platform !== platformFilter.value) return false
    return !query || [a.name, a.address, a.owner, a.environment, a.externalKey, a.sourceKey, ...(vmRelations.value.get(a.id) ?? [])]
      .some(value => value?.toLowerCase().includes(query))
  })
})
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const visible = computed(() => filtered.value.slice((pagination.value - 1) * pageSize, pagination.value * pageSize))

watch([keyword, platformFilter, kindFilter, lifecycleFilter], () => { pagination.value = 1 })
watch(totalPages, count => { if (pagination.value > count) pagination.value = count })

const relationOptions = computed(() => {
  const a = selected.value
  if (!a) return []
  return relations.flatMap(relation => {
    const items: { id: string; label: string; direction: 'out' | 'in'; relation: typeof relation }[] = []
    if (relation.from === a.kind) items.push({ id: relation.kind + '-out', label: relation.outgoing, direction: 'out', relation })
    const managed = a.sourceKey && (relation.kind === 'hosts' || relation.kind === 'member')
    if (relation.to.includes(a.kind) && !managed) items.push({ id: relation.kind + '-in', label: relation.incoming, direction: 'in', relation })
    return items
  })
})
const chosenRelation = computed(() => relationOptions.value.find(option => option.id === relationChoice.value))
const targets = computed(() => {
  const option = chosenRelation.value
  if (!option) return []
  const { direction, relation } = option
  return activeAssets.value.filter(a => {
    if (a.id === selectedId.value) return false
    if (direction === 'in') return a.kind === relation.from
    if (a.sourceKey && (relation.kind === 'hosts' || relation.kind === 'member')) return false
    return relation.to.includes(a.kind)
  })
})
watch(relationChoice, () => { relationTarget.value = 0 })

function date(text?: string | null) {
  return text ? new Date(text).toLocaleString('zh-CN', { hour12: false }) : '—'
}
function platform(asset: { platform: string }) {
  return asset.platform === 'pve' ? 'Proxmox VE' : asset.platform === 'kvm' ? 'KVM' : '—'
}
function status(asset: Asset) {
  if (asset.lifecycle === 'retired') return { label: '已退役', tone: 'gray' }
  if (asset.missingCount >= 2) return { label: '待核查', tone: 'amber' }
  if (asset.sourceKey && runByKey.value.get(asset.sourceKey)?.status === 'failed') return { label: '数据过期', tone: 'amber' }
  return statuses[asset.status] ?? statuses.unknown
}
function relationLabel(link: Link) {
  const type = relations.find(r => r.kind === link.kind)
  return (link.fromId === selectedId.value ? type?.outgoing : type?.incoming) ?? link.kind
}
function relatedId(link: Link) {
  return link.fromId === selectedId.value ? link.toId : link.fromId
}
function hostName(asset: Asset) {
  return links.value.find(l => l.kind === 'hosts' && l.toId === asset.id)?.fromName ?? '—'
}
function message(e: unknown) {
  return e instanceof Error ? e.message : '操作失败'
}
function report(e: unknown, inDrawer = false) {
  if (e instanceof APIError && e.status === 401 && user.value) {
    closeDrawer()
    user.value = null
  }
  if (inDrawer && user.value) drawerError.value = message(e)
  else error.value = message(e)
}
function notify(text: string) {
  toast.value = text
  window.clearTimeout(toastTimeout)
  toastTimeout = window.setTimeout(() => { toast.value = '' }, 2800)
}

async function refresh() {
  busy.value = true
  error.value = ''
  try {
    const [nextAssets, nextLinks, nextRuns, nextChanges, nextFacilities] = await Promise.all([
      api<Asset[]>('/assets'), api<Link[]>('/links'), api<SyncRun[]>('/sync-runs'), api<Change[]>('/changes'),
      api<Facilities>('/facilities'),
    ])
    assets.value = nextAssets
    links.value = nextLinks
    runs.value = nextRuns
    changes.value = nextChanges
    facilities.value = nextFacilities
    refreshedAt.value = new Date().toISOString()
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}
async function login() {
  loginBusy.value = true
  error.value = ''
  try {
    user.value = await api<User>('/login', 'POST', loginForm.value)
    loginForm.value.password = ''
    await refresh()
  } catch (e) {
    report(e)
  } finally {
    loginBusy.value = false
  }
}
async function logout() {
  try {
    await api('/logout', 'POST')
    closeDrawer()
    user.value = null
    assets.value = []
    links.value = []
    runs.value = []
    changes.value = []
    facilities.value = { rooms: [], racks: [], placements: [] }
    goTo('overview')
  } catch (e) {
    report(e)
  }
}
onMounted(async () => {
  try {
    user.value = await api<User>('/me')
    await refresh()
  } catch (e) {
    if (!(e instanceof APIError && e.status === 401)) report(e)
  } finally {
    checking.value = false
  }
})

function goTo(next: Page) {
  page.value = next
  menuOpen.value = false
  keyword.value = ''
  kindFilter.value = ''
  platformFilter.value = ''
  lifecycleFilter.value = 'active'
  pagination.value = 1
  facilityFocus.value = null
}

function showAssetLocation(location: AssetLocation) {
  closeDrawer()
  goTo('facilities')
  facilityFocus.value = location
}
function displayDrawer() {
  if (!drawer.value?.open) drawer.value?.showModal()
}
function closeDrawer() {
  if (saving.value) return
  drawer.value?.close()
  selectedId.value = null
  editor.value = false
  drawerError.value = ''
  showRelationForm.value = false
}
async function openAsset(id: number) {
  if (!byId.value.has(id)) return
  selectedId.value = id
  assetChanges.value = []
  editor.value = false
  drawerError.value = ''
  showRelationForm.value = false
  displayDrawer()
  try {
    const items = await api<Change[]>('/changes?assetId=' + id)
    if (selectedId.value === id) assetChanges.value = items
  } catch (e) {
    if (selectedId.value === id) report(e, true)
  }
}
function startNew() {
  selectedId.value = null
  newKind.value = page.value === 'infrastructure' ? 'cluster' :
    page.value === 'vm' || page.value === 'business' ? page.value : 'host'
  editor.value = true
  drawerError.value = ''
  displayDrawer()
}
async function saveAsset(fields: AssetFields & { version: number }) {
  saving.value = true
  drawerError.value = ''
  try {
    const id = selectedId.value
    const a = await api<Asset>(id ? '/assets/' + id : '/assets', id ? 'PUT' : 'POST', fields)
    await refresh()
    if (user.value) {
      await openAsset(a.id)
      notify(id ? '资产已更新' : '资产已添加')
    }
  } catch (e) {
    report(e, true)
  } finally {
    saving.value = false
    if (!user.value) closeDrawer()
  }
}
function startRelation() {
  showRelationForm.value = true
  relationChoice.value = relationOptions.value[0]?.id ?? ''
  relationTarget.value = 0
  drawerError.value = ''
}
async function updateLink(removeId?: number) {
  const id = selectedId.value
  if (!id) return
  const choice = chosenRelation.value
  if (!removeId && (!choice || !relationTarget.value)) return
  saving.value = true
  drawerError.value = ''
  try {
    if (removeId) {
      await api('/links/' + removeId, 'DELETE')
    } else if (choice) {
      const [fromId, toId] = choice.direction === 'out' ? [id, relationTarget.value] : [relationTarget.value, id]
      await api('/links', 'POST', { kind: choice.relation.kind, fromId, toId })
    }
    await refresh()
    if (user.value) {
      await openAsset(id)
      notify(removeId ? '关系已解除' : '关系已添加')
    }
  } catch (e) {
    report(e, true)
  } finally {
    saving.value = false
    if (!user.value) closeDrawer()
  }
}
function exportCSV() {
  function cell(input: string | number) {
    const text = String(input)
    const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text
    return '"' + safe.replaceAll('"', '""') + '"'
  }
  const rows = [['资源名称', '类型', '平台', '状态', '地址 / IP', 'CPU', '内存 MiB', '负责人', '环境']]
  for (const a of filtered.value) {
    rows.push([a.name, kinds[a.kind].label, platform(a), status(a).label, a.address, String(a.cpu), String(a.memoryMiB), a.owner, a.environment])
  }
  const csv = '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'radar-cmdb-assets.csv'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <div v-if="checking" class="login-shell"><div class="loading"><Radio :size="24" /> 正在连接 Radar CMDB…</div></div>
  <main v-else-if="!user" class="login-shell">
    <div class="login-decoration" aria-hidden="true"><div></div><div></div><div></div></div>
    <div class="login-card">
      <div class="login-brand"><span class="brand-mark"><Radio :size="24" /></span> Radar CMDB</div>
      <p class="eyebrow login-kicker">INFRASTRUCTURE INVENTORY</p>
      <h1>登录资源管理台</h1>
      <p class="muted">统一管理基础设施、虚拟机与业务关系。</p>
      <form class="login-form" @submit.prevent="login">
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <label>账号<input v-model="loginForm.username" autocomplete="username" required maxlength="80" /></label>
        <label>密码<input v-model="loginForm.password" type="password" autocomplete="current-password" required maxlength="512" /></label>
        <button class="button primary login-submit" :disabled="loginBusy">
          {{ loginBusy ? '正在登录…' : '登录' }} <ArrowRight :size="17" />
        </button>
      </form>
    </div>
  </main>
  <div v-else class="layout">
    <button v-if="menuOpen" type="button" class="mobile-scrim" aria-label="关闭导航" @click="menuOpen = false"></button>
    <aside class="sidebar" :class="{ 'mobile-open': menuOpen }">
      <button class="brand" @click="goTo('overview')">
        <span class="brand-mark"><Radio :size="23" /></span>
        <span>Radar CMDB<small>基础设施管理</small></span>
      </button>
      <p class="nav-label">工作区</p>
      <nav aria-label="主导航">
        <button v-for="item in navigation" :key="item.id" class="nav-item" :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined" @click="goTo(item.id)">
          <component :is="item.icon" :size="17" /><span>{{ item.title }}</span>
          <span v-if="item.id === 'sync' && failedRuns" class="nav-count">{{ failedRuns }}</span>
        </button>
      </nav>
      <div class="sidebar-foot"><span class="live-dot"></span> 资产管理工作区</div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="breadcrumb">
          <button class="icon-button mobile-menu" aria-label="打开导航" @click="menuOpen = true"><Menu :size="21" /></button>
          <span class="breadcrumb-root">工作区</span><ChevronRight :size="14" /><strong>{{ activePage.title }}</strong>
        </div>
        <div class="topbar-actions">
          <button class="icon-button" title="刷新数据" aria-label="刷新数据" :disabled="busy" @click="refresh">
            <RefreshCw :size="17" :class="{ spinning: busy }" />
          </button>
          <div class="user-chip"><span class="avatar">{{ user.username.slice(0, 1).toUpperCase() }}</span>
            <span class="user-name">{{ user.username }}<small>{{ { admin: '管理员', operator: '运维', viewer: '只读' }[user.role] }}</small></span>
          </div>
          <button class="icon-button" title="退出登录" aria-label="退出登录" @click="logout"><LogOut :size="17" /></button>
        </div>
      </header>

      <main class="content">
        <div class="page-heading">
          <div>
            <p class="eyebrow">INFRASTRUCTURE</p>
            <h1>{{ activePage.title }}</h1>
            <p class="muted">{{ activePage.description }}</p>
          </div>
          <button v-if="editable && page !== 'changes' && page !== 'sync' && page !== 'facilities'" class="button primary" @click="startNew">
            <Plus :size="17" /> 新增资产
          </button>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>

        <section v-if="page === 'overview'" class="metrics" aria-label="资源统计">
          <button v-for="metric in metrics" :key="metric.label" class="metric" @click="goTo(metric.target)">
            <span class="metric-top">
              <span class="metric-icon" :class="metric.tone"><component :is="metric.icon" :size="19" /></span>
              <ArrowRight :size="16" class="metric-arrow" />
            </span>
            <span class="metric-count">{{ metric.count }}</span>
            <span class="metric-label">{{ metric.label }}</span>
            <span class="metric-hint">{{ metric.hint }}</span>
          </button>
        </section>

        <section v-if="page === 'sync'" class="panel">
          <div class="panel-heading"><div><h2>数据源</h2><p class="muted">显示最近一次采集结果</p></div></div>
          <div v-if="!runs.length" class="empty-state">
            <Radio :size="28" /><h3>暂无采集结果</h3><p>启动并配置采集进程后，结果会显示在这里。</p>
          </div>
          <div v-else class="table-scroll">
            <table>
              <thead><tr><th>数据源</th><th>平台</th><th>状态</th><th>资源数</th><th>最后尝试</th><th>最后成功</th><th>说明</th></tr></thead>
              <tbody><tr v-for="run in runs" :key="run.sourceKey">
                <td><strong>{{ run.sourceKey }}</strong></td><td>{{ platform(run) }}</td>
                <td><span class="tag" :class="run.status === 'ok' ? 'green' : 'red'">{{ run.status === 'ok' ? '成功' : '失败' }}</span></td>
                <td>{{ run.resourceCount }}</td><td>{{ date(run.finishedAt) }}</td><td>{{ date(run.lastSuccessAt) }}</td><td>{{ run.message || '—' }}</td>
              </tr></tbody>
            </table>
          </div>
        </section>

        <section v-else-if="page === 'changes'" class="panel">
          <div class="panel-heading"><div><h2>审计时间线</h2><p class="muted">最近 100 条变更</p></div><History :size="20" class="muted" /></div>
          <ChangeList :changes="changes" @open="openAsset" />
        </section>

        <FacilityView v-else-if="page === 'facilities'" :layout="facilities" :assets="assets" :links="links"
          :editable="editable" :focus="facilityFocus" :reload="refresh" @open-asset="openAsset" @session-error="report" />

        <section v-else class="panel">
          <div class="panel-heading">
            <div><h2>{{ page === 'overview' ? '资源台账' : '资源列表' }}</h2><p class="muted">共 {{ filtered.length }} 条记录</p></div>
            <button class="button" :disabled="!filtered.length" @click="exportCSV"><ArrowDownToLine :size="16" /> 导出 CSV</button>
          </div>
          <div class="filters">
            <label class="search"><Search :size="17" /><input v-model="keyword" aria-label="搜索资源" placeholder="搜索名称、IP、业务、宿主机…" /></label>
            <select v-if="page === 'overview'" v-model="kindFilter" aria-label="资源类型">
              <option value="">全部类型</option><option v-for="(type, key) in kinds" :key="key" :value="key">{{ type.label }}</option>
            </select>
            <select v-if="page !== 'business'" v-model="platformFilter" aria-label="平台">
              <option value="">全部平台</option><option value="pve">Proxmox VE</option><option value="kvm">KVM</option>
            </select>
            <select v-model="lifecycleFilter" aria-label="生命周期">
              <option value="active">在册</option><option value="retired">已退役</option><option value="">全部生命周期</option>
            </select>
          </div>
          <div v-if="!visible.length" class="empty-state">
            <Database :size="28" /><h3>{{ busy ? '正在加载…' : '暂无匹配资源' }}</h3><p>可以调整筛选条件，或从新增资产开始。</p>
          </div>
          <div v-else class="table-scroll">
            <table class="asset-table">
              <thead><tr>
                <th>资源名称</th><th>类型</th><th>状态</th><th>{{ page === 'vm' ? '宿主机' : '平台' }}</th><th>地址 / IP</th><th>负责人</th><th><span class="sr-only">详情</span></th>
              </tr></thead>
              <tbody>
                <tr v-for="a in visible" :key="a.id">
                  <td><button class="asset-name" @click="openAsset(a.id)">
                    <span class="asset-icon" :class="a.kind"><component :is="kinds[a.kind].icon" :size="16" /></span>
                    <span>{{ a.name }}<small v-if="a.environment">{{ a.environment }}</small></span>
                  </button></td>
                  <td>{{ kinds[a.kind].label }}</td>
                  <td><span class="tag" :class="status(a).tone"><span class="status-dot"></span>{{ status(a).label }}</span></td>
                  <td>{{ page === 'vm' ? hostName(a) : platform(a) }}</td><td class="mono">{{ a.address || '—' }}</td><td>{{ a.owner || '—' }}</td>
                  <td><button class="icon-button table-action" :aria-label="'查看 ' + a.name" @click="openAsset(a.id)"><ChevronRight :size="17" /></button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer class="panel-footer">
            <span>{{ filtered.length ? (pagination - 1) * pageSize + 1 : 0 }}–{{ Math.min(pagination * pageSize, filtered.length) }} / {{ filtered.length }} 条</span>
            <div class="pager"><button class="icon-button" aria-label="上一页" :disabled="pagination <= 1" @click="pagination--"><ChevronLeft :size="17" /></button>
              <span>{{ pagination }} / {{ totalPages }}</span>
              <button class="icon-button" aria-label="下一页" :disabled="pagination >= totalPages" @click="pagination++"><ChevronRight :size="17" /></button></div>
          </footer>
        </section>
        <p v-if="refreshedAt" class="refresh-note"><Activity :size="14" /> 页面更新于 {{ date(refreshedAt) }}</p>
      </main>
    </div>
  </div>

  <dialog ref="drawer" class="drawer" aria-label="资产详情" @cancel.prevent="closeDrawer">
    <AssetEditor v-if="editor" :asset="selected" :default-kind="newKind" :busy="saving" :error="drawerError"
      @save="saveAsset" @cancel="selectedId ? openAsset(selectedId) : closeDrawer()" />
    <template v-else-if="selected">
      <div class="drawer-title">
        <div><p class="eyebrow">{{ kinds[selected.kind].label }} · #{{ selected.id }}</p><h2>{{ selected.name }}</h2></div>
        <button class="icon-button" aria-label="关闭详情" @click="closeDrawer"><X :size="20" /></button>
      </div>
      <div class="drawer-body">
        <div class="detail-toolbar">
          <span class="tag" :class="status(selected).tone"><span class="status-dot"></span>{{ status(selected).label }}</span>
          <button v-if="editable" class="button small" @click="drawerError = ''; editor = true"><Pencil :size="14" /> 编辑</button>
        </div>
        <p v-if="drawerError" class="error" role="alert">{{ drawerError }}</p>
        <dl class="detail-grid">
          <div><dt>平台</dt><dd>{{ platform(selected) }}</dd></div>
          <div><dt>负责人</dt><dd>{{ selected.owner || '—' }}</dd></div>
          <div><dt>环境</dt><dd>{{ selected.environment || '—' }}</dd></div>
          <div><dt>管理地址 / IP</dt><dd class="mono">{{ selected.address || '—' }}</dd></div>
          <div v-if="selected.kind === 'host' || selected.kind === 'vm'"><dt>CPU / 内存</dt><dd>{{ selected.cpu || '—' }} 核 · {{ selected.memoryMiB ? selected.memoryMiB / 1024 + ' GiB' : '—' }}</dd></div>
          <div><dt>数据来源</dt><dd>{{ selected.sourceKey || '人工维护' }}</dd></div>
          <div v-if="selected.externalKey"><dt>外部标识</dt><dd class="mono">{{ selected.externalKey }}</dd></div>
          <div v-if="selected.lastSeenAt"><dt>最近发现</dt><dd>{{ date(selected.lastSeenAt) }}</dd></div>
          <div v-if="selectedLocation"><dt>机房位置</dt>
            <dd><button type="button" class="text-button" @click="showAssetLocation(selectedLocation)">{{ locationLabel(selectedLocation) }}</button></dd>
            <dd v-if="selectedLocation.placement.assetId !== selected.id" class="muted">随 {{ byId.get(selectedLocation.placement.assetId)?.name }} 定位</dd>
          </div>
        </dl>
        <p v-if="selected.notes" class="detail-notes">{{ selected.notes }}</p>

        <section class="detail-section">
          <div class="detail-heading"><h3><Link2 :size="17" /> 资源关系</h3>
            <button v-if="editable && relationOptions.length" class="button small" @click="startRelation"><Plus :size="15" /> 添加</button>
          </div>
          <form v-if="showRelationForm" class="link-form" @submit.prevent="updateLink()">
            <select v-model="relationChoice" aria-label="关系类型"><option v-for="option in relationOptions" :key="option.id" :value="option.id">{{ option.label }}</option></select>
            <select v-model.number="relationTarget" aria-label="关系目标"><option :value="0">选择资源</option><option v-for="target in targets" :key="target.id" :value="target.id">{{ target.name }}</option></select>
            <button type="submit" class="button primary small" :disabled="saving || !relationTarget">保存关系</button>
            <button type="button" class="icon-button" aria-label="取消添加关系" @click="showRelationForm = false"><X :size="16" /></button>
          </form>
          <p v-if="!related.length" class="muted">暂无关联资源</p>
          <div v-for="link in related" :key="link.id" class="relation-row">
            <span class="tag gray">{{ relationLabel(link) }}</span>
            <button class="text-button" @click="openAsset(relatedId(link))">{{ byId.get(relatedId(link))?.name }}</button>
            <span v-if="link.sourceKey" class="muted relation-action">自动同步</span>
            <button v-else-if="editable" class="text-button muted relation-action" :disabled="saving" @click="updateLink(link.id)">解除</button>
          </div>
        </section>

        <section v-if="Object.keys(selected.attributes).length || Object.keys(selected.observed).length" class="detail-section">
          <div class="detail-heading"><h3><HardDrive :size="17" /> 扩展信息</h3></div>
          <dl class="attribute-list">
            <div v-for="(value, key) in selected.attributes" :key="'a-' + key"><dt>{{ key }}</dt><dd>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</dd></div>
            <div v-for="(value, key) in selected.observed" :key="'o-' + key"><dt>{{ key }} <span class="tag blue">采集</span></dt><dd>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</dd></div>
          </dl>
        </section>

        <section class="detail-section">
          <div class="detail-heading"><h3><History :size="17" /> 变更记录</h3></div>
          <ChangeList :changes="assetChanges" hide-asset />
        </section>
      </div>
    </template>
  </dialog>
  <div v-if="toast" class="toast" role="status"><ShieldCheck :size="17" /> {{ toast }}</div>
</template>
