<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CloseOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons-vue'
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

const editable = computed(() => props.editable)
const selected = computed(() => subnets.value.find(item => item.id === selectedId.value) ?? null)
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
const usageColumns = computed(() => {
  const columns = [
    { title: 'IP 地址', dataIndex: 'ip', key: 'ip', width: 135 },
    { title: '状态', key: 'status', width: 90 },
    { title: '资产 / 标签', key: 'owner' },
    { title: '备注', key: 'notes' },
  ]
  if (editable.value) columns.push({ title: '', key: 'actions', width: 70 } as typeof columns[number])
  return columns
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
  const item = selected.value
  draft.value = {
    id: item.id,
    version: item.version,
    name: item.name,
    cidr: item.cidr,
    gateway: item.gateway,
    vlan: item.vlan,
    notes: item.notes,
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
  const item = selected.value
  busy.value = true
  error.value = ''
  try {
    await api(`/subnets/${item.id}?version=${item.version}`, 'DELETE')
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

function statusColor(status: string) {
  return status === 'gateway' ? 'blue' : status === 'asset' ? 'default' : 'green'
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
  <a-card :bordered="false" class="ipam-card">
    <template #title>
      <a-space>
        <span>网段与 IP 地址</span>
        <a-tag>{{ subnets.length }} 个网段</a-tag>
      </a-space>
    </template>
    <template #extra>
      <a-space>
        <a-button :loading="loading" @click="load"><ReloadOutlined /> 刷新</a-button>
        <a-button v-if="editable" type="primary" @click="addSubnet"><PlusOutlined /> 新增网段</a-button>
      </a-space>
    </template>

    <a-alert v-if="error" type="error" :message="error" show-icon closable class="ipam-alert" @close="error = ''" />
    <a-alert v-if="feedback" type="success" :message="feedback" show-icon closable class="ipam-alert" @close="feedback = ''" />

    <a-card v-if="draft" size="small" class="edit-card">
      <template #title>{{ draft.id ? '编辑网段' : '新增网段' }}</template>
      <template #extra><a-button type="text" size="small" @click="cancelSubnet"><CloseOutlined /></a-button></template>
      <a-form layout="vertical" :model="draft" @finish="saveSubnet">
        <a-row :gutter="12">
          <a-col :span="12"><a-form-item label="网段名称" required><a-input v-model:value="draft.name" :maxlength="160" placeholder="例如：办公网" /></a-form-item></a-col>
          <a-col :span="12"><a-form-item label="CIDR" required><a-input v-model:value="draft.cidr" :maxlength="64" placeholder="例如：192.168.10.0/24" /></a-form-item></a-col>
          <a-col :span="12"><a-form-item label="网关"><a-input v-model:value="draft.gateway" :maxlength="64" placeholder="例如：192.168.10.1" /></a-form-item></a-col>
          <a-col :span="12"><a-form-item label="VLAN"><a-input v-model:value="draft.vlan" :maxlength="32" placeholder="例如：100" /></a-form-item></a-col>
          <a-col :span="24"><a-form-item label="备注"><a-textarea v-model:value="draft.notes" :rows="2" :maxlength="2000" /></a-form-item></a-col>
        </a-row>
        <a-space>
          <a-button type="primary" html-type="submit" :loading="busy">保存网段</a-button>
          <a-button @click="cancelSubnet">取消</a-button>
        </a-space>
      </a-form>
    </a-card>

    <a-empty v-if="loading && !subnets.length" description="正在加载 IPAM 数据…" />
    <a-empty v-else-if="!subnets.length" description="暂无网段，新增一个网段开始管理 IP 地址" />

    <div v-else class="ipam-layout">
      <a-list :data-source="subnets" :split="false" class="subnet-list">
        <template #renderItem="{ item }">
          <a-list-item class="subnet-item" :class="{ active: item.id === selectedId }" @click="selectSubnet(item.id)">
            <div class="subnet-content">
              <div class="subnet-head">
                <strong>{{ item.name }}</strong>
                <a-tag class="mono">{{ item.cidr }}</a-tag>
              </div>
              <span class="muted">VLAN {{ item.vlan || '—' }} · 已用 {{ count(item.used) }} / {{ count(item.usable) }} · 空闲 {{ count(item.free) }}</span>
              <a-progress :percent="percent(item)" size="small" :show-info="false" />
            </div>
          </a-list-item>
        </template>
      </a-list>

      <div class="subnet-detail">
        <template v-if="detail">
          <div class="detail-head">
            <div>
              <h2>{{ detail.name }}</h2>
              <span class="muted mono">{{ detail.cidr }} · 网关 {{ detail.gateway || '—' }} · VLAN {{ detail.vlan || '—' }}</span>
            </div>
            <a-space v-if="editable">
              <a-button size="small" @click="editSubnet">编辑</a-button>
              <a-popconfirm title="确定删除该网段？" ok-text="删除" cancel-text="取消" @confirm="deleteSubnet">
                <a-button size="small" danger :loading="busy">删除</a-button>
              </a-popconfirm>
            </a-space>
          </div>
          <p v-if="detail.notes" class="muted">{{ detail.notes }}</p>

          <a-row :gutter="12">
            <a-col :span="8"><a-card size="small"><a-statistic title="可用地址" :value="detail.usable" /></a-card></a-col>
            <a-col :span="8"><a-card size="small"><a-statistic title="已占用" :value="detail.used" /></a-card></a-col>
            <a-col :span="8"><a-card size="small"><a-statistic title="空闲" :value="detail.free" /></a-card></a-col>
          </a-row>
          <a-progress :percent="utilization" size="small" class="usage-progress" />

          <a-card v-if="editable" size="small" title="分配 IP" class="allocate-card">
            <a-form layout="vertical" :model="allocation" @finish="allocate">
              <a-row :gutter="12">
                <a-col :span="12"><a-form-item label="IP 地址"><a-input v-model:value="allocation.ip" :maxlength="64" placeholder="例如：192.168.10.20" /></a-form-item></a-col>
                <a-col :span="12">
                  <a-form-item label="关联资产">
                    <a-select v-model:value="allocation.assetId">
                      <a-select-option :value="0">不关联资产</a-select-option>
                      <a-select-option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ assetLabel(asset) }}</a-select-option>
                    </a-select>
                  </a-form-item>
                </a-col>
                <a-col :span="12"><a-form-item label="标签"><a-input v-model:value="allocation.label" :maxlength="160" placeholder="例如：VIP" /></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="备注"><a-input v-model:value="allocation.notes" :maxlength="2000" /></a-form-item></a-col>
              </a-row>
              <a-space>
                <a-button type="primary" html-type="submit" :loading="busy">分配</a-button>
                <a-button :disabled="!detail.freeIps.length" @click="fillNextFree">使用下一个空闲 IP</a-button>
              </a-space>
            </a-form>
          </a-card>

          <div class="section-head">
            <h3>已占用 IP</h3>
            <a-input v-model:value="search" allow-clear placeholder="搜索 IP、资产或标签" class="usage-search">
              <template #prefix><SearchOutlined /></template>
            </a-input>
          </div>
          <a-table :columns="usageColumns" :data-source="usage" row-key="ip" :pagination="false" size="small"
            :scroll="{ y: 300 }" :locale="{ emptyText: '没有匹配的已占用 IP' }">
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'status'"><a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag></template>
              <template v-else-if="column.key === 'owner'">
                {{ record.assetName || record.label || '—' }}
                <span v-if="record.assetName && record.label" class="muted"> / {{ record.label }}</span>
              </template>
              <template v-else-if="column.key === 'notes'">{{ record.notes || '—' }}</template>
              <template v-else-if="column.key === 'actions'">
                <a-popconfirm v-if="record.status === 'allocated'" title="释放该 IP？" ok-text="释放" cancel-text="取消" @confirm="release(record)">
                  <a-button type="link" size="small" danger>释放</a-button>
                </a-popconfirm>
              </template>
            </template>
          </a-table>

          <div class="section-head">
            <h3>空闲 IP</h3>
            <span class="muted">显示前 {{ detail.freeIps.length }} 个 / 共 {{ count(detail.free) }} 个</span>
          </div>
          <a-space wrap>
            <a-button v-for="ip in detail.freeIps" :key="ip" size="small" class="mono" :disabled="!editable" @click="chooseFree(ip)">{{ ip }}</a-button>
          </a-space>
          <a-empty v-if="!detail.freeIps.length" description="该网段已无空闲 IP" />
        </template>
        <a-empty v-else description="选择左侧网段查看地址" />
      </div>
    </div>
  </a-card>
</template>

<style scoped>
.ipam-card { min-height: 360px; }
.ipam-alert { margin-bottom: 12px; }
.ipam-layout { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 18px; }
.subnet-list { border: 1px solid #f0f0f0; border-radius: 8px; padding: 8px; max-height: 720px; overflow: auto; }
.subnet-item { cursor: pointer; padding: 10px !important; border-radius: 6px; }
.subnet-item:hover { background: #fafafa; }
.subnet-item.active { background: #e6f4ff; }
.subnet-content { display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; }
.subnet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.subnet-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subnet-detail { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.detail-head h2 { font-size: 18px; margin-bottom: 4px; }
.usage-progress { margin-top: -4px; }
.allocate-card { margin-top: 2px; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 4px; }
.section-head h3 { font-size: 15px; }
.usage-search { width: min(260px, 100%); }
@media (max-width: 900px) {
  .ipam-layout { grid-template-columns: 1fr; }
  .subnet-list { max-height: none; }
}
</style>
