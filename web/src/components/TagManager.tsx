import { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, TagsOutlined } from '@ant-design/icons'
import { api, APIError } from '../api'
import type { Tag as TagItem, TagFields } from '../api'

interface Props {
  editable: boolean
  onSessionError: (error: unknown) => void
  onChanged?: (tags: TagItem[]) => void
  onShowAssets?: (tagId: number) => void
}

const colorPresets = [
  { value: '#1677ff', label: '蓝色' },
  { value: '#52c41a', label: '绿色' },
  { value: '#faad14', label: '橙色' },
  { value: '#f5222d', label: '红色' },
  { value: '#eb2f96', label: '粉色' },
  { value: '#722ed1', label: '紫色' },
  { value: '#13c2c2', label: '青色' },
  { value: '#8c8c8c', label: '灰色' },
]

export function TagManager({ editable, onSessionError, onChanged, onShowAssets }: Props) {
  const [tags, setTags] = useState<TagItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<TagItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [modalError, setModalError] = useState('')
  const [form] = Form.useForm<TagFields>()

  useEffect(() => {
    void load()
  }, [])

  function report(value: unknown) {
    if (value instanceof APIError && value.status === 401) {
      onSessionError(value)
      return
    }
    setError(value instanceof Error ? value.message : '操作失败')
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      const next = await api<TagItem[]>('/tags')
      setTags(next)
      onChanged?.(next)
    } catch (value) {
      report(value)
    } finally {
      setLoading(false)
    }
  }

  function createTag() {
    setEditing(null)
    setModalError('')
    form.setFieldsValue({ name: '', color: '#1677ff', description: '' })
    setOpen(true)
  }

  function editTag(tag: TagItem) {
    setEditing(tag)
    setModalError('')
    form.setFieldsValue({ name: tag.name, color: tag.color, description: tag.description })
    setOpen(true)
  }

  async function save(values: TagFields) {
    setSaving(true)
    setModalError('')
    try {
      if (editing) await api(`/tags/${editing.id}`, 'PUT', values)
      else await api('/tags', 'POST', values)
      setOpen(false)
      await load()
    } catch (value) {
      if (value instanceof APIError && value.status === 401) onSessionError(value)
      else setModalError(value instanceof Error ? value.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function remove(tag: TagItem) {
    try {
      await api(`/tags/${tag.id}`, 'DELETE')
      await load()
    } catch (value) {
      report(value)
    }
  }

  const columns: TableColumnsType<TagItem> = [
    {
      title: '标签', key: 'name',
      render: (_, tag) => (
        <Tag color={tag.color} className="tag-manager-chip">{tag.name}</Tag>
      ),
    },
    { title: '说明', dataIndex: 'description', key: 'description', render: value => value || '—' },
    {
      title: '关联资产', dataIndex: 'assetCount', key: 'assetCount', width: 110,
      render: (_value, tag) => tag.assetCount ? (
        <Button type="link" size="small" onClick={() => onShowAssets?.(tag.id)}>{tag.assetCount}</Button>
      ) : <span className="mono">0</span>,
    },
    ...(editable ? [{
      title: '', key: 'actions', width: 130,
      render: (_: unknown, tag: TagItem) => (
        <Space size={2}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => editTag(tag)}>编辑</Button>
          <Popconfirm
            title={`删除标签「${tag.name}」？`} description="关联资产上的该标签会一并移除，资产本身保留。"
            okText="删除" cancelText="取消" onConfirm={() => void remove(tag)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    }] : []),
  ]

  return (
    <Card
      variant="borderless" title={<Space><TagsOutlined /><span>标签管理</span><span className="muted">{tags.length} 个标签</span></Space>}
      extra={editable ? <Button type="primary" icon={<PlusOutlined />} onClick={createTag}>新增标签</Button> : null}
    >
      {error && <Alert type="error" showIcon message={error} className="page-alert" />}
      <Table<TagItem>
        rowKey="id" size="middle" columns={columns} dataSource={tags} loading={loading}
        locale={{ emptyText: '还没有标签，创建一个用于分组和筛选资产' }}
        pagination={false}
      />
      <Modal
        open={open} title={editing ? '编辑标签' : '新增标签'} footer={null} width={480} destroyOnHidden
        onCancel={() => { if (!saving) setOpen(false) }}
      >
        {modalError && <Alert type="error" showIcon message={modalError} className="bulk-alert" />}
        <Form form={form} layout="vertical" onFinish={values => void save(values)}>
          <Form.Item label="标签名称" name="name" rules={[{ required: true, message: '请输入标签名称' }]}>
            <Input maxLength={80} placeholder="例如：生产、核心业务、待迁移" />
          </Form.Item>
          <Form.Item label="颜色" name="color" rules={[{ required: true }]}>
            <Select
              options={colorPresets.map(item => ({
                value: item.value,
                label: (
                  <span className="tag-color-option">
                    <i style={{ background: item.value }} />{item.label}
                  </span>
                ),
              }))}
            />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input.TextArea maxLength={200} rows={3} placeholder="可选，说明这个标签的用途" />
          </Form.Item>
          <div className="bulk-modal-actions">
            <Space>
              <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
              <Button disabled={saving} onClick={() => setOpen(false)}>取消</Button>
            </Space>
          </div>
        </Form>
      </Modal>
    </Card>
  )
}
