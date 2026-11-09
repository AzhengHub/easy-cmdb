<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Network, Plus, RefreshCw, Search, X } from '@lucide/vue'
import { api, APIError } from './api'
import type { Asset, IPUsage, Subnet, SubnetDetail, SubnetFields } from './api'

const props = defineProps<{ editable: boolean }>()
const emit = defineEmits<{ 'session-error': [error: unknown] }>()

type SubnetDraft = SubnetFields & { id?: number; version?: number }

const subnets = ref<Subnet[]>([])
const assets = ref<Asset[]>([])
const selectedId = ref<number | null>(null)
const detail = ref<SubnetDetail | null>(null)
const draft = ref<SubnetDraft | null>(null)
const allocation = ref({ ip: '', assetId: 0, label: '', notes: '' })
const search = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const feedback = ref('')

const selected = computed(() => subnets.value.find(item => item.id === selectedId.value) ?? null)
const editable = computed(() => props.editable)
const usage = computed(() => {
  const query = search.value.trim().toLowerCase()
  const rows = detail.value?.usedIps ?? []
  if (!query) return rows
  return rows.filter(row => [row.ip, row.assetName, row.label, row.notes, statusLabel(row.status)]
    .some(value => value?.toLowerCase().includes(query)))
})
const utilization = computed(() => {
  if (!detail.value || detail.value.usable <= 0) return 0
  return Math.min(100, Math.round(detail.value.used / detail.value.usable * 100))
})

onMounted(() => { void load() })

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [nextSubnets, nextAssets] = await Promise.all([
      api<Subnet[]>('/subnets'),
      api<Asset[]>('/assets'),
    ])
    subnets.value = nextSubnets
    assets.value = nextAssets
    if (!selectedId.value || !subnets.value.some(item => item.id === selectedId.value)) {
      selectedId.value = subnets.value[0]?.id ?? null
    }
    await loadDetail()
  } catch (e) {
    report(e)
  } finally {
    loading.value = false
  }
}

async function loadDetail() {
  if (!selectedId.value) {
    detail.value = null
    return
  }
  detail.value = await api<SubnetDetail>(`/subnets/${selectedId.value}/addresses`)
}

async function selectSubnet(id: number) {
  if (selectedId.value === id) return
  selectedId.value = id
  draft.value = null
  error.value = ''
  feedback.value = ''
  try {
    await loadDetail()
  } catch (e) {
    report(e)
  }
}

function addSubnet() {
  draft.value = { name: '', cidr: '', gateway: '', vlan: '', notes: '' }
  feedback.value = ''
}

function editSubnet() {
  if (!selected.value) return
  const subnet = selected.value
  draft.value = {
    id: subnet.id,
    version: subnet.version,
    name: subnet.name,
    cidr: subnet.cidr,
    gateway: subnet.gateway,
    vlan: subnet.vlan,
    notes: subnet.notes,
  }
}

function cancelSubnet() {
  draft.value = null
}

async function saveSubnet() {
  if (!draft.value) return
  const current = draft.value
  busy.value = true
  error.value = ''
  try {
    const body = {
      name: current.name,
      cidr: current.cidr,
      gateway: current.gateway,
      vlan: current.vlan,
      notes: current.notes,
      version: current.version ?? 0,
    }
    const saved = current.id
      ? await api<Subnet>(`/subnets/${current.id}`, 'PUT', body)
      : await api<Subnet>('/subnets', 'POST', body)
    selectedId.value = saved.id
    draft.value = null
    await load()
    feedback.value = current.id ? '网段已更新' : '网段已创建'
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}

async function deleteSubnet() {
  if (!selected.value) return
  const subnet = selected.value
  if (!window.confirm(`删除网段「${subnet.name}（${subnet.cidr}）」？`)) return
  busy.value = true
  error.value = ''
  try {
    await api(`/subnets/${subnet.id}?version=${subnet.version}`, 'DELETE')
    selectedId.value = null
    feedback.value = '网段已删除'
    await load()
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}

async function allocate() {
  if (!detail.value) return
  if (!allocation.value.ip.trim()) {
    error.value = '请填写要分配的 IP 地址'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await api(`/subnets/${detail.value.id}/allocations`, 'POST', {
      ip: allocation.value.ip.trim(),
      assetId: allocation.value.assetId || 0,
      label: allocation.value.label.trim(),
      notes: allocation.value.notes.trim(),
    })
    allocation.value = { ip: '', assetId: 0, label: '', notes: '' }
    await load()
    feedback.value = 'IP 已分配'
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}

async function release(row: IPUsage) {
  if (!row.allocationId || !row.version) return
  if (!window.confirm(`释放 IP「${row.ip}」？`)) return
  busy.value = true
  error.value = ''
  try {
    await api(`/allocations/${row.allocationId}?version=${row.version}`, 'DELETE')
    await load()
    feedback.value = 'IP 已释放'
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}

function fillNextFree() {
  const ip = detail.value?.freeIps[0]
  if (ip) allocation.value.ip = ip
}

function chooseFree(ip: string) {
  if (!editable.value) return
  allocation.value.ip = ip
}

function report(e: unknown) {
  if (e instanceof APIError && e.status === 401) {
    emit('session-error', e)
    return
  }
  error.value = e instanceof Error ? e.message : '操作失败'
}

function statusLabel(status: string) {
  return status === 'gateway' ? '网关' : status === 'asset' ? '资产地址' : '已分配'
}

function statusTone(status: string) {
  return status === 'gateway' ? 'blue' : status === 'asset' ? 'gray' : 'green'
}

function percent(subnet: Subnet) {
  return subnet.usable > 0 ? Math.min(100, Math.round(subnet.used / subnet.usable * 100)) : 0
}

function count(value: number) {
  return value.toLocaleString('zh-CN')
}

function assetLabel(asset: Asset) {
  return `${asset.name}（${asset.kind === 'vm' ? '虚拟机' : asset.kind === 'switch' ? '交换机' : '物理机'}）`
}
</script>

<template>
  <section class="panel ipam-panel">
    <div class="panel-heading">
      <div><h2>网段与 IP 地址</h2><p class="muted">自动统计资产地址，支持手工分配和释放 IP</p></div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="load"><RefreshCw :size="16" /> 刷新</button>
        <button v-if="editable" class="button primary" @click="addSubnet"><Plus :size="16" /> 新增网段</button>
      </div>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="feedback" class="feedback" role="status">{{ feedback }}</p>

    <div v-if="loading && !subnets.length" class="empty-state">正在加载 IPAM 数据…</div>
    <div v-else-if="!subnets.length" class="empty-state">
      <Network :size="28" />
      <h3>暂无网段</h3>
      <p>{{ editable ? '新增一个网段后，就可以查看空闲和已使用 IP。' : '网段录入后会显示在这里。' }}</p>
    </div>

    <div v-else class="ipam-layout">
      <aside class="subnet-list" aria-label="网段列表">
        <button v-for="subnet in subnets" :key="subnet.id" type="button" class="subnet-item"
          :class="{ active: subnet.id === selectedId }" @click="selectSubnet(subnet.id)">
          <span class="subnet-name">{{ subnet.name }}</span>
          <span class="subnet-cidr mono">{{ subnet.cidr }}</span>
          <span class="subnet-meta">VLAN {{ subnet.vlan || '—' }} · 已用 {{ count(subnet.used) }} / {{ count(subnet.usable) }}</span>
          <span class="subnet-free">空闲 {{ count(subnet.free) }}</span>
          <span class="bar"><i :style="{ width: percent(subnet) + '%' }"></i></span>
        </button>
      </aside>

      <div class="subnet-detail">
        <form v-if="draft" class="ipam-form" @submit.prevent="saveSubnet">
          <div class="form-heading">
            <h3>{{ draft.id ? '编辑网段' : '新增网段' }}</h3>
            <button type="button" class="icon-button" aria-label="关闭网段表单" @click="cancelSubnet"><X :size="17" /></button>
          </div>
          <div class="form-grid">
            <label>网段名称<input v-model.trim="draft.name" required maxlength="160" placeholder="例如：办公网" /></label>
            <label>CIDR<input v-model.trim="draft.cidr" required maxlength="64" placeholder="例如：192.168.10.0/24" /></label>
            <label>网关<input v-model.trim="draft.gateway" maxlength="64" placeholder="例如：192.168.10.1" /></label>
            <label>VLAN<input v-model.trim="draft.vlan" maxlength="32" placeholder="例如：100" /></label>
            <label class="wide">备注<textarea v-model.trim="draft.notes" rows="2" maxlength="2000" placeholder="可选" /></label>
          </div>
          <div class="form-actions">
            <button class="button primary" :disabled="busy">保存网段</button>
            <button type="button" class="button" @click="cancelSubnet">取消</button>
          </div>
        </form>

        <template v-if="detail">
          <div class="detail-heading">
            <div>
              <h3>{{ detail.name }}</h3>
              <p class="muted mono">{{ detail.cidr }} · 网关 {{ detail.gateway || '—' }} · VLAN {{ detail.vlan || '—' }}</p>
            </div>
            <div v-if="editable" class="heading-actions">
              <button class="button small" @click="editSubnet">编辑</button>
              <button class="button small" :disabled="busy" @click="deleteSubnet">删除</button>
            </div>
          </div>
          <p v-if="detail.notes" class="muted">{{ detail.notes }}</p>

          <div class="ipam-stats">
            <div class="ipam-stat"><span>可用地址</span><strong>{{ count(detail.usable) }}</strong></div>
            <div class="ipam-stat"><span>已占用</span><strong>{{ count(detail.used) }}</strong></div>
            <div class="ipam-stat"><span>空闲</span><strong>{{ count(detail.free) }}</strong></div>
            <span class="ipam-progress"><i :style="{ width: utilization + '%' }"></i></span>
            <span class="ipam-percent">{{ utilization }}% 使用率</span>
          </div>

          <form v-if="editable" class="allocation-form" @submit.prevent="allocate">
            <div class="form-heading"><h3>分配 IP</h3></div>
            <div class="form-grid">
              <label>IP 地址<input v-model.trim="allocation.ip" maxlength="64" placeholder="例如：192.168.10.20" /></label>
              <label>关联资产
                <select v-model.number="allocation.assetId">
                  <option :value="0">不关联资产</option>
                  <option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ assetLabel(asset) }}</option>
                </select>
              </label>
              <label>标签<input v-model.trim="allocation.label" maxlength="160" placeholder="例如：VIP / 网关备用" /></label>
              <label>备注<input v-model.trim="allocation.notes" maxlength="2000" placeholder="可选" /></label>
            </div>
            <div class="form-actions">
              <button class="button primary" :disabled="busy">分配</button>
              <button type="button" class="button" :disabled="!detail.freeIps.length" @click="fillNextFree">使用下一个空闲 IP</button>
            </div>
          </form>

          <div class="usage-heading">
            <h3>已占用 IP <span class="muted">{{ count(detail.used) }}</span></h3>
            <label class="search"><Search :size="16" /><input v-model="search" aria-label="搜索 IP" placeholder="搜索 IP、资产或标签" /></label>
          </div>
          <div class="table-scroll ipam-table">
            <table>
              <thead><tr><th>IP</th><th>状态</th><th>资产 / 标签</th><th>备注</th><th v-if="editable"></th></tr></thead>
              <tbody>
                <tr v-for="row in usage" :key="row.ip">
                  <td class="mono">{{ row.ip }}</td>
                  <td><span class="tag" :class="statusTone(row.status)">{{ statusLabel(row.status) }}</span></td>
                  <td>
                    {{ row.assetName || row.label || '—' }}
                    <small v-if="row.assetName && row.label" class="muted"> / {{ row.label }}</small>
                  </td>
                  <td>{{ row.notes || '—' }}</td>
                  <td v-if="editable">
                    <button v-if="row.status === 'allocated'" class="text-button" :disabled="busy" @click="release(row)">释放</button>
                  </td>
                </tr>
                <tr v-if="!usage.length"><td :colspan="editable ? 5 : 4" class="muted">没有匹配的已占用 IP</td></tr>
              </tbody>
            </table>
          </div>

          <div class="free-section">
            <h3>空闲 IP <span class="muted">显示前 {{ detail.freeIps.length }} 个 / 共 {{ count(detail.free) }}</span></h3>
            <div class="ip-chips">
              <button v-for="ip in detail.freeIps" :key="ip" type="button" class="ip-chip" :disabled="!editable"
                @click="chooseFree(ip)">{{ ip }}</button>
            </div>
            <p v-if="!detail.freeIps.length" class="muted">该网段已无空闲 IP</p>
          </div>
        </template>

        <div v-else class="empty-state compact">选择左侧网段查看地址</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ipam-panel { overflow: hidden; }
.feedback { color: #1d6156; background: #edf9f4; border: 1px solid #c6e8da; border-radius: 8px; margin: 0 19px 12px; padding: 8px 10px; font-size: 12px; }
.ipam-layout { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 15px; padding: 0 19px 19px; }
.subnet-list { display: flex; flex-direction: column; gap: 7px; max-height: 720px; overflow: auto; }
.subnet-item { display: flex; flex-direction: column; gap: 4px; width: 100%; border: 1px solid #e3eaf3; border-radius: 9px; background: #fff; padding: 10px 11px; text-align: left; color: #243752; }
.subnet-item:hover { border-color: #adc9f1; background: #f8fbff; }
.subnet-item.active { border-color: #7fa9ea; background: #f3f8ff; box-shadow: inset 3px 0 0 var(--primary); }
.subnet-name { font-size: 13px; font-weight: 650; }
.subnet-cidr { font-size: 12px; color: #415a79; }
.subnet-meta, .subnet-free { font-size: 11px; color: #6b7f9d; }
.subnet-free { color: #1d6156; }
.bar { height: 4px; border-radius: 4px; background: #eaf0f7; overflow: hidden; margin-top: 2px; }
.bar i { display: block; height: 100%; background: #4c91ff; border-radius: inherit; }
.subnet-detail { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.ipam-form, .allocation-form { border: 1px solid #e3eaf3; border-radius: 9px; background: #fbfcff; padding: 13px; }
.form-heading, .detail-heading, .usage-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.form-heading h3, .detail-heading h3, .usage-heading h3, .free-section h3 { font-size: 14px; color: #243752; }
.detail-heading { align-items: flex-start; }
.detail-heading p { margin-top: 4px; font-size: 12px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 11px; margin-top: 10px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; color: #536780; font-size: 11px; }
.form-grid .wide { grid-column: 1 / -1; }
.form-actions { display: flex; gap: 8px; margin-top: 11px; }
.ipam-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; align-items: center; }
.ipam-stat { border: 1px solid #e3eaf3; border-radius: 8px; padding: 9px 11px; display: flex; flex-direction: column; gap: 3px; background: #fff; }
.ipam-stat span { color: #6b7f9d; font-size: 11px; }
.ipam-stat strong { color: #1e3555; font-size: 19px; letter-spacing: -.03em; }
.ipam-progress { grid-column: 1 / -1; height: 5px; background: #eaf0f7; border-radius: 4px; overflow: hidden; }
.ipam-progress i { display: block; height: 100%; background: #4c91ff; border-radius: inherit; }
.ipam-percent { grid-column: 1 / -1; color: #6b7f9d; font-size: 11px; margin-top: -4px; }
.usage-heading { margin-top: 2px; }
.usage-heading .search { width: min(250px, 100%); }
.ipam-table { border: 1px solid #e3eaf3; border-radius: 8px; max-height: 320px; }
.ipam-table table { min-width: 620px; }
.ipam-table td, .ipam-table th { white-space: nowrap; }
.ipam-table td:nth-child(3), .ipam-table td:nth-child(4) { white-space: normal; min-width: 130px; }
.free-section { display: flex; flex-direction: column; gap: 8px; }
.ip-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ip-chip { border: 1px solid #cfe0f5; border-radius: 6px; background: #f5f9ff; color: #23548f; padding: 4px 7px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
.ip-chip:not(:disabled):hover { background: #e8f2ff; border-color: #9fc1ee; }
@media (max-width: 900px) {
  .ipam-layout { grid-template-columns: 1fr; }
  .subnet-list { max-height: none; }
}
@media (max-width: 560px) {
  .form-grid, .ipam-stats { grid-template-columns: 1fr; }
  .ipam-layout { padding-inline: 10px; }
  .feedback { margin-inline: 10px; }
}
</style>
