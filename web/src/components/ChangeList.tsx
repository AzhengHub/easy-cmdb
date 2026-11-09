import { Button, Empty, Tag, Timeline } from 'antd'
import type { Change } from '../api'

interface Props {
  changes: Change[]
  hideAsset?: boolean
  onOpen?: (id: number) => void
}

const actionLabels: Record<string, string> = {
  create: '创建', update: '编辑', discover: '自动发现', sync: '配置同步', move: '宿主机变更',
  missing: '连续未发现', link: '关联资源', unlink: '解除关系',
  room_create: '新增数据中心', room_update: '编辑数据中心', room_delete: '删除数据中心',
  rack_create: '新增机柜', rack_update: '编辑机柜', rack_delete: '删除机柜',
  mount: '设备上架', relocate: '上架位置变更', unmount: '设备下架',
  subnet_create: '新增网段', subnet_update: '编辑网段', subnet_delete: '删除网段',
  ip_allocate: '分配 IP', ip_release: '释放 IP',
}
const fieldLabels: Record<string, string> = {
  name: '名称', status: '状态', lifecycle: '生命周期', platform: '平台', owner: '负责人',
  environment: '环境', address: '地址', cpu: 'CPU', memoryMiB: '内存（MiB）', notes: '备注',
  attributes: '扩展属性', observed: '采集信息', missingCount: '缺失次数',
  columns: '数据中心列数', rows: '数据中心行数', heightU: '机柜高度（U）', column: '机柜所在列', row: '机柜所在行', rotation: '朝向',
  cidr: 'CIDR', gateway: '网关', vlan: 'VLAN', ip: 'IP 地址', assetId: '关联资产', label: '标签',
}
const relationLabels: Record<string, string> = { hosts: '承载' }

function summary(change: Change) {
  if (change.action === 'move') return String(change.before?.fromName ?? '—') + ' → ' + String(change.after?.fromName ?? '—')
  if (change.action === 'link' || change.action === 'unlink') {
    const relation = change.after ?? change.before
    return String(relation?.fromName ?? '—') + ' · ' + (relationLabels[String(relation?.kind)] ?? '关系') + ' · ' + String(relation?.toName ?? '—')
  }
  if (change.action === 'missing') return '请核查平台中的资源状态'
  if (change.action.startsWith('subnet_')) {
    const subnet = change.after ?? change.before
    return [subnet?.name, subnet?.cidr].filter(Boolean).map(String).join(' · ')
  }
  if (change.action === 'ip_allocate' || change.action === 'ip_release') {
    const allocation = change.after ?? change.before
    return [allocation?.ip, allocation?.assetName || allocation?.label].filter(Boolean).map(String).join(' · ')
  }
  if (change.action === 'mount' || change.action === 'relocate' || change.action === 'unmount') {
    const position = (value: Change['before']) => {
      if (!value) return ''
      const start = Number(value.startU)
      const end = start + Number(value.units) - 1
      const units = start === end ? 'U' + start : 'U' + start + '–U' + end
      return [value.roomName, value.rackName, units].join(' / ')
    }
    return [position(change.before), position(change.after)].filter(Boolean).join(' → ')
  }
  return ''
}

function display(value: unknown): string {
  if (value === '' || value === undefined || value === null) return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function differences(change: Change) {
  if (!change.before || !change.after || !['update', 'sync', 'room_update', 'rack_update', 'subnet_update'].includes(change.action)) return []
  return Object.entries(change.after)
    .filter(([key, after]) => display(change.before?.[key]) !== display(after))
    .map(([key, after]) => ({ field: fieldLabels[key] ?? key, before: display(change.before?.[key]), after: display(after) }))
}

function date(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function ChangeList({ changes, hideAsset, onOpen }: Props) {
  if (!changes.length) return <Empty description="暂无变更记录" />

  return (
    <Timeline
      items={changes.map(change => ({
        color: 'blue',
        children: (
          <div>
            <div className="change-head">
              <Tag>{actionLabels[change.action] ?? change.action}</Tag>
              {!hideAsset && change.assetId ? (
                <Button type="link" size="small" onClick={() => onOpen?.(change.assetId)}>{change.assetName}</Button>
              ) : !hideAsset ? <strong>{change.assetName}</strong> : null}
              <span className="muted">{change.actor} · {date(change.createdAt)}</span>
            </div>
            {summary(change) && <p className="change-summary">{summary(change)}</p>}
            {differences(change).map(diff => (
              <div key={diff.field} className="change-field">
                <span className="muted">{diff.field}</span>
                <del>{diff.before}</del>
                <span aria-hidden="true">→</span>
                <ins>{diff.after}</ins>
              </div>
            ))}
          </div>
        ),
      }))}
    />
  )
}
