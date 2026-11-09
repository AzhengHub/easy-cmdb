import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'antd'
import {
  AmbientLight, BoxGeometry, BufferGeometry, CanvasTexture, Color, DirectionalLight,
  Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, Raycaster, Scene, Sprite, SpriteMaterial, Vector2, Vector3, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Material, Texture } from 'three'
import type { Asset } from '../api'
import type { Placement, Rack, Room } from '../facilities'

interface Props {
  room: Room
  racks: Rack[]
  placements: Placement[]
  assets: Map<number, Asset>
  selectedRack: number | null
  selectedAsset: number | null
  dark: boolean
  onRack: (id: number) => void
  onDevice: (assetId: number, rackId: number) => void
}

interface SceneState {
  renderer?: WebGLRenderer
  controls?: OrbitControls
  observer?: ResizeObserver
  roomModel?: Group
  cabinets?: Group
  pointerStart?: { x: number; y: number; id: number }
}

const unitHeight = 0.043
const deviceColors: Record<string, number> = { host: 0x3975cc, switch: 0x168e86 }

export function RoomScene(props: Props) {
  const mount = useRef<HTMLDivElement>(null)
  const [unavailable, setUnavailable] = useState(false)
  const scene = useMemo(() => {
    const value = new Scene()
    value.background = new Color(0xeff5fc)
    value.add(new AmbientLight(0xffffff, 1.65))
    const key = new DirectionalLight(0xffffff, 2.1)
    key.position.set(6, 10, 7)
    value.add(key)
    return value
  }, [])
  const camera = useMemo(() => new PerspectiveCamera(42, 1, 0.04, 250), [])
  const raycaster = useMemo(() => new Raycaster(), [])
  const pointer = useMemo(() => new Vector2(), [])
  const homeDirection = useMemo(() => new Vector3(.78, .84, .95).normalize(), [])
  const homeRight = useMemo(() => new Vector3(0, 1, 0).cross(homeDirection).normalize(), [homeDirection])
  const homeUp = useMemo(() => new Vector3().crossVectors(homeDirection, homeRight), [homeDirection, homeRight])
  const state = useRef<SceneState>({})
  const propsRef = useRef(props)
  propsRef.current = props

  const render = useCallback(() => {
    state.current.renderer?.render(scene, camera)
  }, [scene, camera])

  const disposeRoom = useCallback(() => {
    const current = state.current.roomModel
    if (!current) return
    const materials = new Set<Material>()
    const textures = new Set<Texture>()
    current.traverse(object => {
      if (object instanceof Mesh || object instanceof LineSegments) {
        object.geometry.dispose()
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
      } else if (object instanceof Sprite) {
        materials.add(object.material)
        if (object.material.map) textures.add(object.material.map)
      }
    })
    materials.forEach(material => material.dispose())
    textures.forEach(texture => texture.dispose())
    scene.remove(current)
    state.current.roomModel = undefined
    state.current.cabinets = undefined
  }, [scene])

  const label = useCallback((text: string, selected: boolean, dark: boolean) => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = dark ? (selected ? '#1559c1' : '#262626') : (selected ? '#1559c1' : '#193252')
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
  }, [])

  const rebuildRoom = useCallback(() => {
    if (!state.current.renderer) return
    disposeRoom()
    const p = propsRef.current
    const dark = p.dark
    scene.background = new Color(dark ? 0x141414 : 0xeff5fc)
    const roomModel = new Group()
    const cabinets = new Group()
    roomModel.add(cabinets)
    scene.add(roomModel)
    state.current.roomModel = roomModel
    state.current.cabinets = cabinets

    const { columns, rows } = p.room
    const floor = new Mesh(new PlaneGeometry(columns, rows), new MeshStandardMaterial({ color: dark ? 0x262626 : 0xdfe8f3 }))
    floor.rotation.x = -Math.PI / 2
    floor.position.set(columns / 2, 0, rows / 2)
    roomModel.add(floor)

    const grid: number[] = []
    for (let col = 0; col <= columns; col++) grid.push(col, .003, 0, col, .003, rows)
    for (let row = 0; row <= rows; row++) grid.push(0, .003, row, columns, .003, row)
    const gridGeometry = new BufferGeometry()
    gridGeometry.setAttribute('position', new Float32BufferAttribute(grid, 3))
    roomModel.add(new LineSegments(gridGeometry, new LineBasicMaterial({ color: dark ? 0x434343 : 0xa5b9d1 })))

    const frame = new MeshStandardMaterial({ color: dark ? 0x8c8c8c : 0x405777 })
    const selectedFrame = new MeshStandardMaterial({ color: dark ? 0x1677ff : 0x1e64ce })
    const back = new MeshStandardMaterial({ color: dark ? 0x1f1f1f : 0x253950 })
    const panelColors = dark ? { host: 0x4096ff, switch: 0x13c2c2 } : deviceColors
    const panelMaterials = new Map<string, MeshStandardMaterial>()
    const byRack = new Map<number, Placement[]>()
    for (const placement of p.placements) {
      const devices = byRack.get(placement.rackId) ?? []
      devices.push(placement)
      byRack.set(placement.rackId, devices)
    }

    for (const rack of p.racks) {
      const cabinet = new Group()
      const height = .12 + rack.heightU * unitHeight
      const chosen = rack.id === p.selectedRack
      const structure = chosen ? selectedFrame : frame
      cabinet.position.set(rack.column - .5, 0, rack.row - .5)
      cabinet.rotation.y = -rack.rotation * Math.PI / 180
      cabinet.userData.rackId = rack.id
      cabinets.add(cabinet)

      const box = (width: number, tall: number, depth: number, x: number, y: number, z: number, material: Material, assetId?: number) => {
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
      const rackTag = label(rack.name, chosen, dark)
      if (rackTag) {
        rackTag.position.y = height + .14
        rackTag.userData.rackId = rack.id
        cabinet.add(rackTag)
      }
      for (const placement of byRack.get(rack.id) ?? []) {
        const asset = p.assets.get(placement.assetId)
        const kind = asset?.kind ?? 'host'
        const focused = placement.assetId === p.selectedAsset
        const materialKey = focused ? 'selected' : kind
        let material = panelMaterials.get(materialKey)
        if (!material) {
          material = new MeshStandardMaterial({ color: focused ? 0xf5ad28 : (panelColors[kind] ?? 0x3975cc) })
          panelMaterials.set(materialKey, material)
        }
        const tall = placement.units * unitHeight
        const y = .06 + (placement.startU - 1) * unitHeight + tall / 2
        box(.65, tall - .007, .48, 0, y, .10, material, placement.assetId)
      }
    }

    if (p.racks.every(rack => rack.id !== p.selectedRack)) selectedFrame.dispose()
    if (p.racks.every(rack => rack.id === p.selectedRack)) frame.dispose()
    if (!p.racks.length) back.dispose()
    render()
  }, [disposeRoom, label, render, scene])

  const resetCamera = useCallback(() => {
    if (!state.current.controls) return
    const p = propsRef.current
    const { columns, rows } = p.room
    const tallest = p.racks.reduce((height, rack) => Math.max(height, rack.heightU), 0)
    const top = .37 + tallest * unitHeight
    const target = state.current.controls.target.set(columns / 2, top / 2, rows / 2)
    const vertical = Math.tan(camera.fov * Math.PI / 360) * .88
    const horizontal = vertical * camera.aspect
    const corner = new Vector3()
    let distance = 1.6
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
    state.current.controls.minDistance = 1.6
    state.current.controls.maxDistance = Math.max(columns, rows, distance) * 3.4
    state.current.controls.update()
    render()
  }, [camera, homeDirection, homeRight, homeUp, render])

  const resize = useCallback(() => {
    if (!state.current.renderer || !mount.current) return
    const { clientWidth: width, clientHeight: height } = mount.current
    if (!width || !height) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    state.current.renderer.setSize(width, height, false)
    render()
  }, [camera, render])

  const recordPointer = useCallback((event: PointerEvent) => {
    if (event.button === 0 && event.isPrimary) {
      state.current.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
    }
  }, [])

  const pick = useCallback((event: PointerEvent) => {
    const start = state.current.pointerStart
    state.current.pointerStart = undefined
    if (!start || start.id !== event.pointerId || !state.current.renderer || !state.current.cabinets ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return
    const rect = state.current.renderer.domElement.getBoundingClientRect()
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObject(state.current.cabinets, true)[0]?.object.userData
    if (!hit?.rackId) return
    if (hit.assetId) propsRef.current.onDevice(hit.assetId, hit.rackId)
    else propsRef.current.onRack(hit.rackId)
  }, [camera, pointer, raycaster])

  useEffect(() => {
    if (!mount.current) return
    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ antialias: true })
    } catch {
      setUnavailable(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.domElement.setAttribute('aria-label', '数据中心三维布局')
    mount.current.append(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.maxPolarAngle = Math.PI / 2 - .06
    controls.addEventListener('change', render)
    renderer.domElement.addEventListener('pointerdown', recordPointer)
    renderer.domElement.addEventListener('pointerup', pick)
    const observer = new ResizeObserver(resize)
    observer.observe(mount.current)
    state.current.renderer = renderer
    state.current.controls = controls
    state.current.observer = observer
    resize()
    resetCamera()
    rebuildRoom()

    return () => {
      observer.disconnect()
      controls.dispose()
      disposeRoom()
      renderer.domElement.removeEventListener('pointerdown', recordPointer)
      renderer.domElement.removeEventListener('pointerup', pick)
      renderer.dispose()
      renderer.domElement.remove()
      state.current = {}
    }
  }, [camera, disposeRoom, pick, rebuildRoom, recordPointer, render, resetCamera, resize])

  const tallest = props.racks.reduce((height, rack) => Math.max(height, rack.heightU), 0)
  useEffect(() => {
    resetCamera()
  }, [props.room.id, props.room.columns, props.room.rows, tallest, resetCamera])

  useEffect(() => {
    rebuildRoom()
  }, [props.room, props.racks, props.placements, props.assets, props.selectedRack, props.selectedAsset, props.dark, rebuildRoom])

  return (
    <div className="room-scene">
      <div ref={mount} className="room-scene-canvas" />
      {unavailable ? (
        <div className="room-scene-message" role="status">当前浏览器无法显示 3D。可切换到平面布局继续查看和编辑。</div>
      ) : (
        <Button size="small" className="scene-reset" onClick={resetCamera}>重置视角</Button>
      )}
    </div>
  )
}
