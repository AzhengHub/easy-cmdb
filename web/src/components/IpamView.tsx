import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, Empty, Form, Input, List, Modal, Popconfirm, Progress, Row,
  Select, Space, Statistic, Table, Tag,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { CloseOutlined, DownOutlined, EditOutlined, PlusOutlined, ReloadOutlined, RightOutlined, SearchOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { api, APIError } from '../api'
import type { Allocation, Asset, IPUsage, Subnet, SubnetDetail, SubnetFields, VLAN } from '../api'

interface Props {
  editable: boolean
  openSubnetId: number | null
  onSubnetOpened: () => void
  bookmarkedSubnets: number[]
  onToggleSubnetBookmark: (id: number) => void
  onSessionError: (error: unknown) => void
  onChanged: () => void
}

type SubnetDraft = SubnetFields & { id?: number; version?: number }

const subnetStatusMeta: Record<string, { label: string; color: string }> = {
  container: { label: '聚合', color: 'default' },
  active: { label: '启用', color: 'green' },
  reserved: { label: '预留', color: 'cyan' },
  deprecated: { label: '停用', color: 'default' },
}
const allocationStateMeta: Record<string, { label: string; color: string }> = {
  active: { label: '启用', color: 'green' },
  reserved: { label: '预留', color: 'cyan' },
  deprecated: { label: '停用', color: 'default' },
  dhcp: { label: 'DHCP', color: 'purple' },
  slaac: { label: 'SLAAC', color: 'purple' },
}
const sourceMeta: Record<string, { label: string; color: string }> = {
  gateway: { label: '网关', color: 'gold' },
  asset: { label: '资产地址', color: 'default' },
  allocated: { label: '手工分配', color: 'blue' },
}
const roleLabels: Record<string, string> = {
  loopback: '环回', secondary: '辅助', vip: 'VIP', vrrp: 'VRRP',
  hsrp: 'HSRP', glbp: 'GLBP', anycast: 'Anycast',
}
function sourceLabel(source: string) {
  return sourceMeta[source]?.label ?? source
}
function sourceColor(source: string) {
  return sourceMeta[source]?.color ?? 'default'
}
function stateLabel(state: string) {
  return allocationStateMeta[state]?.label ?? state
}
function stateColor(state: string) {
  return allocationStateMeta[state]?.color ?? 'default'
}
function count(value: number) {
  return value.toLocaleString('zh-CN')
}
function assetLabel(asset: Asset) {
  return `${asset.name}（${asset.kind === 'vm' ? '虚拟机' : asset.kind === 'switch' ? '交换机' : '物理机'}）`
}

interface SubnetNode {
  subnet: Subnet
  children: SubnetNode[]
  depth: number
}

interface SubnetRow {
  subnet: Subnet
  depth: number
  children: number
}

function ipv4Number(address: string): number | null {
  const parts = address.trim().split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function subnetRange(cidr: string): { start: number; end: number; prefix: number } | null {
  const [address, prefixText] = cidr.trim().split('/')
  if (!address || !prefixText) return null
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const ip = ipv4Number(address)
  if (ip === null) return null
  const size = 2 ** (32 - prefix)
  const start = Math.floor(ip / size) * size
  return { start, end: start + size - 1, prefix }
}

function buildSubnetTree(subnets: Subnet[]): SubnetNode[] {
  const entries = subnets.map(subnet => ({ subnet, range: subnetRange(subnet.cidr) }))
  entries.sort((left, right) => {
    if (left.range && right.range) {
      return left.range.prefix - right.range.prefix || left.range.start - right.range.start || left.subnet.name.localeCompare(right.subnet.name, 'zh-CN')
    }
    if (left.range) return -1
    if (right.range) return 1
    return left.subnet.name.localeCompare(right.subnet.name, 'zh-CN')
  })

  const nodes = new Map<number, SubnetNode>()
  for (const entry of entries) nodes.set(entry.subnet.id, { subnet: entry.subnet, children: [], depth: 0 })
  const roots: SubnetNode[] = []

  for (const entry of entries) {
    const node = nodes.get(entry.subnet.id)!
    let parent: SubnetNode | undefined
    if (entry.range) {
      for (const candidateEntry of entries) {
        if (candidateEntry.subnet.id === entry.subnet.id || !candidateEntry.range) continue
        if (candidateEntry.range.prefix >= entry.range.prefix) continue
        if (candidateEntry.range.start > entry.range.start || candidateEntry.range.end < entry.range.end) continue
        const candidate = nodes.get(candidateEntry.subnet.id)!
        if (!parent || candidateEntry.range.prefix > (subnetRange(parent.subnet.cidr)?.prefix ?? -1)) parent = candidate
      }
    }
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  function fillDepth(node: SubnetNode, depth: number) {
    node.depth = depth
    for (const child of node.children) fillDepth(child, depth + 1)
  }
  for (const root of roots) fillDepth(root, 0)
  return roots
}

function flattenSubnetTree(nodes: SubnetNode[], collapsed: Set<number>): SubnetRow[] {
  const rows: SubnetRow[] = []
  function visit(node: SubnetNode) {
    rows.push({ subnet: node.subnet, depth: node.depth, children: node.children.length })
    if (!collapsed.has(node.subnet.id)) for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return rows
}

export function IpamView({ editable, openSubnetId, onSubnetOpened, bookmarkedSubnets, onToggleSubnetBookmark, onSessionError, onChanged }: Props) {
  const [subnets, setSubnets] = useState<Subnet[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [vlans, setVLANs] = useState<VLAN[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<SubnetDetail | null>(null)
  const [draft, setDraft] = useState<SubnetDraft | null>(null)
  const [allocation, setAllocation] = useState({ ip: '', assetId: 0, label: '', notes: '', status: 'active', dnsName: '', role: '' })
  const [editingAllocation, setEditingAllocation] = useState<IPUsage | null>(null)
  const [allocationError, setAllocationError] = useState('')
  const [allocationForm] = Form.useForm()
  const [search, setSearch] = useState('')
  const [subnetSearch, setSubnetSearch] = useState('')
  const [subnetStatus, setSubnetStatus] = useState<string | undefined>()
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')

  const selected = subnets.find(item => item.id === selectedId) ?? null
  const subnetTree = useMemo(() => buildSubnetTree(subnets), [subnets])
  const subnetRows = useMemo(() => flattenSubnetTree(subnetTree, collapsed), [subnetTree, collapsed])
  const visibleSubnetRows = useMemo(() => {
    const query = subnetSearch.trim().toLowerCase()
    return subnetRows
      .filter(row => !subnetStatus || row.subnet.status === subnetStatus)
      .filter(row => !query || [row.subnet.name, row.subnet.cidr, row.subnet.gateway, row.subnet.vlan,
        row.subnet.vlanName, row.subnet.role].some(value => value?.toLowerCase().includes(query)))
      .map(row => query || subnetStatus ? ({ ...row, depth: 0, children: 0 }) : row)
  }, [subnetRows, subnetSearch, subnetStatus])
  const usage = useMemo(() => {
    const query = search.trim().toLowerCase()
    const rows = detail?.usedIps ?? []
    if (!query) return rows
    return rows.filter(row => [row.ip, row.assetName, row.label, row.notes, row.dnsName, row.role,
      sourceLabel(row.source), stateLabel(row.state)]
      .some(value => value?.toLowerCase().includes(query)))
  }, [detail, search])
  const utilization = detail && detail.usable > 0 ? Math.min(100, Math.round(detail.used / detail.usable * 100)) : 0
  const vlanOptions = useMemo(() => {
    const options = vlans.map(vlan => ({
      value: String(vlan.vid),
      label: `VLAN ${vlan.vid} · ${vlan.name}${vlan.status !== 'active' ? `（${subnetStatusMeta[vlan.status]?.label ?? vlan.status}）` : ''}`,
    }))
    if (draft?.vlan && !vlans.some(vlan => String(vlan.vid) === draft.vlan)) {
      options.push({ value: draft.vlan, label: `VLAN ${draft.vlan}（未登记）` })
    }
    return options
  }, [draft?.vlan, vlans])

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (openSubnetId == null) return
    void load(openSubnetId).then(() => onSubnetOpened())
  }, [openSubnetId])

  function report(e: unknown) {
    if (e instanceof APIError && e.status === 401) {
      onSessionError(e)
      return
    }
    setError(e instanceof Error ? e.message : '操作失败')
  }

  async function loadDetail(id: number | null) {
    if (!id) {
      setDetail(null)
      return
    }
    setDetail(await api<SubnetDetail>(`/subnets/${id}/addresses`))
  }

  async function load(preferredId?: number | null) {
    setLoading(true)
    setError('')
    try {
      const [nextSubnets, nextAssets, nextVLANs] = await Promise.all([
        api<Subnet[]>('/subnets'), api<Asset[]>('/assets'), api<VLAN[]>('/vlans'),
      ])
      setSubnets(nextSubnets)
      setAssets(nextAssets)
      setVLANs(nextVLANs)
      const wanted = preferredId === undefined ? selectedId : preferredId
      const nextId = nextSubnets.some(item => item.id === wanted) ? wanted : (nextSubnets[0]?.id ?? null)
      setSelectedId(nextId)
      await loadDetail(nextId)
    } catch (e) {
      report(e)
    } finally {
      setLoading(false)
    }
  }

  async function selectSubnet(id: number) {
    if (id === selectedId) return
    setSelectedId(id)
    setDraft(null)
    setError('')
    setFeedback('')
    try {
      await loadDetail(id)
    } catch (e) {
      report(e)
    }
  }

  function toggleSubnet(id: number) {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function addSubnet() {
    setDraft({ name: '', cidr: '', gateway: '', vlan: '', notes: '', status: 'active', role: '' })
    setFeedback('')
  }

  function editSubnet() {
    if (!selected) return
    setDraft({
      id: selected.id, version: selected.version, name: selected.name, cidr: selected.cidr,
      gateway: selected.gateway, vlan: selected.vlan, notes: selected.notes,
      status: selected.status, role: selected.role,
    })
  }

  async function saveSubnet() {
    if (!draft) return
    const wasEdit = !!draft.id
    setBusy(true)
    setError('')
    try {
      const body = {
        name: draft.name, cidr: draft.cidr, gateway: draft.gateway, vlan: draft.vlan,
        notes: draft.notes, status: draft.status, role: draft.role, version: draft.version ?? 0,
      }
      const saved = draft.id
        ? await api<Subnet>(`/subnets/${draft.id}`, 'PUT', body)
        : await api<Subnet>('/subnets', 'POST', body)
      setSelectedId(saved.id)
      setDraft(null)
      await load(saved.id)
      setFeedback(wasEdit ? '网段已更新' : '网段已创建')
      onChanged()
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }

  async function deleteSubnet() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      await api(`/subnets/${selected.id}?version=${selected.version}`, 'DELETE')
      setSelectedId(null)
      await load()
      setFeedback('网段已删除')
      onChanged()
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }

  async function allocate() {
    if (!detail) return
    if (!allocation.ip.trim()) {
      setError('请填写要分配的 IP 地址')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/subnets/${detail.id}/allocations`, 'POST', {
        ip: allocation.ip.trim(), assetId: allocation.assetId || 0,
        label: allocation.label.trim(), notes: allocation.notes.trim(),
        status: allocation.status, dnsName: allocation.dnsName.trim(), role: allocation.role,
      })
      setAllocation({ ip: '', assetId: 0, label: '', notes: '', status: 'active', dnsName: '', role: '' })
      await load()
      setFeedback('IP 已分配')
      onChanged()
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }

  function editAllocation(row: IPUsage) {
    setEditingAllocation(row)
    setError('')
    setAllocationError('')
    allocationForm.setFieldsValue({
      status: row.state, dnsName: row.dnsName ?? '', role: row.role ?? '',
      assetId: row.assetId || undefined, label: row.label ?? '', notes: row.notes ?? '',
    })
  }

  async function updateAllocation() {
    if (!editingAllocation?.allocationId) return
    const values = await allocationForm.validateFields()
    setBusy(true)
    setAllocationError('')
    try {
      await api<Allocation>(`/allocations/${editingAllocation.allocationId}`, 'PUT', {
        ip: editingAllocation.ip,
        assetId: values.assetId ?? 0,
        label: values.label ?? '',
        notes: values.notes ?? '',
        status: values.status,
        dnsName: values.dnsName ?? '',
        role: values.role ?? '',
        version: editingAllocation.version ?? 0,
      })
      setEditingAllocation(null)
      await load()
      setFeedback('IP 地址记录已更新')
      onChanged()
    } catch (e) {
      if (e instanceof APIError && e.status === 401) onSessionError(e)
      else setAllocationError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function release(row: IPUsage) {
    if (!row.allocationId || !row.version) return
    setBusy(true)
    setError('')
    try {
      await api(`/allocations/${row.allocationId}?version=${row.version}`, 'DELETE')
      await load()
      setFeedback('IP 已释放')
      onChanged()
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }

  const usageColumns: TableColumnsType<IPUsage> = [
    { title: 'IP 地址', dataIndex: 'ip', key: 'ip', width: 135, render: value => <span className="mono">{value}</span> },
    { title: '来源', key: 'source', width: 96, render: (_, row) => <Tag color={sourceColor(row.source)}>{sourceLabel(row.source)}</Tag> },
    { title: '状态', key: 'state', width: 90, render: (_, row) => <Tag color={stateColor(row.state)}>{stateLabel(row.state)}</Tag> },
    { title: 'DNS 名称', dataIndex: 'dnsName', key: 'dnsName', width: 160, render: value => value ? <span className="mono">{value}</span> : '—' },
    {
      title: '资产 / 标签', key: 'owner',
      render: (_, row) => (
        <span>
          {row.assetName || row.label || '—'}
          {row.assetName && row.label && <span className="muted"> / {row.label}</span>}
        </span>
      ),
    },
    { title: '角色', dataIndex: 'role', key: 'role', width: 80, render: value => roleLabels[value] ?? (value || '—') },
    { title: '备注', dataIndex: 'notes', key: 'notes', render: value => value || '—' },
    ...(editable ? [{
      title: '操作', key: 'actions', width: 110,
      render: (_: unknown, row: IPUsage) => row.source === 'allocated' ? (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => editAllocation(row)}>编辑</Button>
          <Popconfirm title="释放该 IP？" okText="释放" cancelText="取消" onConfirm={() => void release(row)}>
            <Button type="link" size="small" danger>释放</Button>
          </Popconfirm>
        </Space>
      ) : null,
    }] : []),
  ]

  return (
    <Card
      variant="borderless" className="ipam-card"
      title={<Space><span>网段与 IP 地址</span><Tag>{subnets.length} 个网段</Tag></Space>}
      extra={(
        <Space>
          <Button loading={loading} onClick={() => void load()}><ReloadOutlined /> 刷新</Button>
          {editable && <Button type="primary" onClick={addSubnet}><PlusOutlined /> 新增网段</Button>}
        </Space>
      )}
    >
      {error && <Alert type="error" showIcon closable message={error} className="ipam-alert" onClose={() => setError('')} />}
      {feedback && <Alert type="success" showIcon closable message={feedback} className="ipam-alert" onClose={() => setFeedback('')} />}

      {draft && (
        <Card
          size="small" className="edit-card" title={draft.id ? '编辑网段' : '新增网段'}
          extra={<Button type="text" size="small" onClick={() => setDraft(null)}><CloseOutlined /></Button>}
        >
          <Form layout="vertical" onFinish={() => void saveSubnet()}>
            <Row gutter={12}>
              <Col span={12}><Form.Item label="网段名称" required><Input value={draft.name} maxLength={160} placeholder="例如：办公网" onChange={event => setDraft({ ...draft, name: event.target.value })} /></Form.Item></Col>
              <Col span={12}><Form.Item label="CIDR" required><Input value={draft.cidr} maxLength={64} placeholder="例如：192.168.10.0/24" onChange={event => setDraft({ ...draft, cidr: event.target.value })} /></Form.Item></Col>
              <Col span={12}>
                <Form.Item label="状态">
                  <Select
                    value={draft.status} onChange={value => setDraft({ ...draft, status: value })}
                    options={Object.entries(subnetStatusMeta).map(([value, meta]) => ({ value, label: meta.label }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}><Form.Item label="用途 / 角色"><Input value={draft.role} maxLength={80} placeholder="例如：办公、服务器、互联" onChange={event => setDraft({ ...draft, role: event.target.value })} /></Form.Item></Col>
              <Col span={12}>
                <Form.Item label="VLAN" extra={!vlans.length ? '请先在「VLAN」页面登记 VLAN' : undefined}>
                  <Select
                    allowClear showSearch optionFilterProp="label" value={draft.vlan || undefined}
                    placeholder="可选" options={vlanOptions}
                    onChange={value => setDraft({ ...draft, vlan: value ?? '' })}
                  />
                </Form.Item>
              </Col>
              <Col span={12}><Form.Item label="网关"><Input value={draft.gateway} maxLength={64} placeholder="例如：192.168.10.1" onChange={event => setDraft({ ...draft, gateway: event.target.value })} /></Form.Item></Col>
              <Col span={24}><Form.Item label="备注"><Input.TextArea value={draft.notes} rows={2} maxLength={2000} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></Form.Item></Col>
            </Row>
            <Space>
              <Button type="primary" htmlType="submit" loading={busy}>保存网段</Button>
              <Button onClick={() => setDraft(null)}>取消</Button>
            </Space>
          </Form>
        </Card>
      )}

      {loading && !subnets.length ? <Empty description="正在加载 IPAM 数据…" /> : !subnets.length ? (
        <Empty description="暂无网段，新增一个网段开始管理 IP 地址" />
      ) : (
        <div className="ipam-layout">
          <div className="subnet-pane">
            <Input
              allowClear prefix={<SearchOutlined />} placeholder="搜索名称、CIDR、VLAN、用途"
              value={subnetSearch} onChange={event => setSubnetSearch(event.target.value)}
            />
            <Select
              allowClear placeholder="全部状态" value={subnetStatus}
              onChange={setSubnetStatus}
              options={Object.entries(subnetStatusMeta).map(([value, meta]) => ({ value, label: meta.label }))}
            />
            <List
              dataSource={visibleSubnetRows} split={false} className="subnet-list" loading={loading}
              locale={{ emptyText: '没有匹配的网段' }}
            renderItem={({ subnet: item, depth, children }) => (
              <List.Item
                key={item.id}
                className={`subnet-item${item.id === selectedId ? ' active' : ''}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                onClick={() => void selectSubnet(item.id)}
              >
                <div className="subnet-content">
                  <div className="subnet-head">
                    <Space size={2}>
                      {children > 0 ? (
                        <Button
                          type="text" size="small" className="subnet-tree-toggle"
                          aria-label={collapsed.has(item.id) ? '展开子网' : '收起子网'}
                          icon={collapsed.has(item.id) ? <RightOutlined /> : <DownOutlined />}
                          onClick={event => { event.stopPropagation(); toggleSubnet(item.id) }}
                        />
                      ) : <span className="subnet-tree-spacer" />}
                      <strong>{item.name}</strong>
                      {children > 0 && <span className="subnet-child-count">{children}</span>}
                    </Space>
                    <Tag className="mono">{item.cidr}</Tag>
                  </div>
                  <span className="muted">
                    {subnetStatusMeta[item.status]?.label ?? item.status}
                    {item.role ? ` · ${item.role}` : ''}
                    {' · '}VLAN {item.vlan ? (item.vlanName ? `${item.vlan} ${item.vlanName}` : item.vlan) : '—'}
                    {' · '}已用 {count(item.used)} / {count(item.usable)} · 空闲 {count(item.free)}
                  </span>
                  <Progress percent={item.usable > 0 ? Math.round(item.used / item.usable * 100) : 0} size="small" showInfo={false} />
                </div>
              </List.Item>
            )}
          />
          </div>

          <div className="subnet-detail">
            {detail ? (
              <>
                <div className="detail-head">
                  <div>
                    <h2>{detail.name}</h2>
                    <Space size={4} wrap className="detail-tags">
                      <Tag color={subnetStatusMeta[detail.status]?.color}>{subnetStatusMeta[detail.status]?.label ?? detail.status}</Tag>
                      {detail.role && <Tag>{detail.role}</Tag>}
                      {detail.vlan && <Tag color={subnetStatusMeta[detail.vlanStatus ?? '']?.color ?? 'blue'}>VLAN {detail.vlan}{detail.vlanName ? ` · ${detail.vlanName}` : ''}</Tag>}
                    </Space>
                    <div className="muted mono subnet-cidr-line">{detail.cidr} · 网关 {detail.gateway || '—'}</div>
                  </div>
                  <Space>
                    <Button
                      size="small"
                      icon={bookmarkedSubnets.includes(detail.id) ? <StarFilled /> : <StarOutlined />}
                      onClick={() => onToggleSubnetBookmark(detail.id)}
                    >{bookmarkedSubnets.includes(detail.id) ? '已收藏' : '收藏'}</Button>
                    {editable && (
                      <>
                        <Button size="small" onClick={editSubnet}>编辑</Button>
                        <Popconfirm title="确定删除该网段？" okText="删除" cancelText="取消" onConfirm={() => void deleteSubnet()}>
                          <Button size="small" danger loading={busy}>删除</Button>
                        </Popconfirm>
                      </>
                    )}
                  </Space>
                </div>
                {detail.notes && <p className="muted">{detail.notes}</p>}

                <Row gutter={12}>
                  <Col span={8}><Card size="small"><Statistic title="可用地址" value={detail.usable} /></Card></Col>
                  <Col span={8}><Card size="small"><Statistic title="已占用" value={detail.used} /></Card></Col>
                  <Col span={8}><Card size="small"><Statistic title="空闲" value={detail.free} /></Card></Col>
                </Row>
                <Progress percent={utilization} size="small" className="usage-progress" />

                {editable && (
                  <Card size="small" title="分配 IP" className="allocate-card">
                    <Form layout="vertical" onFinish={() => void allocate()}>
                      <Row gutter={12}>
                        <Col span={12}><Form.Item label="IP 地址"><Input value={allocation.ip} maxLength={64} placeholder="例如：192.168.10.20" onChange={event => setAllocation({ ...allocation, ip: event.target.value })} /></Form.Item></Col>
                        <Col span={12}>
                          <Form.Item label="关联资产">
                            <Select
                              allowClear showSearch optionFilterProp="label" value={allocation.assetId || undefined}
                              placeholder="不关联资产" onChange={value => setAllocation({ ...allocation, assetId: value ?? 0 })}
                              options={assets.map(asset => ({ value: asset.id, label: assetLabel(asset) }))}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="状态">
                            <Select
                              value={allocation.status} onChange={value => setAllocation({ ...allocation, status: value })}
                              options={Object.entries(allocationStateMeta).map(([value, meta]) => ({ value, label: meta.label }))}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item label="角色">
                            <Select
                              allowClear value={allocation.role || undefined} placeholder="可选"
                              onChange={value => setAllocation({ ...allocation, role: value ?? '' })}
                              options={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}><Form.Item label="DNS 名称"><Input className="mono" value={allocation.dnsName} maxLength={255} placeholder="例如：db-01.example.test" onChange={event => setAllocation({ ...allocation, dnsName: event.target.value })} /></Form.Item></Col>
                        <Col span={12}><Form.Item label="标签"><Input value={allocation.label} maxLength={160} placeholder="例如：VIP" onChange={event => setAllocation({ ...allocation, label: event.target.value })} /></Form.Item></Col>
                        <Col span={24}><Form.Item label="备注"><Input value={allocation.notes} maxLength={2000} onChange={event => setAllocation({ ...allocation, notes: event.target.value })} /></Form.Item></Col>
                      </Row>
                      <Space>
                        <Button type="primary" htmlType="submit" loading={busy}>分配</Button>
                        <Button
                          disabled={!detail.freeIps.length}
                          onClick={() => setAllocation({ ...allocation, ip: detail.freeIps[0] ?? '' })}
                        >使用下一个空闲 IP</Button>
                      </Space>
                    </Form>
                  </Card>
                )}

                <div className="section-head">
                  <h3>已占用 IP</h3>
                  <Input
                    className="usage-search" allowClear placeholder="搜索 IP、DNS、资产、角色或标签"
                    prefix={<SearchOutlined />} value={search}
                    onChange={event => setSearch(event.target.value)}
                  />
                </div>
                <Table<IPUsage>
                  columns={usageColumns} dataSource={usage} rowKey="ip" pagination={false}
                  size="small" scroll={{ y: 300 }} locale={{ emptyText: '没有匹配的已占用 IP' }}
                />

                <div className="section-head">
                  <h3>空闲 IP</h3>
                  <span className="muted">显示前 {detail.freeIps.length} 个 / 共 {count(detail.free)} 个</span>
                </div>
                <Space wrap>
                  {detail.freeIps.map(ip => (
                    <Button key={ip} size="small" className="mono" disabled={!editable} onClick={() => setAllocation({ ...allocation, ip })}>{ip}</Button>
                  ))}
                </Space>
                {!detail.freeIps.length && <Empty description="该网段已无空闲 IP" />}
              </>
            ) : <Empty description="选择左侧网段查看地址" />}
          </div>
        </div>
      )}

      <Modal
        open={!!editingAllocation} title={editingAllocation ? `编辑 ${editingAllocation.ip}` : '编辑 IP 地址'}
        footer={null} width={560} destroyOnHidden maskClosable={!busy}
        onCancel={() => { if (!busy) { setEditingAllocation(null); setAllocationError('') } }}
      >
        {allocationError && <Alert type="error" showIcon message={allocationError} className="bulk-alert" />}
        <Form form={allocationForm} layout="vertical" onFinish={() => void updateAllocation()}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="状态" name="status" rules={[{ required: true }]}>
                <Select options={Object.entries(allocationStateMeta).map(([value, meta]) => ({ value, label: meta.label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="角色" name="role">
                <Select allowClear placeholder="可选" options={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="DNS 名称" name="dnsName">
                <Input className="mono" maxLength={255} placeholder="例如：db-01.example.test" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="关联资产" name="assetId">
                <Select
                  allowClear showSearch optionFilterProp="label" placeholder="不关联资产"
                  options={assets.map(asset => ({ value: asset.id, label: assetLabel(asset) }))}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="标签 / 用途" name="label">
                <Input maxLength={160} placeholder="例如：VIP、数据库主地址" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="备注" name="notes">
                <Input.TextArea rows={2} maxLength={2000} />
              </Form.Item>
            </Col>
          </Row>
          <div className="bulk-modal-actions">
            <Space>
              <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
              <Button disabled={busy} onClick={() => { setEditingAllocation(null); setAllocationError('') }}>取消</Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </Card>
  )
}
