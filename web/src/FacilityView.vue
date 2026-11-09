<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { Box, Grid2X2, MapPin, Plus, Search, Server } from '@lucide/vue'
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
  if (!window.confirm('删除空数据中心「' + value.name + '」？')) return
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
  if (!window.confirm('删除空机柜「' + value.name + '」？')) return
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
  if (!window.confirm('下架「' + nameOf(value.assetId) + '」？资产台账会保留。')) return
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
</script>

<template>
  <div class="facilities">
    <div class="panel facility-controls">
      <div class="facility-bar">
        <label class="room-picker">
          <span>数据中心</span>
          <select :value="roomId ?? ''" :disabled="!rooms.length || busy" @change="selectRoom(Number(($event.target as HTMLSelectElement).value))">
            <option v-if="!rooms.length" value="">暂无数据中心</option>
            <option v-for="item in rooms" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <label v-if="rooms.length" class="search location-search"><Search :size="16" /><input v-model="search" aria-label="定位资产" placeholder="搜索已上架资产、数据中心或机柜…" /></label>
        <div v-if="editable" class="facility-actions">
          <button type="button" class="button primary" :disabled="busy" @click="editRoom()"><Plus :size="16" /> 新增数据中心</button>
          <button v-if="room" type="button" class="button" :disabled="busy" @click="editRoom(room)">编辑数据中心</button>
        </div>
      </div>
      <div v-if="search.trim()" class="location-results" aria-label="资产定位结果">
        <button v-for="result in searchResults" :key="result.asset.id" class="location-result" type="button" @click="showLocation(result.location)">
          <strong>{{ result.asset.name }}</strong><span class="muted">{{ locationLabel(result.location) }}</span>
        </button>
        <p v-if="!searchResults.length" class="muted">暂无匹配的上架位置</p>
      </div>

      <form v-if="roomDraft" class="facility-form" aria-label="数据中心配置" @submit.prevent="saveRoom">
        <label class="facility-wide">数据中心名称<input v-model.trim="roomDraft.name" placeholder="例如：北京数据中心" maxlength="160" required /></label>
        <label>列数<input v-model.number="roomDraft.columns" type="number" min="1" max="24" required /></label>
        <label>行数<input v-model.number="roomDraft.rows" type="number" min="1" max="24" required /></label>
        <div class="facility-actions">
          <button class="button primary" :disabled="busy">保存数据中心</button>
          <button type="button" class="button" @click="roomDraft = null">取消</button>
          <button v-if="roomDraft.id && room?.id === roomDraft.id && !racks.length" type="button" class="button" :disabled="busy" @click="removeRoom(room)">删除空数据中心</button>
        </div>
      </form>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="feedback" class="facility-feedback" role="status">{{ feedback }}</p>

    <div v-if="!room" class="panel empty-state">
      <MapPin :size="27" /><h3>暂无数据中心</h3>
      <p>{{ editable ? '新增一个数据中心，就可以开始摆放机柜。' : '数据中心录入后会显示在这里。' }}</p>
    </div>

    <div v-else class="facility-workspace">
      <section class="panel floor-panel">
        <div class="panel-heading facility-heading">
          <div><h2>{{ room.name }}</h2><p class="muted">{{ room.columns }} 列 × {{ room.rows }} 行 · {{ racks.length }} 台机柜</p></div>
          <div class="facility-actions">
            <button v-if="editable" type="button" class="button small" :disabled="busy" @click="editRack()"><Plus :size="15" /> 新增机柜</button>
          </div>
        </div>

        <form v-if="rackDraft" class="facility-form rack-form" aria-label="机柜配置" @submit.prevent="saveRack">
          <label class="facility-wide">机柜编号<input v-model.trim="rackDraft.name" placeholder="例如：A-01" maxlength="80" required /></label>
          <label>机柜高度（U）<input v-model.number="rackDraft.heightU" type="number" min="1" max="80" required /></label>
          <label>列<input v-model.number="rackDraft.column" type="number" min="1" :max="room.columns" required /></label>
          <label>行<input v-model.number="rackDraft.row" type="number" min="1" :max="room.rows" required /></label>
          <label>朝向<select v-model.number="rackDraft.rotation"><option :value="0">向下</option><option :value="90">向左</option><option :value="180">向上</option><option :value="270">向右</option></select></label>
          <div class="facility-actions">
            <button class="button primary" :disabled="busy">保存机柜</button>
            <button type="button" class="button" @click="rackDraft = null">取消</button>
            <button v-if="rackDraft.id && rack?.id === rackDraft.id && !devices.length" type="button" class="button" :disabled="busy" @click="removeRack(rack)">删除空机柜</button>
          </div>
        </form>

        <div class="floor-toolbar">
          <div class="floor-tabs" role="group" aria-label="布局视图">
            <button type="button" class="button small" :aria-pressed="view === 'floor'" @click="view = 'floor'"><Grid2X2 :size="15" /> 平面布局</button>
            <button type="button" class="button small" :aria-pressed="view === '3d'" @click="view = '3d'"><Box :size="15" /> 3D 总览</button>
          </div>
          <label v-if="racks.length" class="rack-picker">机柜
            <select :value="rackId ?? ''" :disabled="busy" @change="selectRack(Number(($event.target as HTMLSelectElement).value))">
              <option v-for="item in racks" :key="item.id" :value="item.id">{{ item.name }}</option>
            </select>
          </label>
        </div>
        <div v-if="view === 'floor'" class="floor-scroll">
          <div class="floor-grid" :style="{ gridTemplateColumns: 'repeat(' + room.columns + ', minmax(54px, 1fr))' }">
            <div v-for="cell in cells" :key="cell.key" class="floor-cell" :class="{ 'drop-cell': dragRack && !cell.rack }"
              :title="'第 ' + cell.row + ' 行，第 ' + cell.column + ' 列'"
              @dragover="allowDrop($event, !!cell.rack)" @drop="moveRack($event, cell.column, cell.row, !!cell.rack)">
              <button v-if="cell.rack" class="rack-tile" type="button" :aria-pressed="cell.rack.id === rackId"
                :draggable="editable && !busy" @click="selectRack(cell.rack.id)" @dragstart="startDrag($event, cell.rack)" @dragend="dragRack = null">
                <Server :size="16" />
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
      </section>

      <section class="panel rack-panel">
        <template v-if="rack">
          <div class="panel-heading facility-heading">
            <div><h2>{{ rack.name }} · 机柜正视图</h2><p class="muted">已用 {{ usedU }} / {{ rack.heightU }}U · 剩余 {{ rack.heightU - usedU }}U</p></div>
            <div v-if="editable" class="facility-actions">
              <button type="button" class="button small" :disabled="busy" @click="editRack(rack)">编辑机柜</button>
              <button type="button" class="button small primary" :disabled="busy || usedU === rack.heightU" @click="editMount()"><Plus :size="14" /> 上架设备</button>
            </div>
          </div>

          <form v-if="mountDraft" class="facility-form mount-form" aria-label="设备上架" @submit.prevent="saveMount">
            <label class="facility-wide">录入方式
              <select v-model="mountDraft.mode" @change="changeMountMode">
                <option value="existing">关联已有资产</option><option value="new">新建资产并上架</option>
              </select>
            </label>
            <template v-if="mountDraft.mode === 'existing'">
              <label class="facility-wide">选择设备
                <select v-model.number="mountDraft.assetId" required @change="changeDevice">
                  <option :value="0">请选择资产</option>
                  <option v-for="asset in candidates" :key="asset.id" :value="asset.id">
                    {{ asset.name }} · {{ mountKinds[asset.kind as MountKind] }} #{{ asset.id }}{{ mounted.has(asset.id) ? ' · 已上架' : '' }}
                  </option>
                </select>
              </label>
              <p v-if="mountLocation" class="muted form-note">当前位置：{{ locationLabel(mountLocation) }}</p>
            </template>
            <template v-else>
              <label>设备类型
                <select v-model="mountDraft.kind" @change="changeMountMode">
                  <option v-for="(label, kind) in mountKinds" :key="kind" :value="kind">{{ label }}</option>
                </select>
              </label>
              <label class="facility-wide">设备名称<input v-model.trim="mountDraft.name" required maxlength="160" /></label>
              <label class="facility-wide">管理地址 / IP<input v-model.trim="mountDraft.address" maxlength="160" /></label>
            </template>
            <label>起始 U 位<input v-model.number="mountDraft.startU" type="number" min="1" :max="rack.heightU" required /></label>
            <label>占用 U 数<input v-model.number="mountDraft.units" type="number" min="1" :max="rack.heightU" required /></label>
            <div class="facility-actions">
              <button class="button primary" :disabled="busy || (mountDraft.mode === 'existing' && !mountDraft.assetId)">
                {{ mountDraft.mode === 'existing' && mountDraft.version ? '保存位置' : '保存上架' }}
              </button>
              <button type="button" class="button" @click="mountDraft = null">取消</button>
            </div>
          </form>

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
          <div v-if="devices.length" class="rack-devices">
            <div v-for="device in devices" :key="device.assetId" class="rack-device-row">
              <button type="button" class="text-button" @click="emit('openAsset', device.assetId)">{{ nameOf(device.assetId) }}</button>
              <span class="muted">{{ uRange(device) }}</span>
              <div v-if="editable" class="facility-actions">
                <button v-if="byId.get(device.assetId)?.lifecycle === 'active'" class="button small" type="button" :disabled="busy" @click="editMount(device)">调整</button>
                <button class="button small" type="button" :disabled="busy" @click="unmountDevice(device)">下架</button>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="empty-state"><Server :size="24" /><h3>请选择机柜</h3><p>机柜正视图会显示设备与 U 位。</p></div>
      </section>
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
