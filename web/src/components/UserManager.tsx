import { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag,
} from 'antd'
import type { TableColumnsType } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons'
import { api, APIError } from '../api'
import type { Role, User, UserFields } from '../api'

interface Props {
  currentUsername: string
  onSessionError: (error: unknown) => void
}

const roleMeta: Record<Role, { label: string; color: string; description: string }> = {
  admin: { label: '管理员', color: 'red', description: '全部权限，可管理账号' },
  operator: { label: '运维', color: 'blue', description: '可维护资产、IPAM 和数据中心' },
  viewer: { label: '只读', color: 'default', description: '只能查看，不能修改数据' },
}

const roles: Role[] = ['admin', 'operator', 'viewer']

export function UserManager({ currentUsername, onSessionError }: Props) {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [modalError, setModalError] = useState('')
  const [form] = Form.useForm<UserFields>()

  const adminCount = useMemo(() => users.filter(user => user.role === 'admin').length, [users])

  useEffect(() => { void load() }, [])

  function report(e: unknown, inModal = false) {
    if (e instanceof APIError && e.status === 401) {
      onSessionError(e)
      return
    }
    const message = e instanceof Error ? e.message : '操作失败'
    if (inModal) setModalError(message)
    else setError(message)
  }

  async function load() {
    setLoading(true)
    setError('')
    try {
      setUsers(await api<User[]>('/users'))
    } catch (e) {
      report(e)
    } finally {
      setLoading(false)
    }
  }

  function openCreate() {
    setEditing(null)
    setModalError('')
    setFeedback('')
    setModalOpen(true)
  }

  function openEdit(user: User) {
    setEditing(user)
    setModalError('')
    setFeedback('')
    setModalOpen(true)
  }

  async function save() {
    const values = await form.validateFields()
    setBusy(true)
    setModalError('')
    try {
      if (editing) {
        await api<User>(`/users/${encodeURIComponent(editing.username)}`, 'PUT', {
          username: editing.username,
          role: values.role,
          password: values.password ?? '',
        })
      } else {
        await api<User>('/users', 'POST', {
          username: values.username,
          role: values.role,
          password: values.password,
        })
      }
      const wasEdit = !!editing
      setModalOpen(false)
      setEditing(null)
      await load()
      setFeedback(wasEdit ? '账号已更新' : '账号已创建')
    } catch (e) {
      report(e, true)
    } finally {
      setBusy(false)
    }
  }

  async function remove(user: User) {
    setBusy(true)
    setError('')
    try {
      await api(`/users/${encodeURIComponent(user.username)}`, 'DELETE')
      await load()
      setFeedback('账号已删除')
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }

  const columns: TableColumnsType<User> = [
    {
      title: '账号', dataIndex: 'username', key: 'username',
      render: (value, user) => (
        <Space size={6}>
          <strong>{value}</strong>
          {user.username === currentUsername && <Tag color="blue">当前账号</Tag>}
          {user.role === 'admin' && adminCount === 1 && <Tag>最后一个管理员</Tag>}
        </Space>
      ),
    },
    {
      title: '角色', dataIndex: 'role', key: 'role', width: 120,
      render: value => {
        const meta = roleMeta[value as Role]
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: '权限说明', dataIndex: 'role', key: 'description',
      render: value => roleMeta[value as Role]?.description ?? '—',
    },
    {
      title: '操作', key: 'actions', width: 150,
      render: (_, user) => {
        if (user.username === currentUsername) return <span className="muted">请使用「更改密码」维护当前账号</span>
        const lastAdmin = user.role === 'admin' && adminCount <= 1
        return (
          <Space size={0}>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(user)}>编辑</Button>
            <Popconfirm
              title="删除该账号？"
              description="删除后该账号的登录会话会立即失效。"
              okText="删除" cancelText="取消"
              disabled={busy || lastAdmin}
              onConfirm={() => void remove(user)}
            >
              <Button
                type="text" size="small" danger icon={<DeleteOutlined />}
                disabled={busy || lastAdmin}
                title={lastAdmin ? '不能删除最后一个管理员' : undefined}
                aria-label={`删除账号 ${user.username}`}
              />
            </Popconfirm>
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      variant="borderless"
      title={<Space><TeamOutlined /><span>用户管理</span><Tag>{users.length} 个账号</Tag></Space>}
      extra={(
        <Space>
          <Button loading={loading} onClick={() => void load()}><ReloadOutlined /> 刷新</Button>
          <Button type="primary" onClick={openCreate}><PlusOutlined /> 新增账号</Button>
        </Space>
      )}
    >
      {error && <Alert type="error" showIcon closable message={error} className="ipam-alert" onClose={() => setError('')} />}
      {feedback && <Alert type="success" showIcon closable message={feedback} className="ipam-alert" onClose={() => setFeedback('')} />}

      <Alert
        type="info" showIcon className="user-role-hint"
        message="角色说明"
        description={(
          <Space direction="vertical" size={2}>
            {roles.map(role => (
              <span key={role}>
                <Tag color={roleMeta[role].color}>{roleMeta[role].label}</Tag>
                {roleMeta[role].description}
              </span>
            ))}
          </Space>
        )}
      />

      <Table<User>
        rowKey="username" size="middle" columns={columns} dataSource={users} loading={loading}
        pagination={false} locale={{ emptyText: '暂无账号' }} scroll={{ x: 'max-content' }}
      />

      <Modal
        open={modalOpen}
        title={editing ? `编辑账号 ${editing.username}` : '新增账号'}
        footer={null} width={500} destroyOnHidden maskClosable={!busy}
        onCancel={() => { if (!busy) { setModalOpen(false); setEditing(null); setModalError('') } }}
      >
        {modalError && <Alert type="error" showIcon message={modalError} className="bulk-alert" />}
        <Form
          key={editing?.username ?? 'new'} form={form} layout="vertical"
          initialValues={editing
            ? { username: editing.username, role: editing.role, password: '' }
            : { role: 'viewer', password: '', username: '' }}
          onFinish={() => void save()}
        >
          <Form.Item
            label="账号" name="username"
            rules={[{ required: true, message: '请输入账号' }, {
              pattern: /^[\p{L}\p{N}._@-]{1,80}$/u,
              message: '账号须为 1–80 个字符，只能包含文字、数字、点、下划线、@ 或连字符',
            }]}
          >
            <Input disabled={!!editing} maxLength={80} autoComplete="off" placeholder="例如：ops-viewer" />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true, message: '请选择角色' }]}>
            <Select
              options={roles.map(role => ({
                value: role,
                label: `${roleMeta[role].label} · ${roleMeta[role].description}`,
              }))}
            />
          </Form.Item>
          <Form.Item
            label={editing ? '重置密码' : '初始密码'}
            name="password"
            extra={editing ? '留空表示不修改密码；修改后该账号已有会话会失效。' : '至少 12 个字符。'}
            rules={[
              ...(editing ? [] : [{ required: true, message: '请设置初始密码' }]),
              {
                validator: (_, value: string | undefined) => !value || value.length >= 12
                  ? Promise.resolve()
                  : Promise.reject(new Error('密码至少 12 个字符')),
              },
            ]}
          >
            <Input.Password
              maxLength={512} autoComplete="new-password"
              placeholder={editing ? '留空表示不修改' : '至少 12 个字符'}
            />
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
