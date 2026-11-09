<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import {
  ApartmentOutlined, CloudServerOutlined, DashboardOutlined, DatabaseOutlined,
  DesktopOutlined, DownloadOutlined, EditOutlined,
  GlobalOutlined, HistoryOutlined, LogoutOutlined, MenuOutlined,
  PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined, UserOutlined,
} from '@ant-design/icons-vue'
import AssetEditor from './AssetEditor.vue'
import ChangeList from './ChangeList.vue'
import { api, apiCSV, APIError } from './api'
import type { Asset, AssetFields, Change, Kind, Link, LinkKind, User } from './api'
import { assetLocations, locationLabel } from './facilities'
import type { AssetLocation, Facilities } from './facilities'

const FacilityView = defineAsyncComponent(() => import('./FacilityView.vue'))
const IpamView = defineAsyncComponent(() => import('./IpamView.vue'))

type Page = 'overview' | 'host' | 'vm' | 'ipam' | 'changes' | 'facilities'
const navigation = [
  { id: 'overview', title: '资源总览', icon: DashboardOutlined, description: '查看物理资源和虚拟化资源。' },
  { id: 'host', title: '物理机', icon: CloudServerOutlined, description: '维护物理硬件、计算节点和宿主机。' },
  { id: 'vm', title: '虚拟机', icon: DesktopOutlined, description: '查询虚拟机配置、运行状态和所在宿主机。' },
  { id: 'facilities', title: '数据中心', icon: ApartmentOutlined, description: '摆放机柜、管理设备 U 位，并在三维布局中定位资产。' },
  { id: 'ipam', title: 'IPAM', icon: GlobalOutlined, description: '管理网段、已分配和空闲 IP 地址。' },
  { id: 'changes', title: '变更记录', icon: HistoryOutlined, description: '追溯人工修改和资源关系变化。' },
] as const

const kinds = {
  host: { label: '物理机', icon: CloudServerOutlined },
  vm: { label: '虚拟机', icon: DesktopOutlined },
  switch: { label: '交换机', icon: GlobalOutlined },
}
const statuses: Record<string, { label: string; tone: string }> = {
  online: { label: '在线', tone: 'green' },
  running: { label: '运行中', tone: 'green' },
  stopped: { label: '已停止', tone: 'default' },
  paused: { label: '已暂停', tone: 'orange' },
  offline: { label: '离线', tone: 'red' },
  unknown: { label: '未知', tone: 'default' },
}
const relations: { kind: LinkKind; from: Kind; to: Kind[]; outgoing: string; incoming: string }[] = [
  { kind: 'hosts', from: 'host', to: ['vm'], outgoing: '承载虚拟机', incoming: '所在宿主机' },
]

const user = ref<User | null>(null)
const checking = ref(true)
const busy = ref(false)
const loginBusy = ref(false)
const loginForm = ref({ username: '', password: '' })
const error = ref('')
const drawerError = ref('')
const saving = ref(false)
const page = ref<Page>('overview')
const collapsed = ref(false)
const drawerOpen = ref(false)
const assets = ref<Asset[]>([])
const links = ref<Link[]>([])
const changes = ref<Change[]>([])
const facilities = ref<Facilities>({ rooms: [], racks: [], placements: [] })
const facilityFocus = ref<AssetLocation | null>(null)
const assetChanges = ref<Change[]>([])
const keyword = ref('')
const platformFilter = ref<string | undefined>(undefined)
const kindFilter = ref<string | undefined>(undefined)
const lifecycleFilter = ref('active')
const pagination = ref(1)
const pageSize = 10
const selectedId = ref<number | null>(null)
const editor = ref(false)
const newKind = ref<Kind>('host')
const showRelationForm = ref(false)
const relationChoice = ref('')
const relationTarget = ref(0)
const importing = ref(false)

const selected = computed(() => assets.value.find(a => a.id === selectedId.value) ?? null)
const activePage = computed(() => navigation.find(n => n.id === page.value)!)
const editable = computed(() => user.value?.role !== 'viewer')
const activeAssets = computed(() => assets.value.filter(a => a.lifecycle === 'active'))
const byId = computed(() => new Map(assets.value.map(a => [a.id, a])))
const locations = computed(() => assetLocations(facilities.value, links.value))
const selectedLocation = computed(() => selected.value && locations.value.get(selected.value.id))
const related = computed(() => links.value.filter(l => l.fromId === selectedId.value || l.toId === selectedId.value))
const vmRelations = computed(() => {
  const data = new Map<number, string[]>()
  for (const link of links.value) {
    if (link.kind === 'hosts') {
      const names = data.get(link.toId) ?? []
      names.push(link.fromName)
      data.set(link.toId, names)
    }
  }
  return data
})
const metrics = computed(() => [
  { label: '物理机', count: activeAssets.value.filter(a => a.kind === 'host').length, icon: CloudServerOutlined, target: 'host' as Page,
    hint: '独立主机与虚拟化节点' },
  { label: '虚拟机', count: activeAssets.value.filter(a => a.kind === 'vm').length, icon: DesktopOutlined, target: 'vm' as Page,
    hint: activeAssets.value.filter(a => a.kind === 'vm' && a.status === 'running').length + ' 台运行中' },
])
const canCreate = computed(() => editable.value && page.value !== 'changes' && page.value !== 'facilities' && page.value !== 'ipam')
const drawerTitle = computed(() => editor.value ? (selected.value ? '编辑资产' : '新增资产') : (selected.value?.name ?? '资产详情'))

const scope = computed(() => assets.value.filter(asset => {
  if (page.value === 'overview') return !kindFilter.value || asset.kind === kindFilter.value
  return asset.kind === page.value
}))
const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return scope.value.filter(a => {
    if (lifecycleFilter.value && a.lifecycle !== lifecycleFilter.value) return false
    if (platformFilter.value && a.platform !== platformFilter.value) return false
    return !query || [a.name, a.address, a.owner, a.environment, ...(vmRelations.value.get(a.id) ?? [])]
      .some(value => value?.toLowerCase().includes(query))
  })
})
const assetColumns = computed(() => [
  { title: '资源名称', key: 'name', width: 260 },
  { title: '类型', key: 'kind', width: 90 },
  { title: '状态', key: 'status', width: 100 },
  { title: page.value === 'vm' ? '宿主机' : '平台', key: 'meta', width: 130 },
  { title: '地址 / IP', key: 'address', width: 160 },
  { title: '负责人', key: 'owner', width: 120 },
  { title: '', key: 'actions', width: 72 },
])
const tablePagination = computed(() => ({
  current: pagination.value,
  pageSize,
  total: filtered.value.length,
  showSizeChanger: false,
  showTotal: (total: number) => `共 ${total} 条`,
  onChange: (next: number) => { pagination.value = next },
}))

watch([keyword, platformFilter, kindFilter, lifecycleFilter], () => { pagination.value = 1 })

const relationOptions = computed(() => {
  const a = selected.value
  if (!a) return []
  return relations.flatMap(relation => {
    const items: { id: string; label: string; direction: 'out' | 'in'; relation: typeof relation }[] = []
    if (relation.from === a.kind) items.push({ id: relation.kind + '-out', label: relation.outgoing, direction: 'out', relation })
    if (relation.to.includes(a.kind)) items.push({ id: relation.kind + '-in', label: relation.incoming, direction: 'in', relation })
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
    return relation.to.includes(a.kind)
  })
})
watch(relationChoice, () => { relationTarget.value = 0 })

function platform(asset: { platform: string }) {
  return asset.platform === 'pve' ? 'Proxmox VE' : asset.platform === 'kvm' ? 'KVM' : '—'
}
function status(asset: Asset) {
  if (asset.lifecycle === 'retired') return { label: '已退役', tone: 'default' }
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
function messageText(e: unknown) {
  return e instanceof Error ? e.message : '操作失败'
}
function report(e: unknown, inDrawer = false) {
  if (e instanceof APIError && e.status === 401 && user.value) {
    closeDrawer()
    user.value = null
  }
  if (inDrawer && user.value) drawerError.value = messageText(e)
  else error.value = messageText(e)
}
function notify(text: string) {
  void message.success(text)
}

async function refresh() {
  busy.value = true
  error.value = ''
  try {
    const [nextAssets, nextLinks, nextChanges, nextFacilities] = await Promise.all([
      api<Asset[]>('/assets'), api<Link[]>('/links'), api<Change[]>('/changes'),
      api<Facilities>('/facilities'),
    ])
    assets.value = nextAssets
    links.value = nextLinks
    changes.value = nextChanges
    facilities.value = nextFacilities
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
  if (window.innerWidth < 992) collapsed.value = true
  keyword.value = ''
  kindFilter.value = undefined
  platformFilter.value = undefined
  lifecycleFilter.value = 'active'
  pagination.value = 1
  facilityFocus.value = null
}
function onMenuClick({ key }: { key: string }) {
  goTo(key as Page)
}
function showAssetLocation(location: AssetLocation) {
  closeDrawer()
  goTo('facilities')
  facilityFocus.value = location
}
function closeDrawer() {
  if (saving.value) return
  drawerOpen.value = false
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
  drawerOpen.value = true
  try {
    const items = await api<Change[]>('/changes?assetId=' + id)
    if (selectedId.value === id) assetChanges.value = items
  } catch (e) {
    if (selectedId.value === id) report(e, true)
  }
}
function startNew() {
  selectedId.value = null
  newKind.value = page.value === 'vm' ? 'vm' : 'host'
  editor.value = true
  drawerError.value = ''
  drawerOpen.value = true
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
  for (const a of filtered.value) {
    rows.push([
      a.name, kinds[a.kind].label, platform(a), statuses[a.status]?.label ?? '未知',
      a.lifecycle === 'retired' ? '已退役' : '在册', a.address, a.cpu, a.memoryMiB, a.owner, a.environment,
      a.notes, JSON.stringify(a.attributes),
    ])
  }
  downloadCSV('easy-cmdb-assets.csv', rows)
}
function downloadTemplate() {
  downloadCSV('easy-cmdb-import-template.csv', [[
    '资源名称', '类型', '平台', '状态', '生命周期', '地址 / IP', 'CPU', '内存 MiB', '负责人', '环境', '备注', '扩展属性',
  ]])
}
function handleImportUpload(file: File) {
  void importCSV(file)
  return false
}
async function importCSV(file: File) {
  if (file.size > 16 * 1024 * 1024) {
    error.value = 'CSV 文件不能超过 16 MiB'
    return
  }
  importing.value = true
  error.value = ''
  try {
    const result = await apiCSV<{ imported: number }>('/assets/import', file)
    await refresh()
    notify(`已导入 ${result.imported} 条资产`)
  } catch (e) {
    report(e)
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <a-config-provider :theme="{ token: { colorPrimary: '#1677ff', borderRadius: 6 } }">
    <div v-if="checking" class="app-loading"><a-spin size="large" /></div>

    <div v-else-if="!user" class="login-page">
      <a-card class="login-card" :bordered="false">
        <div class="login-brand"><DatabaseOutlined /> Easy CMDB</div>
        <a-alert v-if="error" type="error" :message="error" show-icon class="login-alert" />
        <a-form layout="vertical" :model="loginForm" @finish="login">
          <a-form-item label="账号" name="username" :rules="[{ required: true, message: '请输入账号' }]">
            <a-input v-model:value="loginForm.username" autocomplete="username" size="large" />
          </a-form-item>
          <a-form-item label="密码" name="password" :rules="[{ required: true, message: '请输入密码' }]">
            <a-input-password v-model:value="loginForm.password" autocomplete="current-password" size="large" />
          </a-form-item>
          <a-button type="primary" html-type="submit" block size="large" :loading="loginBusy">登录</a-button>
        </a-form>
      </a-card>
    </div>

    <a-layout v-else class="app-layout">
      <a-layout-sider v-model:collapsed="collapsed" breakpoint="lg" :collapsed-width="0" :trigger="null" class="app-sider">
        <div class="brand" @click="goTo('overview')">
          <DatabaseOutlined class="brand-icon" />
          <span>Easy CMDB</span>
        </div>
        <a-menu mode="inline" :selected-keys="[page]" class="app-menu" @click="onMenuClick">
          <a-menu-item v-for="item in navigation" :key="item.id">
            <template #icon><component :is="item.icon" /></template>
            {{ item.title }}
          </a-menu-item>
        </a-menu>
      </a-layout-sider>

      <a-layout>
        <a-layout-header class="app-header">
          <a-space>
            <a-button type="text" @click="collapsed = !collapsed"><MenuOutlined /></a-button>
          </a-space>
          <a-space :size="4">
            <a-tooltip title="刷新"><a-button type="text" :loading="busy" @click="refresh"><ReloadOutlined /></a-button></a-tooltip>
            <a-dropdown>
              <a-button type="text"><UserOutlined /> {{ user.username }}</a-button>
              <template #overlay>
                <a-menu>
                  <a-menu-item key="logout" @click="logout"><LogoutOutlined /> 退出登录</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </a-space>
        </a-layout-header>

        <a-layout-content class="app-content">
          <div class="page-header">
            <div>
              <h1>{{ activePage.title }}</h1>
              <p class="page-desc">{{ activePage.description }}</p>
            </div>
            <a-button v-if="canCreate" type="primary" @click="startNew"><PlusOutlined /> 新增资产</a-button>
          </div>

          <a-alert v-if="error" type="error" :message="error" show-icon closable class="page-alert" @close="error = ''" />

          <a-row v-if="page === 'overview'" :gutter="[16, 16]" class="metric-row">
            <a-col v-for="metric in metrics" :key="metric.label" :xs="24" :sm="12">
              <a-card hoverable class="metric-card" @click="goTo(metric.target)">
                <component :is="metric.icon" class="metric-icon" />
                <a-statistic :title="metric.label" :value="metric.count" />
                <div class="metric-hint">{{ metric.hint }}</div>
              </a-card>
            </a-col>
          </a-row>

          <a-card v-if="page === 'changes'" :bordered="false" title="变更记录">
            <ChangeList :changes="changes" @open="openAsset" />
          </a-card>

          <FacilityView v-else-if="page === 'facilities'" :layout="facilities" :assets="assets" :links="links"
            :editable="editable" :focus="facilityFocus" :reload="refresh" @open-asset="openAsset" @session-error="report" />

          <IpamView v-else-if="page === 'ipam'" :editable="editable" @session-error="report" />

          <a-card v-else :bordered="false">
            <template #title>
              <a-space>
                <span>{{ page === 'overview' ? '资源台账' : '资源列表' }}</span>
                <a-tag>{{ filtered.length }} 条</a-tag>
              </a-space>
            </template>
            <template #extra>
              <a-space wrap>
                <a-upload :show-upload-list="false" accept=".csv,text/csv" :before-upload="handleImportUpload">
                  <a-button :loading="importing"><UploadOutlined /> 导入 CSV</a-button>
                </a-upload>
                <a-button @click="downloadTemplate"><DownloadOutlined /> 下载模板</a-button>
                <a-button :disabled="!filtered.length" @click="exportCSV"><DownloadOutlined /> 导出 CSV</a-button>
              </a-space>
            </template>

            <div class="table-toolbar">
              <a-input v-model:value="keyword" allow-clear placeholder="搜索名称、IP、宿主机…" class="table-search">
                <template #prefix><SearchOutlined /></template>
              </a-input>
              <a-space wrap>
                <a-select v-if="page === 'overview'" v-model:value="kindFilter" allow-clear placeholder="全部类型" style="width: 132px">
                  <a-select-option v-for="(type, key) in kinds" :key="key" :value="key">{{ type.label }}</a-select-option>
                </a-select>
                <a-select v-model:value="platformFilter" allow-clear placeholder="全部平台" style="width: 145px">
                  <a-select-option value="pve">Proxmox VE</a-select-option>
                  <a-select-option value="kvm">KVM</a-select-option>
                </a-select>
                <a-select v-model:value="lifecycleFilter" style="width: 135px">
                  <a-select-option value="active">在册</a-select-option>
                  <a-select-option value="retired">已退役</a-select-option>
                  <a-select-option value="">全部生命周期</a-select-option>
                </a-select>
              </a-space>
            </div>

            <a-table :columns="assetColumns" :data-source="filtered" row-key="id" :loading="busy"
              :pagination="tablePagination" :scroll="{ x: 900 }" size="middle" :locale="{ emptyText: '暂无匹配资源' }">
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'name'">
                  <a-button type="link" class="asset-link" @click="openAsset(record.id)">
                    <component :is="kinds[record.kind as Kind].icon" />
                    <span>{{ record.name }}</span>
                    <span v-if="record.environment" class="asset-sub">{{ record.environment }}</span>
                  </a-button>
                </template>
                <template v-else-if="column.key === 'kind'">{{ kinds[record.kind as Kind].label }}</template>
                <template v-else-if="column.key === 'status'">
                  <a-tag :color="status(record as Asset).tone">{{ status(record as Asset).label }}</a-tag>
                </template>
                <template v-else-if="column.key === 'meta'">{{ page === 'vm' ? hostName(record as Asset) : platform(record as Asset) }}</template>
                <template v-else-if="column.key === 'address'"><span class="mono">{{ record.address || '—' }}</span></template>
                <template v-else-if="column.key === 'owner'">{{ record.owner || '—' }}</template>
                <template v-else-if="column.key === 'actions'">
                  <a-button type="link" size="small" @click="openAsset(record.id)">查看</a-button>
                </template>
              </template>
            </a-table>
          </a-card>
        </a-layout-content>
      </a-layout>
    </a-layout>

    <a-drawer v-model:open="drawerOpen" :width="560" :title="drawerTitle" destroy-on-close @close="closeDrawer">
      <AssetEditor v-if="editor" :asset="selected" :default-kind="newKind" :busy="saving" :error="drawerError"
        @save="saveAsset" @cancel="selectedId ? openAsset(selectedId) : closeDrawer()" />
      <template v-else-if="selected">
        <a-space class="detail-tags">
          <a-tag :color="status(selected).tone">{{ status(selected).label }}</a-tag>
          <a-tag>{{ kinds[selected.kind].label }}</a-tag>
        </a-space>
        <a-alert v-if="drawerError" type="error" :message="drawerError" show-icon class="drawer-alert" />
        <a-button v-if="editable" type="primary" class="drawer-edit" @click="drawerError = ''; editor = true">
          <EditOutlined /> 编辑
        </a-button>

        <a-descriptions :column="1" bordered size="small" class="detail-descriptions">
          <a-descriptions-item label="平台">{{ platform(selected) }}</a-descriptions-item>
          <a-descriptions-item label="负责人">{{ selected.owner || '—' }}</a-descriptions-item>
          <a-descriptions-item label="环境">{{ selected.environment || '—' }}</a-descriptions-item>
          <a-descriptions-item label="管理地址 / IP"><span class="mono">{{ selected.address || '—' }}</span></a-descriptions-item>
          <a-descriptions-item v-if="selected.kind === 'host' || selected.kind === 'vm'" label="CPU / 内存">
            {{ selected.cpu || '—' }} 核 · {{ selected.memoryMiB ? selected.memoryMiB / 1024 + ' GiB' : '—' }}
          </a-descriptions-item>
          <a-descriptions-item v-if="selectedLocation" label="数据中心位置">
            <a-button type="link" class="inline-link" @click="showAssetLocation(selectedLocation)">
              {{ locationLabel(selectedLocation) }}
            </a-button>
            <div v-if="selectedLocation.placement.assetId !== selected.id" class="muted">
              随 {{ byId.get(selectedLocation.placement.assetId)?.name }} 定位
            </div>
          </a-descriptions-item>
        </a-descriptions>

        <p v-if="selected.notes" class="detail-notes">{{ selected.notes }}</p>

        <a-divider orientation="left">资源关系</a-divider>
        <a-button v-if="editable && relationOptions.length" size="small" @click="startRelation"><PlusOutlined /> 添加</a-button>
        <a-form v-if="showRelationForm" layout="inline" class="relation-form" @submit.prevent="updateLink()">
          <a-form-item>
            <a-select v-model:value="relationChoice" style="width: 150px" placeholder="关系类型">
              <a-select-option v-for="option in relationOptions" :key="option.id" :value="option.id">{{ option.label }}</a-select-option>
            </a-select>
          </a-form-item>
          <a-form-item>
            <a-select v-model:value="relationTarget" style="width: 170px" placeholder="选择资源">
              <a-select-option v-for="target in targets" :key="target.id" :value="target.id">{{ target.name }}</a-select-option>
            </a-select>
          </a-form-item>
          <a-space>
            <a-button type="primary" html-type="submit" size="small" :disabled="saving || !relationTarget">保存</a-button>
            <a-button size="small" @click="showRelationForm = false">取消</a-button>
          </a-space>
        </a-form>
        <a-empty v-if="!related.length" description="暂无关联资源" />
        <a-list v-else :data-source="related" size="small">
          <template #renderItem="{ item }">
            <a-list-item>
              <a-space>
                <a-tag>{{ relationLabel(item) }}</a-tag>
                <a-button type="link" @click="openAsset(relatedId(item))">{{ byId.get(relatedId(item))?.name }}</a-button>
              </a-space>
              <a-button v-if="editable" type="link" danger @click="updateLink(item.id)">解除</a-button>
            </a-list-item>
          </template>
        </a-list>

        <template v-if="Object.keys(selected.attributes).length">
          <a-divider orientation="left">扩展信息</a-divider>
          <a-descriptions :column="1" size="small" bordered>
            <a-descriptions-item v-for="(value, key) in selected.attributes" :key="key" :label="String(key)">
              {{ typeof value === 'object' ? JSON.stringify(value) : value }}
            </a-descriptions-item>
          </a-descriptions>
        </template>

        <a-divider orientation="left">变更记录</a-divider>
        <ChangeList :changes="assetChanges" hide-asset />
      </template>
    </a-drawer>
  </a-config-provider>
</template>
