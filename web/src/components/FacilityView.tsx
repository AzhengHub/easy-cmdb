import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Dropdown, Empty, Form, Input, InputNumber, List, Modal, Progress,
  Popconfirm, Select, Space,
} from 'antd'
import {
  ApartmentOutlined, AppstoreOutlined, CloudServerOutlined, ClusterOutlined, EditOutlined,
  MoreOutlined, PieChartOutlined, PlusOutlined, SearchOutlined, TableOutlined,
} from '@ant-design/icons'
import { api, APIError } from '../api'
import type { Asset, Link } from '../api'
import { assetLocations, isMountKind, locationLabel, mountKinds } from '../facilities'
import type { AssetLocation, Facilities, MountKind, Placement, Rack, RackFields, Room, RoomFields } from '../facilities'
import { RackCardGrid } from './RackCardGrid'
import { RackDetailDrawer } from './RackDetailDrawer'
import { RoomScene } from './RoomScene'

interface Props {
  roomId: number | null
  onRoomChange: (id: number) => void
  layout: Facilities
  assets: Asset[]
  links: Link[]
  editable: boolean
  dark: boolean
  focus: AssetLocation | null
  reload: () => Promise<void>
  onOpenAsset: (id: number) => void
  onSessionError: (error: unknown) => void
}

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

export function FacilityView({ roomId, onRoomChange, layout, assets, links, editable, dark, focus, reload, onOpenAsset, onSessionError }: Props) {
  const [rackId, setRackId] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [view, setView] = useState<'cards' | 'floor' | '3d'>('cards')
  const [roomDraft, setRoomDraft] = useState<RoomDraft | null>(null)
  const [rackDraft, setRackDraft] = useState<RackDraft | null>(null)
  const [mountDraft, setMountDraft] = useState<MountDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [search, setSearch] = useState('')
  const [roomSearch, setRoomSearch] = useState('')
  const [rackKeyword, setRackKeyword] = useState('')
  const [dragRack, setDragRack] = useState<number | null>(null)
  const [rackDrawerOpen, setRackDrawerOpen] = useState(false)

  const rooms = layout.rooms
  const activeRoomId = roomId ?? rooms[0]?.id ?? null
  const room = rooms.find(item => item.id === activeRoomId)
  const sortedRooms = useMemo(() => rooms.slice().sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')), [rooms])
  const filteredRooms = roomSearch.trim()
    ? sortedRooms.filter(item => item.name.toLowerCase().includes(roomSearch.trim().toLowerCase()))
    : sortedRooms
  const racks = useMemo(() => layout.racks.filter(item => item.roomId === activeRoomId), [layout.racks, activeRoomId])
  const rack = racks.find(item => item.id === rackId)
  const rackIds = useMemo(() => new Set(racks.map(item => item.id)), [racks])
  const roomPlacements = useMemo(() => layout.placements.filter(item => rackIds.has(item.rackId)), [layout.placements, rackIds])
  const devices = roomPlacements.filter(item => item.rackId === rackId)
  const totalRoomU = racks.reduce((sum, item) => sum + item.heightU, 0)
  const usedRoomU = roomPlacements.reduce((sum, item) => sum + item.units, 0)
  const roomUtilization = totalRoomU ? Math.round(usedRoomU / totalRoomU * 100) : 0
  const byId = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets])
  const locations = useMemo(() => assetLocations(layout, links), [layout, links])
  const mounted = useMemo(() => new Map(layout.placements.map(placement => [placement.assetId, placement])), [layout.placements])
  const candidates = assets.filter(asset => asset.lifecycle === 'active' && isMountKind(asset.kind))
  const searchResults = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return []
    return assets.flatMap(asset => {
      const location = locations.get(asset.id)
      return location && [asset.name, asset.address, location.room.name, location.rack.name]
        .some(value => value.toLowerCase().includes(keyword)) ? [{ asset, location }] : []
    }).slice(0, 8)
  }, [assets, locations, search])
  const cells = useMemo(() => {
    if (!room) return []
    const byCell = new Map(racks.map(item => [item.row + ':' + item.column, item]))
    return Array.from({ length: room.columns * room.rows }, (_, index) => {
      const column = index % room.columns + 1
      const row = Math.floor(index / room.columns) + 1
      const key = row + ':' + column
      return { key, row, column, rack: byCell.get(key) }
    })
  }, [room, racks])
  const mountLocation = mountDraft?.assetId ? locations.get(mountDraft.assetId) : undefined

  useEffect(() => {
    if (roomId && !rooms.some(item => item.id === roomId)) {
      const next = rooms[0]?.id
      if (next !== undefined) onRoomChange(next)
    }
  }, [roomId, rooms, onRoomChange])

  useEffect(() => {
    if (!racks.some(item => item.id === rackId)) setRackId(racks[0]?.id ?? null)
  }, [racks, rackId])

  useEffect(() => {
    if (focus) showLocation(focus)
  }, [focus])

  function resetForms() {
    setRoomDraft(null)
    setRackDraft(null)
    setMountDraft(null)
    setError('')
    setFeedback('')
  }

  function selectRoom(id: number) {
    if (id === activeRoomId && roomId !== null) return
    resetForms()
    setRackDrawerOpen(false)
    onRoomChange(id)
    setRackId(layout.racks.find(item => item.roomId === id)?.id ?? null)
    setFocused(null)
  }

  function selectRack(id: number) {
    if (id === rackId) return
    resetForms()
    setRackId(id)
    setFocused(null)
  }

  function openRack(id: number) {
    selectRack(id)
    setRackDrawerOpen(true)
  }

  function closeRackDrawer() {
    setRackDrawerOpen(false)
    setMountDraft(null)
    setFeedback('')
  }

  function showLocation(location: AssetLocation) {
    resetForms()
    setRackDrawerOpen(false)
    onRoomChange(location.room.id)
    setRackId(location.rack.id)
    setFocused(location.placement.assetId)
    setView('3d')
    setSearch('')
  }

  function openSceneDevice(assetId: number, cabinetId: number) {
    selectRack(cabinetId)
    setFocused(assetId)
    onOpenAsset(assetId)
  }

  async function mutate<T>(action: () => Promise<T>, done: (result: T) => void, notice: string) {
    if (busy) return
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      const result = await action()
      await reload()
      done(result)
      setFeedback(notice)
    } catch (e) {
      if (e instanceof APIError && e.status === 401) onSessionError(e)
      else setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  function editRoom(value?: Room) {
    resetForms()
    setRoomDraft(value ? { ...value } : { name: '', columns: 8, rows: 6, version: 0 })
  }

  function saveRoom() {
    if (!roomDraft) return
    const { id, ...fields } = roomDraft
    void mutate(() => api<Room>(id ? '/rooms/' + id : '/rooms', id ? 'PUT' : 'POST', fields), saved => {
      onRoomChange(saved.id)
      setRoomDraft(null)
    }, '数据中心已保存')
  }

  function removeRoom(value: Room) {
    void mutate(() => api('/rooms/' + value.id + '?version=' + value.version, 'DELETE'), resetForms, '数据中心已删除')
  }

  function editRack(value?: Rack) {
    resetForms()
    const free = cells.find(cell => !cell.rack)
    if (value) setRackDraft({ ...value })
    else if (free) setRackDraft({ name: '', heightU: 42, column: free.column, row: free.row, rotation: 0, version: 0 })
    else setError('数据中心网格已占满，请先扩大布局')
  }

  function saveRack() {
    if (!rackDraft || !room) return
    const { id, name, heightU, column, row, rotation, version } = rackDraft
    const path = id ? '/racks/' + id : '/rooms/' + room.id + '/racks'
    void mutate(() => api<Rack>(path, id ? 'PUT' : 'POST', { name, heightU, column, row, rotation, version }), saved => {
      setRackId(saved.id)
      setRackDraft(null)
    }, '机柜已保存')
  }

  function removeRack(value: Rack) {
    void mutate(() => api('/racks/' + value.id + '?version=' + value.version, 'DELETE'), resetForms, '机柜已删除')
  }

  function startDrag(event: React.DragEvent, value: Rack) {
    if (!editable || busy || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    setDragRack(value.id)
    event.dataTransfer.setData('text/plain', String(value.id))
    event.dataTransfer.effectAllowed = 'move'
  }

  function allowDrop(event: React.DragEvent, occupied: boolean) {
    if (!dragRack || occupied || !editable || busy) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }

  function moveRack(event: React.DragEvent, column: number, row: number, occupied: boolean) {
    const item = racks.find(value => value.id === dragRack)
    setDragRack(null)
    if (!editable || busy || occupied || !item || event.dataTransfer?.getData('text/plain') !== String(item.id)) return
    event.preventDefault()
    const { name, heightU, rotation, version } = item
    void mutate(() => api<Rack>('/racks/' + item.id, 'PUT', { name, heightU, column, row, rotation, version }), saved => {
      setRackId(saved.id)
      setRackDraft(null)
    }, '机柜位置已更新')
  }

  function freePosition(units: number, ignore = 0) {
    if (!rack) return 1
    for (let start = 1; start + units - 1 <= rack.heightU; start++) {
      if (!devices.some(item => item.assetId !== ignore && start < item.startU + item.units && start + units > item.startU)) return start
    }
    return 1
  }

  function editMount(value?: Placement) {
    resetForms()
    const asset = value && byId.get(value.assetId)
    const canMove = asset && candidates.some(item => item.id === asset.id)
    if (value && !canMove) return
    setMountDraft({
      mode: value || candidates.length ? 'existing' : 'new',
      assetId: value?.assetId ?? 0,
      version: value?.version ?? 0,
      kind: 'host',
      name: '',
      address: '',
      startU: value?.startU ?? freePosition(1),
      units: value?.units ?? 1,
    })
  }

  function changeDevice(next = mountDraft) {
    if (!next) return
    const previous = mounted.get(next.assetId)
    setMountDraft({
      ...next,
      version: previous?.version ?? 0,
      units: previous?.units ?? 1,
      startU: previous?.rackId === rackId ? previous.startU : freePosition(previous?.units ?? 1, next.assetId),
    })
  }

  function changeMountMode(next = mountDraft) {
    if (!next) return
    if (next.mode === 'existing') {
      changeDevice(next)
    } else {
      const units = next.kind === 'switch' ? 1 : 2
      setMountDraft({ ...next, units, startU: freePosition(units) })
    }
  }

  function saveMount() {
    if (!mountDraft || !rack) return
    const { startU, units, mode, assetId, version, kind, name, address } = mountDraft
    const fields = { rackId: rack.id, startU, units }
    const create = mode === 'new'
    if (!create && !assetId) return
    void mutate(() => create
      ? api<Placement>('/placements', 'POST', { ...fields, newAsset: { kind, name, address } })
      : api<Placement>('/assets/' + assetId + '/placement', 'PUT', { ...fields, version }), placed => {
      setMountDraft(null)
      setFocused(placed.assetId)
    }, create || !version ? '设备已上架' : '设备位置已更新')
  }

  function unmountDevice(value: Placement) {
    void mutate(() => api('/assets/' + value.assetId + '/placement?version=' + value.version, 'DELETE'), () => {
      setMountDraft(null)
      if (focused === value.assetId) setFocused(null)
    }, '设备已下架')
  }

  function moveDevice(value: Placement, startU: number) {
    if (!rack) return
    void mutate(() => api<Placement>('/assets/' + value.assetId + '/placement', 'PUT', {
      rackId: rack.id, startU, units: value.units, version: value.version,
    }), placed => setFocused(placed.assetId), '设备位置已更新')
  }

  const mountForm = rack && mountDraft ? (
    <Form layout="inline" className="facility-form mount-form" onFinish={saveMount}>
      <Form.Item label="录入方式">
        <Select
          style={{ width: 150 }} value={mountDraft.mode}
          onChange={mode => changeMountMode({ ...mountDraft, mode })}
          options={[{ value: 'existing', label: '关联已有资产' }, { value: 'new', label: '新建资产并上架' }]}
        />
      </Form.Item>
      {mountDraft.mode === 'existing' ? (
        <>
          <Form.Item label="选择设备">
            <Select
              style={{ width: 250 }} value={mountDraft.assetId}
              onChange={assetId => changeDevice({ ...mountDraft, assetId })}
              options={[
                { value: 0, label: '请选择资产' },
                ...candidates.map(asset => ({
                  value: asset.id,
                  label: `${asset.name} · ${mountKinds[asset.kind as MountKind]} #${asset.id}${mounted.has(asset.id) ? ' · 已上架' : ''}`,
                })),
              ]}
            />
          </Form.Item>
          {mountLocation && <Form.Item label="当前位置">{locationLabel(mountLocation)}</Form.Item>}
        </>
      ) : (
        <>
          <Form.Item label="设备类型">
            <Select
              style={{ width: 110 }} value={mountDraft.kind}
              onChange={kind => changeMountMode({ ...mountDraft, kind })}
              options={Object.entries(mountKinds).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item label="设备名称"><Input value={mountDraft.name} maxLength={160} onChange={event => setMountDraft({ ...mountDraft, name: event.target.value })} /></Form.Item>
          <Form.Item label="管理地址 / IP"><Input value={mountDraft.address} maxLength={160} onChange={event => setMountDraft({ ...mountDraft, address: event.target.value })} /></Form.Item>
        </>
      )}
      <Form.Item label="起始 U 位"><InputNumber min={1} max={rack.heightU} value={mountDraft.startU} onChange={value => setMountDraft({ ...mountDraft, startU: value ?? 1 })} /></Form.Item>
      <Form.Item label="占用 U 数"><InputNumber min={1} max={rack.heightU} value={mountDraft.units} onChange={value => setMountDraft({ ...mountDraft, units: value ?? 1 })} /></Form.Item>
      <Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={busy} disabled={mountDraft.mode === 'existing' && !mountDraft.assetId}>
            {mountDraft.mode === 'existing' && mountDraft.version ? '保存位置' : '保存上架'}
          </Button>
          <Button onClick={() => setMountDraft(null)}>取消</Button>
        </Space>
      </Form.Item>
    </Form>
  ) : null

  return (
    <div className="facilities">
      <div className="facility-layout">
        <aside className="facility-sidebar">
          <div className="facility-sidebar-head">
            <div className="facility-sidebar-title">
              <ApartmentOutlined />
              <strong>数据中心</strong>
              <span>{rooms.length}</span>
            </div>
            {editable && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'add', label: '新增数据中心', icon: <PlusOutlined /> },
                    { key: 'edit', label: '编辑当前数据中心', icon: <EditOutlined />, disabled: !room },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'add') editRoom()
                    if (key === 'edit' && room) editRoom(room)
                  },
                }}
              >
                <Button type="text" size="small" icon={<MoreOutlined />} aria-label="数据中心操作" />
              </Dropdown>
            )}
          </div>
          <Input
            allowClear prefix={<SearchOutlined />} placeholder="搜索数据中心"
            value={roomSearch} onChange={event => setRoomSearch(event.target.value)}
          />
          <div className="facility-tree">
            {filteredRooms.map(item => {
              const count = layout.racks.filter(rack => rack.roomId === item.id).length
              return (
                <button
                  key={item.id} type="button"
                  className={`facility-tree-item${item.id === activeRoomId ? ' active' : ''}`}
                  title={`${item.name} · ${count} 台机柜`}
                  onClick={() => selectRoom(item.id)}
                >
                  <ClusterOutlined />
                  <span className="facility-tree-name">{item.name}</span>
                  <span className="facility-tree-count">{count}</span>
                </button>
              )
            })}
            {!filteredRooms.length && <div className="facility-tree-empty">暂无匹配的数据中心</div>}
          </div>
        </aside>

        <div className="facility-main">
      {error && <Alert type="error" showIcon message={error} />}
      {feedback && <Alert type="success" showIcon message={feedback} />}

      {!room ? (
        <Card variant="borderless">
          <Empty description="暂无数据中心">
            {editable && <Button type="primary" onClick={() => editRoom()}>新增数据中心</Button>}
          </Empty>
        </Card>
      ) : (
        <div className="facility-workspace">
          <div className="dc-summary">
            <div className="dc-stat">
              <div className="dc-stat-icon racks"><ClusterOutlined /></div>
              <div className="dc-stat-copy"><span>机柜数</span><strong>{racks.length}</strong><small>台机柜</small></div>
            </div>
            <div className="dc-stat">
              <div className="dc-stat-icon devices"><CloudServerOutlined /></div>
              <div className="dc-stat-copy"><span>设备数</span><strong>{roomPlacements.length}</strong><small>台设备</small></div>
            </div>
            <div className="dc-stat dc-stat-usage">
              <div className="dc-stat-icon usage"><PieChartOutlined /></div>
              <div className="dc-stat-copy"><span>利用率</span><strong>{roomUtilization}%</strong><small>已用 {usedRoomU}U · 空闲 {Math.max(0, totalRoomU - usedRoomU)}U</small></div>
              <Progress type="circle" percent={roomUtilization} size={64} strokeWidth={8} />
            </div>
          </div>

          <Card
            variant="borderless" className="floor-panel"
            title={<span>{room.name}</span>}
            extra={editable ? <Button size="small" type="primary" disabled={busy} onClick={() => editRack()}><PlusOutlined /> 新增机柜</Button> : null}
          >
            {rackDraft && (
              <Form layout="inline" className="facility-form rack-form" onFinish={saveRack}>
                <Form.Item label="机柜编号"><Input value={rackDraft.name} placeholder="例如：A-01" maxLength={80} onChange={event => setRackDraft({ ...rackDraft, name: event.target.value })} /></Form.Item>
                <Form.Item label="高度（U）"><InputNumber min={1} max={80} value={rackDraft.heightU} onChange={value => setRackDraft({ ...rackDraft, heightU: value ?? 1 })} /></Form.Item>
                <Form.Item label="列"><InputNumber min={1} max={room.columns} value={rackDraft.column} onChange={value => setRackDraft({ ...rackDraft, column: value ?? 1 })} /></Form.Item>
                <Form.Item label="行"><InputNumber min={1} max={room.rows} value={rackDraft.row} onChange={value => setRackDraft({ ...rackDraft, row: value ?? 1 })} /></Form.Item>
                <Form.Item label="朝向">
                  <Select
                    style={{ width: 100 }} value={rackDraft.rotation}
                    onChange={value => setRackDraft({ ...rackDraft, rotation: value })}
                    options={[{ value: 0, label: '向下' }, { value: 90, label: '向左' }, { value: 180, label: '向上' }, { value: 270, label: '向右' }]}
                  />
                </Form.Item>
                <Form.Item>
                  <Space>
                    <Button type="primary" htmlType="submit" loading={busy}>保存机柜</Button>
                    <Button onClick={() => setRackDraft(null)}>取消</Button>
                    {rackDraft.id && rack?.id === rackDraft.id && !devices.length && (
                      <Popconfirm title="删除该空机柜？" okText="删除" cancelText="取消" onConfirm={() => removeRack(rack)}>
                        <Button danger disabled={busy}>删除空机柜</Button>
                      </Popconfirm>
                    )}
                  </Space>
                </Form.Item>
              </Form>
            )}

            <div className="floor-toolbar">
              <Space>
                <Button type={view === 'cards' ? 'primary' : 'default'} size="small" onClick={() => setView('cards')}><ClusterOutlined /> 机柜视图</Button>
                <Button type={view === 'floor' ? 'primary' : 'default'} size="small" onClick={() => setView('floor')}><TableOutlined /> 平面布局</Button>
                <Button type={view === '3d' ? 'primary' : 'default'} size="small" onClick={() => setView('3d')}><AppstoreOutlined /> 3D 总览</Button>
              </Space>
              <Space wrap>
                {view === 'cards' ? (
                  <Input
                    style={{ width: 300 }} allowClear placeholder="搜索机柜名称…"
                    prefix={<SearchOutlined />} value={rackKeyword} onChange={event => setRackKeyword(event.target.value)}
                  />
                ) : (
                  <Input
                    style={{ width: 300 }} allowClear placeholder="搜索已上架资产、数据中心或机柜…"
                    prefix={<SearchOutlined />} value={search} onChange={event => setSearch(event.target.value)}
                  />
                )}
                {view !== 'cards' && racks.length > 0 && (
                  <Space>
                    <span className="muted">机柜</span>
                    <Select
                      style={{ width: 140 }} value={rackId ?? undefined} disabled={busy} onChange={openRack}
                      options={racks.map(item => ({ value: item.id, label: item.name }))}
                    />
                  </Space>
                )}
              </Space>
            </div>

            {view !== 'cards' && search.trim() && (
              <List
                className="location-results" size="small" dataSource={searchResults}
                locale={{ emptyText: '暂无匹配的上架位置' }}
                renderItem={({ asset, location }) => (
                  <List.Item>
                    <Button type="link" className="location-result" onClick={() => showLocation(location)}>
                      <strong>{asset.name}</strong><span className="muted">{locationLabel(location)}</span>
                    </Button>
                  </List.Item>
                )}
              />
            )}

            {view === 'cards' ? (
              <RackCardGrid
                racks={racks} placements={roomPlacements} assets={byId}
                keyword={rackKeyword} onOpen={openRack}
              />
            ) : view === 'floor' ? (
              <div className="floor-scroll">
                <div className="floor-grid" style={{ gridTemplateColumns: `repeat(${room.columns}, minmax(54px, 1fr))` }}>
                  {cells.map(cell => (
                    <div
                      key={cell.key} className={`floor-cell${dragRack && !cell.rack ? ' drop-cell' : ''}`}
                      title={`第 ${cell.row} 行，第 ${cell.column} 列`}
                      onDragOver={event => allowDrop(event, !!cell.rack)}
                      onDrop={event => moveRack(event, cell.column, cell.row, !!cell.rack)}
                    >
                      {cell.rack ? (
                        <button
                          className="rack-tile" type="button" aria-pressed={cell.rack.id === rackId}
                          draggable={editable && !busy} onClick={() => openRack(cell.rack!.id)}
                          onDragStart={event => startDrag(event, cell.rack!)} onDragEnd={() => setDragRack(null)}
                        >
                          <CloudServerOutlined />
                          <strong>{cell.rack.name}</strong>
                          <span className="rack-direction" aria-hidden="true" style={{ transform: `rotate(${cell.rack.rotation}deg)` }}>↓</span>
                        </button>
                      ) : <span className="muted cell-dot" aria-hidden="true">·</span>}
                    </div>
                  ))}
                </div>
                {editable && racks.length > 0 && <p className="floor-hint muted">拖动机柜到空格；点击机柜打开机柜视图，拖动设备调整 U 位。</p>}
              </div>
            ) : (
              <RoomScene
                room={room} racks={racks} placements={roomPlacements} assets={byId}
                selectedRack={rackId} selectedAsset={focused} dark={dark}
                onRack={openRack} onDevice={openSceneDevice}
              />
            )}
          </Card>

        </div>
      )}
        </div>
      </div>
      <Modal
        open={!!roomDraft} title={roomDraft?.id ? '编辑数据中心' : '新增数据中心'}
        footer={null} width={520} destroyOnHidden
        onCancel={() => setRoomDraft(null)}
      >
        {roomDraft && (
          <Form layout="vertical" onFinish={saveRoom}>
            <Form.Item
              label="数据中心名称" required
              rules={[{ required: true, message: '请输入数据中心名称' }]}
            >
              <Input
                value={roomDraft.name} placeholder="例如：北京数据中心" maxLength={160}
                onChange={event => setRoomDraft({ ...roomDraft, name: event.target.value })}
              />
            </Form.Item>
            <div className="room-modal-actions">
              <Space>
                <Button type="primary" htmlType="submit" loading={busy}>保存数据中心</Button>
                <Button onClick={() => setRoomDraft(null)}>取消</Button>
                {roomDraft.id && room?.id === roomDraft.id && !racks.length && (
                  <Popconfirm title="删除该空数据中心？" okText="删除" cancelText="取消" onConfirm={() => removeRoom(room)}>
                    <Button danger disabled={busy}>删除空数据中心</Button>
                  </Popconfirm>
                )}
              </Space>
            </div>
          </Form>
        )}
      </Modal>

      <RackDetailDrawer
        open={rackDrawerOpen} rack={rack ?? null} room={room ?? null}
        devices={devices} assets={byId} editable={editable} busy={busy}
        focused={focused} feedback={feedback} error={error} mountForm={mountForm}
        onClose={closeRackDrawer} onOpenAsset={onOpenAsset}
        onEditRack={value => { setRackDrawerOpen(false); editRack(value) }}
        onMount={() => editMount()}
        onEditPlacement={value => editMount(value)}
        onUnmount={unmountDevice} onMove={moveDevice}
      />
    </div>
  )
}
