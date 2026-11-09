import { useState } from 'react'
import { Alert, Button, Col, Form, Input, InputNumber, Row, Select, Space } from 'antd'
import type { Asset, AssetFields, Kind } from '../api'

interface Props {
  asset: Asset | null
  defaultKind: Kind
  busy: boolean
  error: string
  onSave: (fields: AssetFields & { version: number }) => void
  onCancel: () => void
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
  const [attrs, setAttrs] = useState(JSON.stringify(asset?.attributes ?? {}, null, 2))
  const [validation, setValidation] = useState('')

  function update<K extends keyof AssetFields>(key: K, value: AssetFields[K]) {
    setFields(current => ({ ...current, [key]: value }))
  }

  function save() {
    setValidation('')
    try {
      const parsed: unknown = JSON.parse(attrs || '{}')
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error()
      onSave({
        ...fields,
        attributes: parsed as Record<string, unknown>,
        cpu: Number(fields.cpu || 0),
        memoryMiB: Number(fields.memoryMiB || 0),
        version: asset?.version ?? 0,
      })
    } catch {
      setValidation('扩展属性须为有效的 JSON 对象')
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
          <Form.Item label="扩展属性（JSON）">
            <Input.TextArea className="mono" value={attrs} rows={4} spellCheck={false} onChange={event => setAttrs(event.target.value)} />
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
