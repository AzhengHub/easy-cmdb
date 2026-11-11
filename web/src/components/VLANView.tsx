import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { api, APIError } from '../api'
import type { VLAN, VLANFields } from '../api'

interface RoomOption {
  id: number
  name: string
}

interface Props {
  editable: boolean
  rooms: RoomOption[]
  onSessionError: (error: unknown) => void
  onChanged: () => void
}

const statusMeta: Record<string, { label: string; color: string }> = {
  active: { label: '启用', color: 'green' },
  reserved: { label: '预留', color: 'cyan' },
  deprecated: { label: '停用', color: 'default' },
}

function statusTag(status: string) {
  const meta = statusMeta[status] ?? { label: status, color: 'default' }
  return <Tag color={meta.color}>{meta.label}</Tag>
}

function date(value: string) {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function VLANView({ editable, rooms, onSessionError, onChanged }: Props) {
  const [vlans, setVlans] = useState<VLAN[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [modalError, setModalError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<string | undefined>()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<VLAN | null>(null)
  const [form] = Form.useForm<VLANFields>()

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
      setVlans(await api<VLAN[]>('/vlans'))
    } catch (e) {
      report(e)
    } finally {
      setLoading(false)
    }
  }

  function openCreate() {
    setEditing(null)
    setFeedback('')
    setError('')
    setModalError('')
    setModalOpen(true)
  }

  function openEdit(vlan: VLAN) {
    setEditing(vlan)
    setFeedback('')
    setError('')
    setModalError('')
    setModalOpen(true)
  }

  async function save() {
    const values = await form.validateFields()
    setBusy(true)
    setModalError('')
    try {
      const body = {
        vid: values.vid,
        name: values.name,
        status: values.status ?? 'active',
        description: values.description ?? '',
        roomId: values.roomId ?? 0,
        version: editing?.version ?? 0,
      }
      const wasEdit = !!editing
      if (editing) await api<VLAN>(`/vlans/${editing.id}`, 'PUT', body)
      else await api<VLAN>('/vlans', 'POST', body)
      setModalOpen(false)
      setEditing(null)
      await load()
      setFeedback(wasEdit ? 'VLAN 已更新' : 'VLAN 已创建')
      onChanged()
    } catch (e) {
      if (e instanceof APIError && e.status === 401) onSessionError(e)
      else setModalError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove(vlan: VLAN) {
    setBusy(true)
    setError('')
    try {
      await api(`/vlans/${vlan.id}?version=${vlan.version}`, 'DELETE')
      await load()
      setFeedback('VLAN 已删除')
      onChanged()
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }

  const visible = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    return vlans.filter(vlan => {
      if (status && vlan.status !== status) return false
      if (!query) return true
      return [String(vlan.vid), vlan.name, vlan.description, vlan.roomName]
        .some(value => value?.toLowerCase().includes(query))
    })
  }, [keyword, status, vlans])

  const columns: TableColumnsType<VLAN> = [
    { title: 'VLAN ID', dataIndex: 'vid', key: 'vid', width: 90, sorter: (a, b) => a.vid - b.vid, render: value => <span className="mono">{value}</span> },
    {
      title: '名称', key: 'name', width: 360, sorter: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
      render: (_, vlan) => (
        <div className="vlan-name">
          <strong>{vlan.name}</strong>
          {vlan.description && <span className="muted">{vlan.description}</span>}
        </div>
      ),
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: statusTag },
    { title: '所属数据中心', dataIndex: 'roomName', key: 'roomName', width: 150, render: value => value || '—' },
    {
      title: '关联网段', dataIndex: 'prefixCount', key: 'prefixCount', width: 100,
      sorter: (a, b) => a.prefixCount - b.prefixCount,
      render: value => <Tag color={value ? 'blue' : 'default'}>{value}</Tag>,
    },
    { title: '最近更新', dataIndex: 'updatedAt', key: 'updatedAt', width: 175, render: date },
    ...(editable ? [{
      title: '操作', key: 'actions', width: 110,
      render: (_: unknown, vlan: VLAN) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(vlan)}>编辑</Button>
          <Popconfirm
            title="删除该 VLAN？" description="仍有网段使用时不能删除。"
            okText="删除" cancelText="取消" onConfirm={() => void remove(vlan)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除 VLAN ${vlan.vid}`} />
          </Popconfirm>
        </Space>
      ),
    }] : []),
  ]

  return (
    <Card
      variant="borderless"
      title={<Space><span>VLAN 管理</span><Tag>{vlans.length} 个 VLAN</Tag></Space>}
      extra={(
        <Space>
          <Button loading={loading} onClick={() => void load()}><ReloadOutlined /> 刷新</Button>
          {editable && <Button type="primary" onClick={openCreate}><PlusOutlined /> 新增 VLAN</Button>}
        </Space>
      )}
    >
      {error && <Alert type="error" showIcon closable message={error} className="ipam-alert" onClose={() => setError('')} />}
      {feedback && <Alert type="success" showIcon closable message={feedback} className="ipam-alert" onClose={() => setFeedback('')} />}

      <div className="table-toolbar vlan-toolbar">
        <Input
          allowClear prefix={<SearchOutlined />} className="table-search"
          placeholder="搜索 VLAN ID、名称、描述或数据中心"
          value={keyword} onChange={event => setKeyword(event.target.value)}
        />
        <Space wrap>
          <Select
            allowClear style={{ width: 130 }} placeholder="全部状态" value={status}
            onChange={setStatus}
            options={Object.entries(statusMeta).map(([value, meta]) => ({ value, label: meta.label }))}
          />
          <span className="muted">共 {visible.length} 个</span>
        </Space>
      </div>

      <Table<VLAN>
        rowKey="id" size="middle" columns={columns} dataSource={visible} loading={loading}
        scroll={{ x: 'max-content' }} locale={{ emptyText: '暂无 VLAN，新增一个开始规划二层网络' }}
        pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], showTotal: total => `共 ${total} 个` }}
      />

      <Modal
        open={modalOpen} title={editing ? `编辑 VLAN ${editing.vid}` : '新增 VLAN'} footer={null}
        width={520} destroyOnHidden maskClosable={!busy}
        onCancel={() => { if (!busy) { setModalOpen(false); setEditing(null); setModalError('') } }}
      >
        {modalError && <Alert type="error" showIcon message={modalError} className="bulk-alert" />}
        <Form
          key={editing?.id ?? 'new'} form={form} layout="vertical"
          initialValues={editing
            ? { vid: editing.vid, name: editing.name, status: editing.status, description: editing.description, roomId: editing.roomId || undefined }
            : { status: 'active', description: '', roomId: undefined }}
          onFinish={() => void save()}
        >
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item label="VLAN ID" name="vid" rules={[{ required: true, message: '请输入 VLAN ID' }]}>
                <InputNumber min={1} max={4094} precision={0} style={{ width: '100%' }} placeholder="1–4094" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item label="名称" name="name" rules={[{ required: true, message: '请输入 VLAN 名称' }]}>
                <Input maxLength={80} placeholder="例如：服务器区" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="状态" name="status" rules={[{ required: true }]}>
            <Select options={Object.entries(statusMeta).map(([value, meta]) => ({ value, label: meta.label }))} />
          </Form.Item>
          <Form.Item label="所属数据中心" name="roomId">
            <Select
              allowClear placeholder="可选"
              options={rooms.map(room => ({ value: room.id, label: room.name }))}
            />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea rows={2} maxLength={200} showCount placeholder="用途、网段规划等说明" />
          </Form.Item>
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
