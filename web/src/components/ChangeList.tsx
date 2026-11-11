import { useMemo, useState } from 'react'
import { Button, Empty, Input, Select, Space, Tag, Timeline } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import type { Change } from '../api'

interface Props {
  changes: Change[]
  hideAsset?: boolean
  filterable?: boolean
  onOpen?: (id: number) => void
}

const actionLabels: Record<string, string> = {
  create: '创建', update: '编辑', discover: '自动发现', sync: '配置同步', move: '宿主机变更',
  tags: '标签变更',
  missing: '连续未发现', link: '关联资源', unlink: '解除关系',
  room_create: '新增数据中心', room_update: '编辑数据中心', room_delete: '删除数据中心',
  rack_create: '新增机柜', rack_update: '编辑机柜', rack_delete: '删除机柜',
  mount: '设备上架', relocate: '上架位置变更', unmount: '设备下架',
  subnet_create: '新增网段', subnet_update: '编辑网段', subnet_delete: '删除网段',
  ip_allocate: '分配 IP', ip_update: '编辑 IP', ip_release: '释放 IP',
  vlan_create: '新增 VLAN', vlan_update: '编辑 VLAN', vlan_delete: '删除 VLAN',
  user_create: '新增账号', user_update: '编辑账号', user_delete: '删除账号',
}
const fieldLabels: Record<string, string> = {
  name: '名称', status: '状态', lifecycle: '生命周期', platform: '平台', owner: '负责人',
  environment: '环境', address: '地址', cpu: 'CPU', memoryMiB: '内存（MiB）', notes: '备注',
  attributes: '扩展属性', observed: '采集信息', missingCount: '缺失次数',
  columns: '数据中心列数', rows: '数据中心行数', heightU: '机柜高度（U）', column: '机柜所在列', row: '机柜所在行', rotation: '朝向',
  cidr: 'CIDR', gateway: '网关', vlan: 'VLAN', ip: 'IP 地址', assetId: '关联资产', label: '标签',
  role: '角色', dnsName: 'DNS 名称', vid: 'VLAN ID', description: '描述', roomId: '所属数据中心',
  face: '安装面', depth: '安装深度', passwordReset: '重置密码',
}
const userRoleLabels: Record<string, string> = { admin: '管理员', operator: '运维', viewer: '只读' }
const relationLabels: Record<string, string> = { hosts: '承载' }

function summary(change: Change) {
  if (change.action === 'tags') {
    const before = Array.isArray(change.before) ? change.before.map(String) : []
    const after = Array.isArray(change.after) ? change.after.map(String) : []
    const added = after.filter(name => !before.includes(name))
    const removed = before.filter(name => !after.includes(name))
    return [
      added.length ? `新增：${added.join('、')}` : '',
      removed.length ? `移除：${removed.join('、')}` : '',
    ].filter(Boolean).join(' · ') || '标签未变化'
  }
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
  if (change.action === 'ip_allocate' || change.action === 'ip_update' || change.action === 'ip_release') {
    const allocation = change.after ?? change.before
    return [allocation?.ip, allocation?.dnsName, allocation?.assetName || allocation?.label]
      .filter(Boolean).map(String).join(' · ')
  }
  if (change.action.startsWith('vlan_')) {
    const vlan = change.after ?? change.before
    return [vlan?.vid ? `VLAN ${vlan.vid}` : '', vlan?.name, vlan?.description]
      .filter(Boolean).map(String).join(' · ')
  }
  if (change.action.startsWith('user_')) {
    const user = change.after ?? change.before
    return [
      user?.username,
      userRoleLabels[String(user?.role)] ?? user?.role,
      change.after?.passwordReset ? '已重置密码' : '',
    ].filter(Boolean).map(String).join(' · ')
  }
  if (change.action === 'mount' || change.action === 'relocate' || change.action === 'unmount') {
    const position = (value: Change['before']) => {
      if (!value) return ''
      const start = Number(value.startU)
      const end = start + Number(value.units) - 1
      const units = start === end ? 'U' + start : 'U' + start + '–U' + end
      const mounting = [value.face === 'rear' ? '后面' : '前面', value.depth === 'half' ? '半深' : '全深'].join(' · ')
      return [value.roomName, value.rackName, units, mounting].join(' / ')
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
  if (!change.before || !change.after ||
    !['update', 'sync', 'room_update', 'rack_update', 'subnet_update', 'ip_update', 'vlan_update', 'user_update'].includes(change.action)) return []
  const ignored = new Set(['id', 'version', 'subnetId', 'assetId', 'assetName', 'subnetName'])
  return Object.entries(change.after)
    .filter(([key, after]) => !ignored.has(key) && display(change.before?.[key]) !== display(after))
    .map(([key, after]) => ({ field: fieldLabels[key] ?? key, before: display(change.before?.[key]), after: display(after) }))
}

function date(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function csvCell(value: string | number) {
  const text = String(value)
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
}

function downloadChanges(changes: Change[]) {
  const rows: (string | number)[][] = [['时间', '动作', '资产', '操作人', '摘要', '变更字段']]
  for (const change of changes) {
    rows.push([
      date(change.createdAt),
      actionLabels[change.action] ?? change.action,
      change.assetName,
      change.actor,
      summary(change),
      differences(change).map(diff => `${diff.field}: ${diff.before} → ${diff.after}`).join('; '),
    ])
  }
  const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'dc-db-changes.csv'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ChangeList({ changes, hideAsset, filterable, onOpen }: Props) {
  const [keyword, setKeyword] = useState('')
  const [action, setAction] = useState<string | undefined>()
  const actions = useMemo(() => Array.from(new Set(changes.map(change => change.action)))
    .sort((left, right) => (actionLabels[left] ?? left).localeCompare(actionLabels[right] ?? right, 'zh-CN')), [changes])
  const visible = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return changes.filter(change => {
      if (action && change.action !== action) return false
      if (!query) return true
      return [change.assetName, change.actor, actionLabels[change.action] ?? change.action, summary(change)]
        .some(value => value?.toLowerCase().includes(query))
    })
  }, [action, changes, keyword])

  if (!changes.length) return <Empty description="暂无变更记录" />

  return (
    <>
      {filterable && (
        <div className="change-toolbar">
          <Space wrap>
            <Input
              allowClear style={{ width: 280 }} placeholder="搜索资产、操作人或动作"
              value={keyword} onChange={event => setKeyword(event.target.value)}
            />
            <Select
              allowClear style={{ width: 160 }} placeholder="全部动作" value={action}
              onChange={setAction}
              options={actions.map(item => ({ value: item, label: actionLabels[item] ?? item }))}
            />
            <span className="muted">共 {visible.length} 条</span>
            <Button icon={<DownloadOutlined />} disabled={!visible.length} onClick={() => downloadChanges(visible)}>导出当前结果</Button>
          </Space>
        </div>
      )}
      {visible.length === 0 ? <Empty description="没有匹配的变更记录" /> : (
        <Timeline
          items={visible.map(change => ({
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
      )}
    </>
  )
}
