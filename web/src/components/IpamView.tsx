import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, Empty, Form, Input, List, Popconfirm, Progress, Row,
  Select, Space, Statistic, Table, Tag,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { CloseOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { api, APIError } from '../api'
import type { Asset, IPUsage, Subnet, SubnetDetail, SubnetFields } from '../api'

interface Props {
  editable: boolean
  onSessionError: (error: unknown) => void
  onChanged: () => void
}

type SubnetDraft = SubnetFields & { id?: number; version?: number }

function statusLabel(status: string) {
  return status === 'gateway' ? '网关' : status === 'asset' ? '资产地址' : '已分配'
}
function statusColor(status: string) {
  return status === 'gateway' ? 'blue' : status === 'asset' ? 'default' : 'green'
}
function count(value: number) {
  return value.toLocaleString('zh-CN')
}
function assetLabel(asset: Asset) {
  return `${asset.name}（${asset.kind === 'vm' ? '虚拟机' : asset.kind === 'switch' ? '交换机' : '物理机'}）`
}

export function IpamView({ editable, onSessionError, onChanged }: Props) {
  const [subnets, setSubnets] = useState<Subnet[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<SubnetDetail | null>(null)
  const [draft, setDraft] = useState<SubnetDraft | null>(null)
  const [allocation, setAllocation] = useState({ ip: '', assetId: 0, label: '', notes: '' })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')

  const selected = subnets.find(item => item.id === selectedId) ?? null
  const usage = useMemo(() => {
    const query = search.trim().toLowerCase()
    const rows = detail?.usedIps ?? []
    if (!query) return rows
    return rows.filter(row => [row.ip, row.assetName, row.label, row.notes, statusLabel(row.status)]
      .some(value => value?.toLowerCase().includes(query)))
  }, [detail, search])
  const utilization = detail && detail.usable > 0 ? Math.min(100, Math.round(detail.used / detail.usable * 100)) : 0

  useEffect(() => { void load() }, [])

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
      const [nextSubnets, nextAssets] = await Promise.all([api<Subnet[]>('/subnets'), api<Asset[]>('/assets')])
      setSubnets(nextSubnets)
      setAssets(nextAssets)
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

  function addSubnet() {
    setDraft({ name: '', cidr: '', gateway: '', vlan: '', notes: '' })
    setFeedback('')
  }

  function editSubnet() {
    if (!selected) return
    setDraft({
      id: selected.id, version: selected.version, name: selected.name, cidr: selected.cidr,
      gateway: selected.gateway, vlan: selected.vlan, notes: selected.notes,
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
        notes: draft.notes, version: draft.version ?? 0,
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
      })
      setAllocation({ ip: '', assetId: 0, label: '', notes: '' })
      await load()
      setFeedback('IP 已分配')
      onChanged()
    } catch (e) {
      report(e)
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
    { title: '状态', key: 'status', width: 90, render: (_, row) => <Tag color={statusColor(row.status)}>{statusLabel(row.status)}</Tag> },
    {
      title: '资产 / 标签', key: 'owner',
      render: (_, row) => (
        <span>
          {row.assetName || row.label || '—'}
          {row.assetName && row.label && <span className="muted"> / {row.label}</span>}
        </span>
      ),
    },
    { title: '备注', dataIndex: 'notes', key: 'notes', render: value => value || '—' },
    ...(editable ? [{
      title: '', key: 'actions', width: 70,
      render: (_: unknown, row: IPUsage) => row.status === 'allocated' ? (
        <Popconfirm title="释放该 IP？" okText="释放" cancelText="取消" onConfirm={() => void release(row)}>
          <Button type="link" size="small" danger>释放</Button>
        </Popconfirm>
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
              <Col span={12}><Form.Item label="网关"><Input value={draft.gateway} maxLength={64} placeholder="例如：192.168.10.1" onChange={event => setDraft({ ...draft, gateway: event.target.value })} /></Form.Item></Col>
              <Col span={12}><Form.Item label="VLAN"><Input value={draft.vlan} maxLength={32} placeholder="例如：100" onChange={event => setDraft({ ...draft, vlan: event.target.value })} /></Form.Item></Col>
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
          <List
            dataSource={subnets} split={false} className="subnet-list" loading={loading}
            renderItem={item => (
              <List.Item
                className={`subnet-item${item.id === selectedId ? ' active' : ''}`}
                onClick={() => void selectSubnet(item.id)}
              >
                <div className="subnet-content">
                  <div className="subnet-head">
                    <strong>{item.name}</strong>
                    <Tag className="mono">{item.cidr}</Tag>
                  </div>
                  <span className="muted">VLAN {item.vlan || '—'} · 已用 {count(item.used)} / {count(item.usable)} · 空闲 {count(item.free)}</span>
                  <Progress percent={item.usable > 0 ? Math.round(item.used / item.usable * 100) : 0} size="small" showInfo={false} />
                </div>
              </List.Item>
            )}
          />

          <div className="subnet-detail">
            {detail ? (
              <>
                <div className="detail-head">
                  <div>
                    <h2>{detail.name}</h2>
                    <span className="muted mono">{detail.cidr} · 网关 {detail.gateway || '—'} · VLAN {detail.vlan || '—'}</span>
                  </div>
                  {editable && (
                    <Space>
                      <Button size="small" onClick={editSubnet}>编辑</Button>
                      <Popconfirm title="确定删除该网段？" okText="删除" cancelText="取消" onConfirm={() => void deleteSubnet()}>
                        <Button size="small" danger loading={busy}>删除</Button>
                      </Popconfirm>
                    </Space>
                  )}
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
                              value={allocation.assetId}
                              onChange={value => setAllocation({ ...allocation, assetId: value })}
                              options={[{ value: 0, label: '不关联资产' }, ...assets.map(asset => ({ value: asset.id, label: assetLabel(asset) }))]}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={12}><Form.Item label="标签"><Input value={allocation.label} maxLength={160} placeholder="例如：VIP" onChange={event => setAllocation({ ...allocation, label: event.target.value })} /></Form.Item></Col>
                        <Col span={12}><Form.Item label="备注"><Input value={allocation.notes} maxLength={2000} onChange={event => setAllocation({ ...allocation, notes: event.target.value })} /></Form.Item></Col>
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
                    className="usage-search" allowClear placeholder="搜索 IP、资产或标签"
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
    </Card>
  )
}
