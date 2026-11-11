import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, Form, Input, Modal, Popconfirm, Row, Select, Space, Statistic, Table, Tag,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons'
import { api, APIError } from '../api'
import type { Asset, IPAddress, Subnet } from '../api'

interface Props {
  editable: boolean
  assets: Asset[]
  subnets: Subnet[]
  onOpenAsset: (id: number) => void
  onOpenSubnet: (id: number) => void
  onSessionError: (error: unknown) => void
  onChanged: () => void
}

const stateMeta: Record<string, { label: string; color: string }> = {
  active: { label: '启用', color: 'green' },
  reserved: { label: '预留', color: 'cyan' },
  deprecated: { label: '停用', color: 'default' },
  dhcp: { label: 'DHCP', color: 'purple' },
  slaac: { label: 'SLAAC', color: 'purple' },
}
const sourceMeta: Record<string, { label: string; color: string }> = {
  allocated: { label: '手工分配', color: 'blue' },
  asset: { label: '资产地址', color: 'default' },
  gateway: { label: '网关', color: 'gold' },
}
const roleLabels: Record<string, string> = {
  loopback: '环回', secondary: '辅助', vip: 'VIP', vrrp: 'VRRP',
  hsrp: 'HSRP', glbp: 'GLBP', anycast: 'Anycast',
}

interface AddressFormValues {
  subnetId?: number
  ip?: string
  status: string
  dnsName?: string
  role?: string
  assetId?: number
  label?: string
  notes?: string
}

function sourceTag(source: string) {
  const meta = sourceMeta[source] ?? { label: source, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function stateTag(state: string) {
  const meta = stateMeta[state] ?? { label: state, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function assetLabel(asset: Asset) {
  return `${asset.name}（${asset.kind === 'vm' ? '虚拟机' : asset.kind === 'switch' ? '交换机' : '物理机'}）`
}

export function IPAddressView({ editable, assets, subnets, onOpenAsset, onOpenSubnet, onSessionError, onChanged }: Props) {
  const [addresses, setAddresses] = useState<IPAddress[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [modalError, setModalError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [keyword, setKeyword] = useState('')
  const [source, setSource] = useState<string | undefined>()
  const [state, setState] = useState<string | undefined>()
  const [subnetId, setSubnetId] = useState<number | undefined>()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<IPAddress | null>(null)
  const [form] = Form.useForm<AddressFormValues>()

  useEffect(() => { void load() }, [])

  function report(e: unknown) {
    if (e instanceof APIError && e.status === 401) {
      onSessionError(e)
      return
    }
    setError(e instanceof Error ? e.message : '操作失败')
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      setAddresses(await api<IPAddress[]>('/ip-addresses'))
    } catch (e) {
      report(e)
    } finally {
      setLoading(false)
    }
  }

  function openCreate() {
    setEditing(null)
    setError('')
    setModalError('')
    setFeedback('')
    setModalOpen(true)
  }

  function openEdit(address: IPAddress) {
    setEditing(address)
    setError('')
    setModalError('')
    setFeedback('')
    setModalOpen(true)
  }

  async function save() {
    const values = await form.validateFields()
    setBusy(true)
    setModalError('')
    try {
      const fields = {
        assetId: values.assetId ?? 0,
        label: values.label ?? '',
        notes: values.notes ?? '',
        status: values.status,
        dnsName: values.dnsName ?? '',
        role: values.role ?? '',
      }
      if (editing?.allocationId) {
        await api(`/allocations/${editing.allocationId}`, 'PUT', { ...fields, version: editing.version ?? 0 })
      } else {
        if (!values.subnetId || !values.ip?.trim()) {
          setModalError('请选择网段并填写 IP 地址')
          return
        }
        await api(`/subnets/${values.subnetId}/allocations`, 'POST', { ...fields, ip: values.ip.trim() })
      }
      const wasEdit = !!editing
      setModalOpen(false)
      setEditing(null)
      await load()
      setFeedback(wasEdit ? 'IP 地址记录已更新' : 'IP 地址已分配')
      onChanged()
    } catch (e) {
      if (e instanceof APIError && e.status === 401) onSessionError(e)
      else setModalError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function release(address: IPAddress) {
    if (!address.allocationId) return
    setBusy(true)
    setError('')
    try {
      await api(`/allocations/${address.allocationId}?version=${address.version ?? 0}`, 'DELETE')
      await load()
      setFeedback('IP 地址已释放')
      onChanged()
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }

  const visible = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return addresses.filter(address => {
      if (source && address.source !== source) return false
      if (state && address.state !== state) return false
      if (subnetId && address.subnetId !== subnetId) return false
      if (!query) return true
      return [address.ip, address.dnsName, address.assetName, address.label, address.notes, address.subnetName,
        stateMeta[address.state]?.label, sourceMeta[address.source]?.label]
        .some(value => value?.toLowerCase().includes(query))
    })
  }, [addresses, keyword, source, state, subnetId])

  const stats = useMemo(() => ({
    total: addresses.length,
    allocated: addresses.filter(address => address.source === 'allocated').length,
    asset: addresses.filter(address => address.source === 'asset').length,
    gateway: addresses.filter(address => address.source === 'gateway').length,
  }), [addresses])

  const columns: TableColumnsType<IPAddress> = [
    {
      title: 'IP 地址', dataIndex: 'ip', key: 'ip', width: 145,
      render: value => <span className="mono">{value}</span>,
    },
    { title: '状态', dataIndex: 'state', key: 'state', width: 90, render: stateTag },
    { title: '来源', dataIndex: 'source', key: 'source', width: 110, render: sourceTag },
    { title: 'DNS 名称', dataIndex: 'dnsName', key: 'dnsName', render: value => value ? <span className="mono">{value}</span> : '—' },
    { title: '角色', dataIndex: 'role', key: 'role', width: 90, render: value => roleLabels[value] ?? (value || '—') },
    {
      title: '资产 / 用途', key: 'owner',
      render: (_, address) => (
        <span>
          {address.assetId && address.assetName
            ? <Button type="link" className="inline-link" onClick={() => onOpenAsset(address.assetId!)}>{address.assetName}</Button>
            : address.label || '—'}
          {address.assetId && address.label && <span className="muted"> / {address.label}</span>}
        </span>
      ),
    },
    {
      title: '网段', key: 'subnet',
      render: (_, address) => (
        <Button type="link" className="inline-link" onClick={() => onOpenSubnet(address.subnetId)}>{address.subnetName}</Button>
      ),
    },
    { title: '备注', dataIndex: 'notes', key: 'notes', ellipsis: true, render: value => value || '—' },
    ...(editable ? [{
      title: '操作', key: 'actions', width: 120,
      render: (_: unknown, address: IPAddress) => address.allocationId ? (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(address)}>编辑</Button>
          <Popconfirm title="释放该 IP？" okText="释放" cancelText="取消" onConfirm={() => void release(address)}>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`释放 ${address.ip}`} />
          </Popconfirm>
        </Space>
      ) : <span className="muted">—</span>,
    }] : []),
  ]

  return (
    <Card
      variant="borderless"
      title={<Space><span>IP 地址</span><Tag>{addresses.length} 条记录</Tag></Space>}
      extra={(
        <Space>
          <Button loading={loading} onClick={() => void load()}><ReloadOutlined /> 刷新</Button>
          {editable && <Button type="primary" onClick={openCreate}><PlusOutlined /> 分配 IP</Button>}
        </Space>
      )}
    >
      {error && <Alert type="error" showIcon closable message={error} className="ipam-alert" onClose={() => setError('')} />}
      {feedback && <Alert type="success" showIcon closable message={feedback} className="ipam-alert" onClose={() => setFeedback('')} />}

      <Row gutter={12} className="ipam-stats">
        <Col span={6}><Card size="small"><Statistic title="全部地址" value={stats.total} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="手工分配" value={stats.allocated} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="资产地址" value={stats.asset} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="网关" value={stats.gateway} /></Card></Col>
      </Row>

      <div className="table-toolbar">
        <Input
          allowClear prefix={<SearchOutlined />} className="table-search"
          placeholder="搜索 IP、DNS、资产、用途或网段"
          value={keyword} onChange={event => setKeyword(event.target.value)}
        />
        <Space wrap>
          <Select
            allowClear style={{ width: 150 }} placeholder="全部网段" value={subnetId}
            onChange={setSubnetId}
            options={subnets.map(subnet => ({ value: subnet.id, label: `${subnet.name} · ${subnet.cidr}` }))}
          />
          <Select
            allowClear style={{ width: 120 }} placeholder="全部来源" value={source}
            onChange={setSource}
            options={Object.entries(sourceMeta).map(([value, meta]) => ({ value, label: meta.label }))}
          />
          <Select
            allowClear style={{ width: 120 }} placeholder="全部状态" value={state}
            onChange={setState}
            options={Object.entries(stateMeta).map(([value, meta]) => ({ value, label: meta.label }))}
          />
          <span className="muted">共 {visible.length} 条</span>
        </Space>
      </div>

      <Table<IPAddress>
        rowKey="key" size="middle" columns={columns} dataSource={visible} loading={loading}
        scroll={{ x: 'max-content' }} locale={{ emptyText: '暂无匹配的 IP 地址' }}
        pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], showTotal: total => `共 ${total} 条` }}
      />

      <Modal
        open={modalOpen} title={editing ? `编辑 ${editing.ip}` : '分配 IP 地址'} footer={null}
        width={600} destroyOnHidden maskClosable={!busy}
        onCancel={() => { if (!busy) { setModalOpen(false); setEditing(null); setModalError('') } }}
      >
        {modalError && <Alert type="error" showIcon message={modalError} className="bulk-alert" />}
        <Form
          key={editing?.key ?? 'new'} form={form} layout="vertical"
          initialValues={editing
            ? {
                subnetId: editing.subnetId, ip: editing.ip, status: editing.state, dnsName: editing.dnsName,
                role: editing.role, assetId: editing.assetId || undefined, label: editing.label, notes: editing.notes,
              }
            : { status: 'active', role: '', assetId: undefined }}
          onFinish={() => void save()}
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="网段" name="subnetId" rules={[{ required: true, message: '请选择网段' }]}>
                <Select
                  disabled={!!editing} showSearch optionFilterProp="label" placeholder="选择网段"
                  options={subnets.map(subnet => ({ value: subnet.id, label: `${subnet.name} · ${subnet.cidr}` }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="IP 地址" name="ip" rules={[{ required: true, message: '请输入 IP 地址' }]}>
                <Input disabled={!!editing} className="mono" placeholder="例如：192.168.10.20" maxLength={64} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="状态" name="status" rules={[{ required: true }]}>
                <Select options={Object.entries(stateMeta).map(([value, meta]) => ({ value, label: meta.label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="角色" name="role">
                <Select
                  allowClear placeholder="可选"
                  options={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))}
                />
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
                  allowClear showSearch optionFilterProp="label" placeholder="可选"
                  options={assets.map(asset => ({ value: asset.id, label: assetLabel(asset) }))}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="用途 / 标签" name="label">
                <Input maxLength={160} placeholder="例如：VIP、数据库主地址" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="备注" name="notes">
                <Input.TextArea rows={2} maxLength={2000} placeholder="可选" />
              </Form.Item>
            </Col>
          </Row>
          <div className="bulk-modal-actions">
            <Space>
              <Button type="primary" htmlType="submit" loading={busy}>保存</Button>
              <Button disabled={busy} onClick={() => { setModalOpen(false); setEditing(null); setModalError('') }}>取消</Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </Card>
  )
}
