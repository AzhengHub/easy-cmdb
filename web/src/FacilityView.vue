<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import {
  AppstoreOutlined, CloudServerOutlined, PlusOutlined, SearchOutlined, TableOutlined,
} from '@ant-design/icons-vue'
import { api, APIError } from './api'
import type { Asset, Link } from './api'
import { assetLocations, isMountKind, locationLabel, mountKinds, uRange } from './facilities'
import type { AssetLocation, Facilities, MountKind, Placement, Rack, RackFields, Room, RoomFields } from './facilities'

const RoomScene = defineAsyncComponent({
  loader: () => import('./RoomScene.vue'),
  delay: 0,
})

const props = defineProps<{
  layout: Facilities
  assets: Asset[]
  links: Link[]
  editable: boolean
  focus: AssetLocation | null
  reload: () => Promise<void>
}>()

const emit = defineEmits<{
  openAsset: [id: number]
  sessionError: [error: unknown]
}>()

type RoomDraft = RoomFields & { id?: number; version: number }
type RackDraft = RackFields & { id?: number; version: number }
interface MountDraft {
  mode: 'existing' | 'new'
  assetId: number
  version: number
  kind: MountKind
  name: string
  address: string
  startU: number
  units: number
}

const roomId = ref<number | null>(null)
const rackId = ref<number | null>(null)
const focused = ref<number | null>(null)
const view = ref<'floor' | '3d'>('floor')
const roomDraft = ref<RoomDraft | null>(null)
const rackDraft = ref<RackDraft | null>(null)
const mountDraft = ref<MountDraft | null>(null)
const busy = ref(false)
const error = ref('')
const feedback = ref('')
const search = ref('')
const dragRack = ref<number | null>(null)
const elevation = ref<HTMLDivElement>()

const rooms = computed(() => props.layout.rooms)
const room = computed(() => rooms.value.find(item => item.id === roomId.value))
const racks = computed(() => props.layout.racks.filter(item => item.roomId === roomId.value))
const rack = computed(() => racks.value.find(item => item.id === rackId.value))
const rackIds = computed(() => new Set(racks.value.map(item => item.id)))
const roomPlacements = computed(() => props.layout.placements.filter(item => rackIds.value.has(item.rackId)))
const devices = computed(() => roomPlacements.value.filter(item => item.rackId === rackId.value))
const usedU = computed(() => devices.value.reduce((used, item) => used + item.units, 0))
const byId = computed(() => new Map(props.assets.map(asset => [asset.id, asset])))
const locations = computed(() => assetLocations(props.layout, props.links))
const mounted = computed(() => new Map(props.layout.placements.map(placement => [placement.assetId, placement])))
const candidates = computed(() => props.assets.filter(asset =>
  asset.lifecycle === 'active' && isMountKind(asset.kind)))
const searchResults = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  if (!keyword) return []
  return props.assets.flatMap(asset => {
    const location = locations.value.get(asset.id)
    return location && [asset.name, asset.address, location.room.name, location.rack.name]
      .some(value => value.toLowerCase().includes(keyword)) ? [{ asset, location }] : []
  }).slice(0, 8)
})
const cells = computed(() => {
  const layout = room.value
  if (!layout) return []
  const byCell = new Map(racks.value.map(item => [item.row + ':' + item.column, item]))
  return Array.from({ length: layout.columns * layout.rows }, (_, index) => {
    const column = index % layout.columns + 1
    const row = Math.floor(index / layout.columns) + 1
    const key = row + ':' + column
    return { key, row, column, rack: byCell.get(key) }
  })
})
const rackUnits = computed(() => Array.from({ length: rack.value?.heightU ?? 0 }, (_, index) => rack.value!.heightU - index))
const mountLocation = computed(() => mountDraft.value?.assetId ? locations.value.get(mountDraft.value.assetId) : undefined)

watch(() => props.layout, () => {
  if (!room.value) roomId.value = rooms.value[0]?.id ?? null
  if (!rack.value) rackId.value = racks.value[0]?.id ?? null
}, { immediate: true })
watch(() => props.focus, location => {
  if (location) showLocation(location)
}, { immediate: true })
watch([focused, rackId], async () => {
  if (!focused.value) return
  await nextTick()
  const device = elevation.value?.querySelector<HTMLElement>('[data-asset-id="' + focused.value + '"]')
  if (!device || !elevation.value) return
  const viewport = elevation.value.getBoundingClientRect()
  const bounds = device.getBoundingClientRect()
  if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) {
    elevation.value.scrollTop += bounds.top - viewport.top - viewport.height / 3
  }
})

function resetForms() {
  roomDraft.value = null
  rackDraft.value = null
  mountDraft.value = null
  error.value = ''
  feedback.value = ''
}

function selectRoom(id: number) {
  if (roomId.value === id) return
  resetForms()
  roomId.value = id
  rackId.value = racks.value[0]?.id ?? null
  focused.value = null
}

function selectRack(id: number) {
  if (rackId.value === id) return
  resetForms()
  rackId.value = id
  focused.value = null
}

function showLocation(location: AssetLocation) {
  resetForms()
  roomId.value = location.room.id
  rackId.value = location.rack.id
  focused.value = location.placement.assetId
  view.value = '3d'
  search.value = ''
}

function openSceneDevice(assetId: number, cabinetId: number) {
  selectRack(cabinetId)
  focused.value = assetId
  emit('openAsset', assetId)
}

async function mutate<T>(action: () => Promise<T>, done: (result: T) => void, notice: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  feedback.value = ''
  try {
    const result = await action()
    await props.reload()
    done(result)
    feedback.value = notice
  } catch (e) {
    if (e instanceof APIError && e.status === 401) emit('sessionError', e)
    else error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}

function editRoom(value?: Room) {
  resetForms()
  roomDraft.value = value ? { ...value } : { name: '', columns: 8, rows: 6, version: 0 }
}

function saveRoom() {
  const draft = roomDraft.value
  if (!draft) return
  const { id, ...fields } = draft
  void mutate(() => api<Room>(id ? '/rooms/' + id : '/rooms', id ? 'PUT' : 'POST', fields), saved => {
    selectRoom(saved.id)
    roomDraft.value = null
  }, '数据中心已保存')
}

function removeRoom(value: Room) {
  void mutate(() => api('/rooms/' + value.id + '?version=' + value.version, 'DELETE'), resetForms, '数据中心已删除')
}

function editRack(value?: Rack) {
  resetForms()
  const free = cells.value.find(cell => !cell.rack)
  if (value) rackDraft.value = { ...value }
  else if (free) rackDraft.value = { name: '', heightU: 42, column: free.column, row: free.row, rotation: 0, version: 0 }
  else error.value = '数据中心网格已占满，请先扩大布局'
}

function saveRack() {
  const draft = rackDraft.value
  if (!draft || !room.value) return
  const { id, name, heightU, column, row, rotation, version } = draft
  const path = id ? '/racks/' + id : '/rooms/' + room.value.id + '/racks'
  void mutate(() => api<Rack>(path, id ? 'PUT' : 'POST', { name, heightU, column, row, rotation, version }), saved => {
    rackId.value = saved.id
    rackDraft.value = null
  }, '机柜已保存')
}

function removeRack(value: Rack) {
  void mutate(() => api('/racks/' + value.id + '?version=' + value.version, 'DELETE'), resetForms, '机柜已删除')
}

function startDrag(event: DragEvent, value: Rack) {
  if (!props.editable || busy.value || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  dragRack.value = value.id
  event.dataTransfer.setData('text/plain', String(value.id))
  event.dataTransfer.effectAllowed = 'move'
}

function allowDrop(event: DragEvent, occupied: boolean) {
  if (!dragRack.value || occupied || !props.editable || busy.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function moveRack(event: DragEvent, column: number, row: number, occupied: boolean) {
  const item = racks.value.find(value => value.id === dragRack.value)
  dragRack.value = null
  if (!props.editable || busy.value || occupied || !item || event.dataTransfer?.getData('text/plain') !== String(item.id)) return
  event.preventDefault()
  const { name, heightU, rotation, version } = item
  void mutate(() => api<Rack>('/racks/' + item.id, 'PUT', { name, heightU, column, row, rotation, version }), saved => {
    rackId.value = saved.id
    rackDraft.value = null
  }, '机柜位置已更新')
}

function freePosition(units: number, ignore = 0) {
  if (!rack.value) return 1
  for (let start = 1; start + units - 1 <= rack.value.heightU; start++) {
    if (!devices.value.some(item => item.assetId !== ignore && start < item.startU + item.units && start + units > item.startU)) return start
  }
  return 1
}

function editMount(value?: Placement) {
  resetForms()
  const asset = value && byId.value.get(value.assetId)
  const canMove = asset && candidates.value.some(item => item.id === asset.id)
  if (value && !canMove) return
  mountDraft.value = {
    mode: value || candidates.value.length ? 'existing' : 'new',
    assetId: value?.assetId ?? 0,
    version: value?.version ?? 0,
    kind: 'host',
    name: '',
    address: '',
    startU: value?.startU ?? freePosition(1),
    units: value?.units ?? 1,
  }
}

function changeDevice() {
  const draft = mountDraft.value
  if (!draft) return
  const previous = mounted.value.get(draft.assetId)
  draft.version = previous?.version ?? 0
  draft.units = previous?.units ?? 1
  draft.startU = previous?.rackId === rackId.value ? previous.startU : freePosition(draft.units, draft.assetId)
}

function changeMountMode() {
  const draft = mountDraft.value
  if (!draft) return
  if (draft.mode === 'existing') changeDevice()
  else {
    draft.units = draft.kind === 'switch' ? 1 : 2
    draft.startU = freePosition(draft.units)
  }
}

function saveMount() {
  const draft = mountDraft.value
  if (!draft || !rack.value) return
  const { startU, units, mode, assetId, version, kind, name, address } = draft
  const fields = { rackId: rack.value.id, startU, units }
  const create = mode === 'new'
  if (!create && !assetId) return
  void mutate(() => create
    ? api<Placement>('/placements', 'POST', { ...fields, newAsset: { kind, name, address } })
    : api<Placement>('/assets/' + assetId + '/placement', 'PUT', { ...fields, version }), placed => {
    mountDraft.value = null
    focused.value = placed.assetId
  }, create || !version ? '设备已上架' : '设备位置已更新')
}

function unmountDevice(value: Placement) {
  void mutate(() => api('/assets/' + value.assetId + '/placement?version=' + value.version, 'DELETE'), () => {
    mountDraft.value = null
    if (focused.value === value.assetId) focused.value = null
  }, '设备已下架')
}

function nameOf(assetId: number) {
  return byId.value.get(assetId)?.name ?? '资产 #' + assetId
}

function deviceRow(item: Placement) {
  const height = rack.value?.heightU ?? 1
  return (height - item.startU - item.units + 2) + ' / span ' + item.units
}

function changeRoom(value: unknown) {
  if (value !== undefined && value !== null) selectRoom(Number(value))
}

function changeRack(value: unknown) {
  if (value !== undefined && value !== null) selectRack(Number(value))
}
</script>

<template>
  <div class="facilities">
    <a-card :bordered="false" size="small" class="facility-controls">
      <div class="facility-bar">
        <a-space wrap :size="8">
          <span class="muted">数据中心</span>
          <a-select :value="roomId ?? undefined" style="width: 200px" :disabled="!rooms.length || busy"
            placeholder="暂无数据中心" @change="changeRoom">
            <a-select-option v-for="item in rooms" :key="item.id" :value="item.id">{{ item.name }}</a-select-option>
          </a-select>
          <a-input v-if="rooms.length" v-model:value="search" allow-clear placeholder="搜索已上架资产、数据中心或机柜…" style="width: 280px">
            <template #prefix><SearchOutlined /></template>
          </a-input>
        </a-space>
        <a-space v-if="editable" wrap>
          <a-button type="primary" :disabled="busy" @click="editRoom()"><PlusOutlined /> 新增数据中心</a-button>
          <a-button v-if="room" :disabled="busy" @click="editRoom(room)">编辑数据中心</a-button>
        </a-space>
      </div>

      <a-list v-if="search.trim()" :data-source="searchResults" size="small" class="location-results">
        <template #renderItem="{ item }">
          <a-list-item>
            <a-button type="link" class="location-result" @click="showLocation(item.location)">
              <strong>{{ item.asset.name }}</strong><span class="muted">{{ locationLabel(item.location) }}</span>
            </a-button>
          </a-list-item>
        </template>
      </a-list>
      <a-empty v-if="search.trim() && !searchResults.length" description="暂无匹配的上架位置" class="compact-empty" />

      <a-form v-if="roomDraft" layout="inline" class="facility-form" @finish="saveRoom">
        <a-form-item label="数据中心名称"><a-input v-model:value="roomDraft.name" placeholder="例如：北京数据中心" :maxlength="160" /></a-form-item>
        <a-form-item label="列数"><a-input-number v-model:value="roomDraft.columns" :min="1" :max="24" /></a-form-item>
        <a-form-item label="行数"><a-input-number v-model:value="roomDraft.rows" :min="1" :max="24" /></a-form-item>
        <a-form-item>
          <a-space>
            <a-button type="primary" html-type="submit" :loading="busy">保存数据中心</a-button>
            <a-button @click="roomDraft = null">取消</a-button>
            <a-popconfirm v-if="roomDraft.id && room?.id === roomDraft.id && !racks.length" title="删除该空数据中心？"
              ok-text="删除" cancel-text="取消" @confirm="removeRoom(room)">
              <a-button danger :disabled="busy">删除空数据中心</a-button>
            </a-popconfirm>
          </a-space>
        </a-form-item>
      </a-form>
    </a-card>

    <a-alert v-if="error" type="error" :message="error" show-icon />
    <a-alert v-if="feedback" type="success" :message="feedback" show-icon />

    <a-card v-if="!room" :bordered="false">
      <a-empty description="暂无数据中心">
        <a-button v-if="editable" type="primary" @click="editRoom()">新增数据中心</a-button>
      </a-empty>
    </a-card>

    <div v-else class="facility-workspace">
      <a-card :bordered="false" class="floor-panel">
        <template #title>
          <a-space wrap>
            <span>{{ room.name }}</span>
            <span class="muted">{{ room.columns }} 列 × {{ room.rows }} 行 · {{ racks.length }} 台机柜</span>
          </a-space>
        </template>
        <template #extra>
          <a-button v-if="editable" size="small" :disabled="busy" @click="editRack()"><PlusOutlined /> 新增机柜</a-button>
        </template>

        <a-form v-if="rackDraft" layout="inline" class="facility-form rack-form" @finish="saveRack">
          <a-form-item label="机柜编号"><a-input v-model:value="rackDraft.name" placeholder="例如：A-01" :maxlength="80" /></a-form-item>
          <a-form-item label="高度（U）"><a-input-number v-model:value="rackDraft.heightU" :min="1" :max="80" /></a-form-item>
          <a-form-item label="列"><a-input-number v-model:value="rackDraft.column" :min="1" :max="room.columns" /></a-form-item>
          <a-form-item label="行"><a-input-number v-model:value="rackDraft.row" :min="1" :max="room.rows" /></a-form-item>
          <a-form-item label="朝向">
            <a-select v-model:value="rackDraft.rotation" style="width: 100px">
              <a-select-option :value="0">向下</a-select-option>
              <a-select-option :value="90">向左</a-select-option>
              <a-select-option :value="180">向上</a-select-option>
              <a-select-option :value="270">向右</a-select-option>
            </a-select>
          </a-form-item>
          <a-form-item>
            <a-space>
              <a-button type="primary" html-type="submit" :loading="busy">保存机柜</a-button>
              <a-button @click="rackDraft = null">取消</a-button>
              <a-popconfirm v-if="rackDraft.id && rack?.id === rackDraft.id && !devices.length" title="删除该空机柜？"
                ok-text="删除" cancel-text="取消" @confirm="removeRack(rack)">
                <a-button danger :disabled="busy">删除空机柜</a-button>
              </a-popconfirm>
            </a-space>
          </a-form-item>
        </a-form>

        <div class="floor-toolbar">
          <a-space>
            <a-button :type="view === 'floor' ? 'primary' : 'default'" size="small" @click="view = 'floor'"><TableOutlined /> 平面布局</a-button>
            <a-button :type="view === '3d' ? 'primary' : 'default'" size="small" @click="view = '3d'"><AppstoreOutlined /> 3D 总览</a-button>
          </a-space>
          <a-space v-if="racks.length">
            <span class="muted">机柜</span>
            <a-select :value="rackId ?? undefined" style="width: 140px" :disabled="busy" @change="changeRack">
              <a-select-option v-for="item in racks" :key="item.id" :value="item.id">{{ item.name }}</a-select-option>
            </a-select>
          </a-space>
        </div>

        <div v-if="view === 'floor'" class="floor-scroll">
          <div class="floor-grid" :style="{ gridTemplateColumns: 'repeat(' + room.columns + ', minmax(54px, 1fr))' }">
            <div v-for="cell in cells" :key="cell.key" class="floor-cell" :class="{ 'drop-cell': dragRack && !cell.rack }"
              :title="'第 ' + cell.row + ' 行，第 ' + cell.column + ' 列'"
              @dragover="allowDrop($event, !!cell.rack)" @drop="moveRack($event, cell.column, cell.row, !!cell.rack)">
              <button v-if="cell.rack" class="rack-tile" type="button" :aria-pressed="cell.rack.id === rackId"
                :draggable="editable && !busy" @click="selectRack(cell.rack.id)" @dragstart="startDrag($event, cell.rack)" @dragend="dragRack = null">
                <CloudServerOutlined />
                <strong>{{ cell.rack.name }}</strong>
                <span class="rack-direction" aria-hidden="true" :style="{ transform: 'rotate(' + cell.rack.rotation + 'deg)' }">↓</span>
              </button>
              <span v-else class="muted cell-dot" aria-hidden="true">·</span>
            </div>
          </div>
          <p v-if="editable && racks.length" class="floor-hint muted">拖动机柜到空格，也可以通过编辑机柜设置坐标和朝向。</p>
        </div>
        <RoomScene v-else :room="room" :racks="racks" :placements="roomPlacements" :assets="byId"
          :selected-rack="rackId" :selected-asset="focused" @rack="selectRack" @device="openSceneDevice" />
      </a-card>

      <a-card :bordered="false" class="rack-panel">
        <template #title>
          <a-space v-if="rack" wrap>
            <span>{{ rack.name }} · 机柜正视图</span>
            <span class="muted">已用 {{ usedU }} / {{ rack.heightU }}U · 剩余 {{ rack.heightU - usedU }}U</span>
          </a-space>
        </template>
        <template #extra>
          <a-space v-if="editable && rack">
            <a-button size="small" :disabled="busy" @click="editRack(rack)">编辑机柜</a-button>
            <a-button size="small" type="primary" :disabled="busy || usedU === rack.heightU" @click="editMount()">
              <PlusOutlined /> 上架设备
            </a-button>
          </a-space>
        </template>
        <template v-if="rack">

          <a-form v-if="mountDraft" layout="inline" class="facility-form mount-form" @finish="saveMount">
            <a-form-item label="录入方式">
              <a-select v-model:value="mountDraft.mode" style="width: 150px" @change="changeMountMode">
                <a-select-option value="existing">关联已有资产</a-select-option>
                <a-select-option value="new">新建资产并上架</a-select-option>
              </a-select>
            </a-form-item>
            <template v-if="mountDraft.mode === 'existing'">
              <a-form-item label="选择设备">
                <a-select v-model:value="mountDraft.assetId" style="width: 250px" @change="changeDevice">
                  <a-select-option :value="0">请选择资产</a-select-option>
                  <a-select-option v-for="asset in candidates" :key="asset.id" :value="asset.id">
                    {{ asset.name }} · {{ mountKinds[asset.kind as MountKind] }} #{{ asset.id }}{{ mounted.has(asset.id) ? ' · 已上架' : '' }}
                  </a-select-option>
                </a-select>
              </a-form-item>
              <a-form-item v-if="mountLocation" label="当前位置">{{ locationLabel(mountLocation) }}</a-form-item>
            </template>
            <template v-else>
              <a-form-item label="设备类型">
                <a-select v-model:value="mountDraft.kind" style="width: 110px" @change="changeMountMode">
                  <a-select-option v-for="(label, kind) in mountKinds" :key="kind" :value="kind">{{ label }}</a-select-option>
                </a-select>
              </a-form-item>
              <a-form-item label="设备名称"><a-input v-model:value="mountDraft.name" :maxlength="160" /></a-form-item>
              <a-form-item label="管理地址 / IP"><a-input v-model:value="mountDraft.address" :maxlength="160" /></a-form-item>
            </template>
            <a-form-item label="起始 U 位"><a-input-number v-model:value="mountDraft.startU" :min="1" :max="rack.heightU" /></a-form-item>
            <a-form-item label="占用 U 数"><a-input-number v-model:value="mountDraft.units" :min="1" :max="rack.heightU" /></a-form-item>
            <a-form-item>
              <a-space>
                <a-button type="primary" html-type="submit" :loading="busy" :disabled="mountDraft.mode === 'existing' && !mountDraft.assetId">
                  {{ mountDraft.mode === 'existing' && mountDraft.version ? '保存位置' : '保存上架' }}
                </a-button>
                <a-button @click="mountDraft = null">取消</a-button>
              </a-space>
            </a-form-item>
          </a-form>

          <div ref="elevation" class="elevation-scroll">
            <div class="elevation-grid" :style="{ gridTemplateRows: 'repeat(' + rack.heightU + ', 22px)' }">
              <template v-for="(unit, index) in rackUnits" :key="unit">
                <span class="u-label muted" :style="{ gridRow: index + 1 }">U{{ unit }}</span>
                <div class="u-slot" :style="{ gridRow: index + 1 }"></div>
              </template>
              <button v-for="device in devices" :key="device.assetId" type="button" class="u-device"
                :class="byId.get(device.assetId)?.kind" :data-asset-id="device.assetId" :data-focused="focused === device.assetId"
                :style="{ gridRow: deviceRow(device) }" @click="emit('openAsset', device.assetId)">
                <strong>{{ nameOf(device.assetId) }}</strong><span>{{ uRange(device) }}</span>
              </button>
            </div>
          </div>

          <a-list v-if="devices.length" :data-source="devices" size="small" class="rack-devices">
            <template #renderItem="{ item }">
              <a-list-item>
                <a-space>
                  <a-button type="link" @click="emit('openAsset', item.assetId)">{{ nameOf(item.assetId) }}</a-button>
                  <span class="muted">{{ uRange(item) }}</span>
                </a-space>
                <a-space v-if="editable">
                  <a-button v-if="byId.get(item.assetId)?.lifecycle === 'active'" size="small" :disabled="busy" @click="editMount(item)">调整</a-button>
                  <a-popconfirm title="下架该设备？资产台账会保留。" ok-text="下架" cancel-text="取消" @confirm="unmountDevice(item)">
                    <a-button size="small" danger :disabled="busy">下架</a-button>
                  </a-popconfirm>
                </a-space>
              </a-list-item>
            </template>
          </a-list>
        </template>
        <a-empty v-else description="请选择机柜" />
      </a-card>
    </div>
  </div>
</template>

<style scoped>
.facilities { display: grid; gap: 12px; }
.facility-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px; }
.room-picker, .rack-picker { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 13px; min-width: 0; }
.room-picker select { max-width: 200px; }
.rack-picker select { max-width: 155px; min-height: 30px; }
.location-search { flex: 1 1 190px; max-width: 320px; min-width: 0; }
.facility-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.facility-bar > .facility-actions { margin-left: auto; }
.location-results { display: grid; gap: 3px; border-top: 1px solid var(--line); padding: 8px 14px; font-size: 13px; }
.location-result { display: flex; justify-content: space-between; text-align: left; gap: 8px; flex-wrap: wrap; border: 0; background: #f1f6fe; color: #24466f; border-radius: 6px; padding: 7px 9px; }
.location-result:hover { background: #e8f1ff; }
.facility-form { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); background: #f8fafe; }
.facility-form label { display: grid; gap: 3px; font-size: 12px; color: #435e7e; min-width: 0; }
.facility-form input[type=number] { width: 76px; }
.facility-form .facility-wide { flex: 1 1 150px; }
.facility-form label select, .facility-form label input { max-width: 100%; }
.rack-form { border-bottom: 1px solid var(--line); }
.mount-form { border-bottom: 1px solid var(--line); }
.mount-form .form-note { font-size: 12px; flex-basis: 100%; }
.facility-feedback { color: #176347; background: #e7f7ef; border-radius: 7px; padding: 6px 10px; font-size: 13px; }
.facility-workspace { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(270px, 1fr); gap: 12px; align-items: start; }
.facility-heading { flex-wrap: wrap; padding: 13px 13px 10px; }
.facility-heading h2 { overflow-wrap: anywhere; }
.floor-toolbar { display: flex; justify-content: space-between; gap: 7px; flex-wrap: wrap; align-items: center; padding: 8px 13px; border-block: 1px solid var(--line); }
.floor-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.floor-tabs button[aria-pressed=true] { background: #e9f1ff; border-color: #9dbcf0; color: #184e9f; }
.floor-scroll { overflow-x: auto; padding: 10px 12px; background: #f5f8fc; }
.floor-grid { display: grid; gap: 5px; }
.floor-cell { min-height: 54px; display: grid; place-items: stretch; border: 1px solid #dfe8f4; background: #fcfdff; border-radius: 6px; }
.floor-cell.drop-cell { background: #eaf4ff; border-color: #a5c3f5; }
.cell-dot { align-self: center; justify-self: center; }
.rack-tile { position: relative; min-width: 0; border: 1px solid #b7cce8; border-radius: 5px; padding: 4px 2px; background: #e9f0fa; color: #335579; display: grid; place-items: center; align-content: center; gap: 3px; }
.rack-tile strong { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.rack-tile[aria-pressed=true] { color: #174c9a; background: #dbeaff; border-color: #729dde; }
.rack-tile[draggable=true] { cursor: grab; }
.rack-direction { position: absolute; right: 3px; top: 1px; font-size: 11px; }
.floor-hint { margin-top: 8px; font-size: 11px; }
.elevation-scroll { max-height: 438px; overflow-y: auto; padding: 8px 12px; }
.elevation-grid { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 1px 5px; }
.u-label { align-self: center; text-align: right; font-size: 11px; grid-column: 1; }
.u-slot { grid-column: 2; background: #f2f6fc; border-radius: 3px; }
.u-device { grid-column: 2; display: flex; align-items: center; justify-content: space-between; gap: 5px; padding: 0 6px; min-width: 0; border: 1px solid #b7d2fa; border-radius: 4px; background: #e5efff; color: #1b4889; font-size: 11px; }
.u-device strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.u-device span { white-space: nowrap; }
.u-device.switch { background: #ddf5ee; border-color: #acdccc; color: #1d6156; }
.u-device[data-focused=true] { outline: 2px solid #b07513; outline-offset: -2px; }
.rack-devices { border-top: 1px solid var(--line); padding: 5px 12px 9px; }
.rack-device-row { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; padding: 7px 0; border-bottom: 1px solid #edf1f7; font-size: 12px; }
.rack-device-row:last-child { border-bottom: 0; }
.rack-device-row .facility-actions { margin-left: auto; }
.rack-device-row .button { min-height: 26px; }
@media (max-width: 1080px) { .facility-workspace { grid-template-columns: 1fr; } }
</style>
