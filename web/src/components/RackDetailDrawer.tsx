import { useState, type ReactNode } from 'react'
import {
  Alert, Button, Descriptions, Drawer, Empty, List, Popconfirm, Progress, Space, Tabs, Tag,
} from 'antd'
import {
  CloseOutlined, DeleteOutlined, EditOutlined, MenuOutlined, PlusOutlined, SettingOutlined, StarFilled, StarOutlined,
} from '@ant-design/icons'
import type { Asset } from '../api'
import { mountKinds, occupiedUnits, placementFaceLabel, uRange } from '../facilities'
import type { MountKind, Placement, Rack, RackFace, Room } from '../facilities'
import { RackElevation } from './RackElevation'

interface Props {
  open: boolean
  rack: Rack | null
  room: Room | null
  devices: Placement[]
  assets: Map<number, Asset>
  editable: boolean
  busy: boolean
  focused: number | null
  feedback?: string
  error?: string
  mountForm?: ReactNode
  onClose: () => void
  onOpenAsset: (assetId: number) => void
  onEditRack: (rack: Rack) => void
  onMount: () => void
  onEditPlacement: (placement: Placement) => void
  onUnmount: (placement: Placement) => void
  onMove: (placement: Placement, startU: number) => void
  onMountAt: (startU: number, face: RackFace) => void
  bookmarked: boolean
  onToggleBookmark: () => void
}

function nameOf(assets: Map<number, Asset>, id: number) {
  return assets.get(id)?.name ?? '资产 #' + id
}

const statusLabels: Record<string, string> = {
  online: '在线', offline: '离线', running: '运行中', stopped: '已停止', paused: '已暂停', unknown: '未知',
}

function statusLabel(status?: string) {
  return status ? statusLabels[status] ?? status : '未知'
}

export function RackDetailDrawer({
  open, rack, room, devices, assets, editable, busy, focused, feedback, error, mountForm,
  onClose, onOpenAsset, onEditRack, onMount, onEditPlacement, onUnmount, onMove, onMountAt,
  bookmarked, onToggleBookmark,
}: Props) {
  const [tab, setTab] = useState('rack')
  if (!rack) return null

  const occupied = occupiedUnits(devices)
  const used = occupied.size
  const frontUsed = occupiedUnits(devices.filter(item => item.depth === 'full' || item.face === 'front')).size
  const rearUsed = occupiedUnits(devices.filter(item => item.depth === 'full' || item.face === 'rear')).size
  const percent = Math.round(used / rack.heightU * 100)
  const hostCount = devices.filter(item => assets.get(item.assetId)?.kind === 'host').length
  const switchCount = devices.filter(item => assets.get(item.assetId)?.kind === 'switch').length
  const fullDepthCount = devices.filter(item => item.depth === 'full').length
  const halfDepthCount = devices.length - fullDepthCount

  return (
    <Drawer
      open={open} onClose={onClose} placement="right" width="min(1020px, calc(100vw - 32px))"
      closable={false} maskClosable={!busy} rootClassName="rack-detail-drawer"
    >
      <div className="rack-drawer-shell">
        <header className="rack-drawer-head">
          <div className="rack-drawer-title">
            <span className="rack-drawer-icon"><MenuOutlined /></span>
            <div>
              <strong>{rack.name}</strong>
              <span>{room?.name ?? '未绑定数据中心'} · {rack.heightU}U 机柜</span>
            </div>
          </div>
          <div className="rack-drawer-actions">
            <Button icon={bookmarked ? <StarFilled /> : <StarOutlined />} onClick={onToggleBookmark}>{bookmarked ? '已收藏' : '收藏'}</Button>
            {editable && (
              <>
                <Button icon={<SettingOutlined />} disabled={busy} onClick={() => onEditRack(rack)}>编辑机柜</Button>
                <Button type="primary" icon={<PlusOutlined />} disabled={busy} onClick={onMount}>上架设备</Button>
              </>
            )}
            <Button type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="关闭" />
          </div>
        </header>

        {(error || feedback) && (
          <div className="rack-drawer-alert">
            {error ? <Alert type="error" showIcon message={error} /> : <Alert type="success" showIcon message={feedback} />}
          </div>
        )}

        <div className="rack-drawer-stats">
          <div><span>设备数</span><strong>{devices.length}</strong><small>台设备</small></div>
          <div><span>U 位总数</span><strong>{rack.heightU}</strong><small>U</small></div>
          <div><span>已使用</span><strong>{used}</strong><small>U</small></div>
          <div className="rack-drawer-usage">
            <div><span>利用率</span><strong>{percent}%</strong></div>
            <Progress percent={percent} showInfo={false} size="small" />
            <small>物理机 {hostCount} · 交换机 {switchCount} · 全深 {fullDepthCount}</small>
          </div>
        </div>

        <Tabs
          className="rack-drawer-tabs" activeKey={tab} onChange={setTab}
          items={[
            {
              key: 'rack',
              label: '机柜视图',
              children: (
                <div className="rack-drawer-tab">
                  {mountForm}
                  <RackElevation
                    rack={rack} devices={devices} assets={assets} focused={focused}
                    editable={editable} busy={busy} onOpen={onOpenAsset} onMove={onMove}
                    onMountAt={editable ? onMountAt : undefined}
                  />
                </div>
              ),
            },
            {
              key: 'devices',
              label: `设备列表${devices.length ? ` (${devices.length})` : ''}`,
              children: devices.length ? (
                <List
                  className="rack-drawer-devices" dataSource={devices}
                  renderItem={item => {
                    const asset = assets.get(item.assetId)
                    return (
                      <List.Item
                        actions={editable ? [
                          <Button key="edit" size="small" disabled={busy} onClick={() => onEditPlacement(item)}>调整</Button>,
                          <Popconfirm key="remove" title="下架该设备？资产台账会保留。" okText="下架" cancelText="取消" onConfirm={() => onUnmount(item)}>
                            <Button size="small" danger icon={<DeleteOutlined />} disabled={busy}>下架</Button>
                          </Popconfirm>,
                        ] : []}
                      >
                        <div className="rack-drawer-device">
                          <span className={`rack-drawer-device-dot ${asset?.status ?? ''}`} />
                          <div>
                            <Button type="link" onClick={() => onOpenAsset(item.assetId)}>{nameOf(assets, item.assetId)}</Button>
                            <span className="muted">
                              {asset ? mountKinds[asset.kind as MountKind] : '设备'} · {uRange(item)} · {placementFaceLabel(item)}
                            </span>
                          </div>
                          <Tag bordered={false}>{statusLabel(asset?.status)}</Tag>
                        </div>
                      </List.Item>
                    )
                  }}
                />
              ) : <Empty description="机柜内还没有设备" />,
            },
            {
              key: 'detail',
              label: '机柜详情',
              children: (
                <Descriptions className="rack-drawer-detail" bordered column={2} size="small"
                  items={[
                    { key: 'name', label: '机柜编号', children: rack.name },
                    { key: 'room', label: '所属数据中心', children: room?.name ?? '—' },
                    { key: 'height', label: '机柜高度', children: rack.heightU + 'U' },
                    { key: 'position', label: '平面位置', children: `第 ${rack.row} 行，第 ${rack.column} 列` },
                    { key: 'rotation', label: '朝向', children: rack.rotation + '°' },
                    { key: 'used', label: '已用 U 位', children: used + 'U' },
                    { key: 'front', label: '前视占用', children: frontUsed + 'U' },
                    { key: 'rear', label: '后视占用', children: rearUsed + 'U' },
                    { key: 'depth', label: '安装深度', children: `全深 ${fullDepthCount} · 半深 ${halfDepthCount}` },
                    { key: 'free', label: '剩余 U 位', children: (rack.heightU - used) + 'U' },
                    { key: 'rate', label: '利用率', children: percent + '%' },
                  ]}
                />
              ),
            },
          ]}
        />

        <footer className="rack-drawer-foot">
          <span><i className="rack-legend-dot host" />物理机</span>
          <span><i className="rack-legend-dot switch" />交换机</span>
          <Space size={4}><span className="rack-legend-dot" />空 U 位</Space>
          <span className="rack-drawer-foot-hint">拖动设备可调整 U 位，松开后保存</span>
        </footer>
      </div>
    </Drawer>
  )
}

