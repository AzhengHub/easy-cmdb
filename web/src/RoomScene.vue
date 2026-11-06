<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AmbientLight, BoxGeometry, BufferGeometry, CanvasTexture, Color, DirectionalLight,
  Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, Raycaster, Scene, Sprite, SpriteMaterial, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Material, Texture } from 'three'
import type { Asset } from './api'
import type { Placement, Rack, Room } from './facilities'

const props = defineProps<{
  room: Room
  racks: Rack[]
  placements: Placement[]
  assets: Map<number, Asset>
  selectedRack: number | null
  selectedAsset: number | null
}>()

const emit = defineEmits<{
  rack: [id: number]
  device: [assetId: number, rackId: number]
}>()

const mount = ref<HTMLDivElement>()
const unavailable = ref(false)
const scene = new Scene()
const camera = new PerspectiveCamera(42, 1, 0.04, 250)
const raycaster = new Raycaster()
const pointer = new Vector2()
let renderer: WebGLRenderer | undefined
let controls: OrbitControls | undefined
let observer: ResizeObserver | undefined
let roomModel: Group | undefined
let cabinets: Group | undefined
let pointerStart: { x: number; y: number; id: number } | undefined

const unitHeight = 0.043
const homeDirection = new Vector3(.78, .84, .95).normalize()
const homeRight = new Vector3(0, 1, 0).cross(homeDirection).normalize()
const homeUp = new Vector3().crossVectors(homeDirection, homeRight)
const deviceColors: Record<string, number> = { host: 0x3975cc, switch: 0x168e86, chassis: 0x7b58b7 }
scene.background = new Color(0xeff5fc)
scene.add(new AmbientLight(0xffffff, 1.65))
const key = new DirectionalLight(0xffffff, 2.1)
key.position.set(6, 10, 7)
scene.add(key)

function render() {
  renderer?.render(scene, camera)
}

function disposeRoom() {
  if (!roomModel) return
  const materials = new Set<Material>()
  const textures = new Set<Texture>()
  roomModel.traverse(object => {
    if (object instanceof Mesh || object instanceof LineSegments) {
      object.geometry.dispose()
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material)
      }
    } else if (object instanceof Sprite) {
      materials.add(object.material)
      if (object.material.map) textures.add(object.material.map)
    }
  })
  materials.forEach(material => material.dispose())
  textures.forEach(texture => texture.dispose())
  scene.remove(roomModel)
  roomModel = undefined
  cabinets = undefined
}

function label(text: string, selected: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = selected ? '#1559c1' : '#193252'
  ctx.fillRect(0, 0, 256, 64)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 31px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const shortened = Array.from(text)
  ctx.fillText(shortened.length > 13 ? shortened.slice(0, 12).join('') + '…' : text, 128, 33, 238)

  const texture = new CanvasTexture(canvas)
  const tag = new Sprite(new SpriteMaterial({ map: texture, depthWrite: false, toneMapped: false }))
  tag.scale.set(.76, .19, 1)
  return tag
}

function rebuildRoom() {
  if (!renderer) return
  disposeRoom()
  roomModel = new Group()
  cabinets = new Group()
  roomModel.add(cabinets)
  scene.add(roomModel)

  const { columns, rows } = props.room
  const floor = new Mesh(new PlaneGeometry(columns, rows), new MeshStandardMaterial({ color: 0xdfe8f3 }))
  floor.rotation.x = -Math.PI / 2
  floor.position.set(columns / 2, 0, rows / 2)
  roomModel.add(floor)
  const grid: number[] = []
  for (let col = 0; col <= columns; col++) grid.push(col, .003, 0, col, .003, rows)
  for (let row = 0; row <= rows; row++) grid.push(0, .003, row, columns, .003, row)
  const gridGeometry = new BufferGeometry()
  gridGeometry.setAttribute('position', new Float32BufferAttribute(grid, 3))
  roomModel.add(new LineSegments(gridGeometry, new LineBasicMaterial({ color: 0xa5b9d1 })))

  const frame = new MeshStandardMaterial({ color: 0x405777 })
  const selectedFrame = new MeshStandardMaterial({ color: 0x1e64ce })
  const back = new MeshStandardMaterial({ color: 0x253950 })
  const panelMaterials = new Map<string, MeshStandardMaterial>()
  const byRack = new Map<number, Placement[]>()
  for (const placement of props.placements) {
    const devices = byRack.get(placement.rackId) ?? []
    devices.push(placement)
    byRack.set(placement.rackId, devices)
  }

  for (const rack of props.racks) {
    const cabinet = new Group()
    const height = .12 + rack.heightU * unitHeight
    const chosen = rack.id === props.selectedRack
    const structure = chosen ? selectedFrame : frame
    cabinet.position.set(rack.column - .5, 0, rack.row - .5)
    cabinet.rotation.y = -rack.rotation * Math.PI / 180
    cabinet.userData.rackId = rack.id
    cabinets.add(cabinet)

    function box(width: number, tall: number, depth: number, x: number, y: number, z: number, material: Material, assetId?: number) {
      const mesh = new Mesh(new BoxGeometry(width, tall, depth), material)
      mesh.position.set(x, y, z)
      mesh.userData.rackId = rack.id
      if (assetId !== undefined) mesh.userData.assetId = assetId
      cabinet.add(mesh)
    }

    box(.78, .045, .72, 0, .025, 0, structure)
    box(.78, .04, .72, 0, height - .02, 0, structure)
    box(.047, height, .72, -.367, height / 2, 0, structure)
    box(.047, height, .72, .367, height / 2, 0, structure)
    box(.69, height - .08, .04, 0, height / 2, -.33, back)
    const rackTag = label(rack.name, chosen)
    if (rackTag) {
      rackTag.position.y = height + .14
      rackTag.userData.rackId = rack.id
      cabinet.add(rackTag)
    }
    for (const placement of byRack.get(rack.id) ?? []) {
      const asset = props.assets.get(placement.assetId)
      const kind = asset?.kind ?? 'host'
      const focused = placement.assetId === props.selectedAsset
      const materialKey = focused ? 'selected' : kind
      let material = panelMaterials.get(materialKey)
      if (!material) {
        material = new MeshStandardMaterial({ color: focused ? 0xf5ad28 : (deviceColors[kind] ?? 0x3975cc) })
        panelMaterials.set(materialKey, material)
      }
      const tall = placement.units * unitHeight
      const y = .06 + (placement.startU - 1) * unitHeight + tall / 2
      box(.65, tall - .007, .48, 0, y, .10, material, placement.assetId)
    }
  }

  // Shared materials are referenced by the geometry and disposed together with it.
  if (props.racks.every(rack => rack.id !== props.selectedRack)) selectedFrame.dispose()
  if (props.racks.every(rack => rack.id === props.selectedRack)) frame.dispose()
  if (!props.racks.length) back.dispose()
  render()
}

function resetCamera() {
  if (!controls) return
  const { columns, rows } = props.room
  const top = .37 + tallestRack() * unitHeight
  const target = controls.target.set(columns / 2, top / 2, rows / 2)
  const vertical = Math.tan(camera.fov * Math.PI / 360) * .88
  const horizontal = vertical * camera.aspect
  const corner = new Vector3()
  let distance = 1.6
  // Fit every room boundary in the current camera frustum, including rack labels.
  for (const x of [0, columns]) {
    for (const y of [0, top]) {
      for (const z of [0, rows]) {
        corner.set(x, y, z).sub(target)
        distance = Math.max(distance, corner.dot(homeDirection) + Math.max(
          Math.abs(corner.dot(homeRight)) / horizontal,
          Math.abs(corner.dot(homeUp)) / vertical,
        ))
      }
    }
  }
  camera.position.copy(target).addScaledVector(homeDirection, distance)
  controls.minDistance = 1.6
  controls.maxDistance = Math.max(columns, rows, distance) * 3.4
  controls.update()
  render()
}

function tallestRack() {
  return props.racks.reduce((height, rack) => Math.max(height, rack.heightU), 0)
}

function resize() {
  if (!renderer || !mount.value) return
  const { clientWidth: width, clientHeight: height } = mount.value
  if (!width || !height) return
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height, false)
  render()
}

function recordPointer(event: PointerEvent) {
  if (event.button === 0 && event.isPrimary) {
    pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
  }
}

function pick(event: PointerEvent) {
  const start = pointerStart
  pointerStart = undefined
  if (!start || start.id !== event.pointerId || !renderer || !cabinets ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2)
  raycaster.setFromCamera(pointer, camera)
  const hit = raycaster.intersectObject(cabinets, true)[0]?.object.userData
  if (!hit?.rackId) return
  if (hit.assetId) emit('device', hit.assetId, hit.rackId)
  else emit('rack', hit.rackId)
}

onMounted(() => {
  if (!mount.value) return
  try {
    renderer = new WebGLRenderer({ antialias: true })
  } catch {
    unavailable.value = true
    return
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.domElement.setAttribute('aria-label', '机房三维布局')
  mount.value.append(renderer.domElement)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.maxPolarAngle = Math.PI / 2 - .06
  controls.addEventListener('change', render)
  renderer.domElement.addEventListener('pointerdown', recordPointer)
  renderer.domElement.addEventListener('pointerup', pick)
  observer = new ResizeObserver(resize)
  observer.observe(mount.value)
  resize()
  resetCamera()
  rebuildRoom()
})

watch([() => props.room.id, () => props.room.columns, () => props.room.rows, tallestRack], resetCamera)
watch(() => [props.room, props.racks, props.placements, props.assets, props.selectedRack, props.selectedAsset], rebuildRoom)

onBeforeUnmount(() => {
  observer?.disconnect()
  controls?.dispose()
  disposeRoom()
  if (renderer) {
    renderer.domElement.removeEventListener('pointerdown', recordPointer)
    renderer.domElement.removeEventListener('pointerup', pick)
    renderer.dispose()
    renderer.domElement.remove()
  }
})
</script>

<template>
  <div class="room-scene">
    <div ref="mount" class="room-scene-canvas"></div>
    <div v-if="unavailable" class="room-scene-message" role="status">当前浏览器无法显示 3D。可切换到平面布局继续查看和编辑。</div>
    <button v-else type="button" class="button small scene-reset" @click="resetCamera">重置视角</button>
  </div>
</template>

<style scoped>
.room-scene { position: relative; min-height: 340px; height: clamp(340px, 44vh, 530px); background: #eff5fc; }
.room-scene-canvas { width: 100%; height: 100%; overflow: hidden; }
.room-scene-canvas :deep(canvas) { display: block; width: 100%; height: 100%; }
.room-scene-message { position: absolute; top: 42%; inset-inline: 10px; text-align: center; color: #536780; }
.scene-reset { position: absolute; top: 10px; right: 10px; }
</style>
