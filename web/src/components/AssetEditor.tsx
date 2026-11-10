import { useState } from 'react'
import { Alert, Button, Col, Form, Input, InputNumber, Row, Select, Space } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { Asset, AssetFields, Kind } from '../api'

interface Props {
  asset: Asset | null
  defaultKind: Kind
  busy: boolean
  error: string
  onSave: (fields: AssetFields & { version: number }) => void
  onCancel: () => void
}

type AttributeType = 'string' | 'number' | 'boolean' | 'json'

interface AttributeRow {
  id: number
  key: string
  value: string
  type: AttributeType
}

const attributeTypeOptions = [
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔' },
  { value: 'json', label: 'JSON' },
]

function attributesToRows(attributes: Record<string, unknown>): AttributeRow[] {
  return Object.entries(attributes).map(([key, value], index) => {
    if (typeof value === 'string') {
      return { id: index + 1, key, value, type: 'string' as const }
    }
    if (typeof value === 'number') {
      return { id: index + 1, key, value: String(value), type: 'number' as const }
    }
    if (typeof value === 'boolean') {
      return { id: index + 1, key, value: value ? 'true' : 'false', type: 'boolean' as const }
    }
    return { id: index + 1, key, value: JSON.stringify(value) ?? 'null', type: 'json' as const }
  })
}

function parseAttributeRows(rows: AttributeRow[]): Record<string, unknown> {
  const attributes: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) {
      if (!row.value.trim()) continue
      throw new Error('扩展属性存在空键名')
    }
    if (Object.prototype.hasOwnProperty.call(attributes, key)) {
      throw new Error(`扩展属性键名重复：${key}`)
    }
    switch (row.type) {
      case 'number': {
        const value = Number(row.value)
        if (!row.value.trim() || !Number.isFinite(value)) throw new Error(`扩展属性「${key}」须为有效数字`)
        attributes[key] = value
        break
      }
      case 'boolean':
        attributes[key] = row.value === 'true'
        break
      case 'json':
        try {
          attributes[key] = JSON.parse(row.value || 'null')
        } catch {
          throw new Error(`扩展属性「${key}」不是有效的 JSON`)
        }
        break
      default:
        attributes[key] = row.value
    }
  }
  return attributes
}

export function AssetEditor({ asset, defaultKind, busy, error, onSave, onCancel }: Props) {
  const [fields, setFields] = useState<AssetFields>({
    kind: asset?.kind ?? defaultKind,
    name: asset?.name ?? '',
    platform: asset?.platform ?? '',
    status: asset?.status ?? 'unknown',
    lifecycle: asset?.lifecycle ?? 'active',
    owner: asset?.owner ?? '',
    environment: asset?.environment ?? '',
    address: asset?.address ?? '',
    cpu: asset?.cpu ?? 0,
    memoryMiB: asset?.memoryMiB ?? 0,
    notes: asset?.notes ?? '',
    attributes: asset?.attributes ?? {},
  })
  const [attributeRows, setAttributeRows] = useState<AttributeRow[]>(() => attributesToRows(asset?.attributes ?? {}))
  const [nextAttributeId, setNextAttributeId] = useState(() => Object.keys(asset?.attributes ?? {}).length + 1)
  const [validation, setValidation] = useState('')

  function update<K extends keyof AssetFields>(key: K, value: AssetFields[K]) {
    setFields(current => ({ ...current, [key]: value }))
  }

  function updateAttribute(id: number, patch: Partial<AttributeRow>) {
    setAttributeRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row))
  }

  function addAttribute() {
    setAttributeRows(current => [...current, { id: nextAttributeId, key: '', value: '', type: 'string' }])
    setNextAttributeId(current => current + 1)
  }

  function removeAttribute(id: number) {
    setAttributeRows(current => current.filter(row => row.id !== id))
  }

  function save() {
    setValidation('')
    try {
      onSave({
        ...fields,
        attributes: parseAttributeRows(attributeRows),
        cpu: Number(fields.cpu || 0),
        memoryMiB: Number(fields.memoryMiB || 0),
        version: asset?.version ?? 0,
      })
    } catch (e) {
      setValidation(e instanceof Error ? e.message : '扩展属性格式不正确')
    }
  }

  return (
    <Form layout="vertical" onFinish={save}>
      {(validation || error) && <Alert type="error" showIcon message={validation || error} style={{ marginBottom: 16 }} />}
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item label="资源类型" required>
            <Select
              value={fields.kind}
              disabled={!!asset}
              onChange={value => update('kind', value)}
              options={[{ value: 'host', label: '物理机' }, { value: 'switch', label: '交换机' }, { value: 'vm', label: '虚拟机' }]}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="资源名称" required>
            <Input value={fields.name} maxLength={160} onChange={event => update('name', event.target.value)} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="平台">
            <Select
              value={fields.platform}
              onChange={value => update('platform', value)}
              options={[{ value: '', label: '未指定' }, { value: 'pve', label: 'Proxmox VE' }, { value: 'kvm', label: 'KVM / libvirt' }]}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="状态">
            <Select
              value={fields.status}
              onChange={value => update('status', value)}
              options={[
                { value: 'unknown', label: '未知' }, { value: 'online', label: '在线' }, { value: 'offline', label: '离线' },
                { value: 'running', label: '运行中' }, { value: 'stopped', label: '已停止' }, { value: 'paused', label: '已暂停' },
              ]}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="负责人">
            <Input value={fields.owner} maxLength={160} placeholder="姓名或团队" onChange={event => update('owner', event.target.value)} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="环境">
            <Input value={fields.environment} maxLength={40} placeholder="例如：生产" onChange={event => update('environment', event.target.value)} />
          </Form.Item>
        </Col>
        <Col span={24}>
          <Form.Item label="管理地址 / IP">
            <Input value={fields.address} maxLength={160} placeholder="例如：192.0.2.11" onChange={event => update('address', event.target.value)} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="CPU 核数 / vCPU">
            <InputNumber min={0} max={65536} value={fields.cpu} style={{ width: '100%' }} onChange={value => update('cpu', value ?? 0)} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="内存（MiB）">
            <InputNumber min={0} max={1073741824} value={fields.memoryMiB} style={{ width: '100%' }} onChange={value => update('memoryMiB', value ?? 0)} />
          </Form.Item>
        </Col>
        {asset && (
          <Col span={24}>
            <Form.Item label="生命周期">
              <Select
                value={fields.lifecycle}
                onChange={value => update('lifecycle', value)}
                options={[{ value: 'active', label: '在册' }, { value: 'retired', label: '已退役' }]}
              />
            </Form.Item>
          </Col>
        )}
        <Col span={24}>
          <Form.Item label="备注">
            <Input.TextArea value={fields.notes} rows={3} maxLength={2500} onChange={event => update('notes', event.target.value)} />
          </Form.Item>
        </Col>
        <Col span={24}>
          <Form.Item label="扩展属性" extra="键值对；复杂的嵌套结构请选择 JSON 类型">
            <div className="attribute-editor">
              {attributeRows.map(row => (
                <div key={row.id} className="attribute-row">
                  <Input
                    className="attribute-key" placeholder="键" maxLength={80}
                    value={row.key} onChange={event => updateAttribute(row.id, { key: event.target.value })}
                  />
                  <Select
                    className="attribute-type" value={row.type} options={attributeTypeOptions}
                    onChange={value => updateAttribute(row.id, {
                      type: value,
                      ...(value === 'boolean' ? { value: row.value === 'false' ? 'false' : 'true' } : {}),
                    })}
                  />
                  {row.type === 'boolean' ? (
                    <Select
                      className="attribute-value" value={row.value === 'false' ? 'false' : 'true'}
                      onChange={value => updateAttribute(row.id, { value })}
                      options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
                    />
                  ) : row.type === 'json' ? (
                    <Input.TextArea
                      className="attribute-value mono" autoSize={{ minRows: 1, maxRows: 4 }} spellCheck={false}
                      value={row.value} onChange={event => updateAttribute(row.id, { value: event.target.value })}
                    />
                  ) : (
                    <Input
                      className="attribute-value" placeholder="值"
                      inputMode={row.type === 'number' ? 'decimal' : undefined}
                      value={row.value} onChange={event => updateAttribute(row.id, { value: event.target.value })}
                    />
                  )}
                  <Button
                    type="text" danger icon={<DeleteOutlined />} aria-label="删除扩展属性"
                    onClick={() => removeAttribute(row.id)}
                  />
                </div>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} onClick={addAttribute}>添加属性</Button>
            </div>
          </Form.Item>
        </Col>
      </Row>
      <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onCancel}>取消</Button>
        <Button type="primary" htmlType="submit" loading={busy}>{busy ? '正在保存…' : '保存资产'}</Button>
      </Space>
    </Form>
  )
}
