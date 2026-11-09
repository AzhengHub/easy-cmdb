import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Space } from 'antd'

interface Props {
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>
}

interface Values {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

export function ChangePassword({ onSubmit }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(values: Values) {
    setBusy(true)
    setError('')
    try {
      await onSubmit(values.currentPassword, values.newPassword)
    } catch (e) {
      setError(e instanceof Error ? e.message : '密码修改失败')
      setBusy(false)
    }
  }

  return (
    <Card variant="borderless" title="修改登录密码" className="password-card">
      <p className="muted password-hint">修改成功后，当前账号的所有登录会话都会失效，需要使用新密码重新登录。</p>
      {error && <Alert type="error" showIcon message={error} className="password-alert" />}
      <Form<Values> layout="vertical" onFinish={value => void submit(value)}>
        <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" maxLength={512} />
        </Form.Item>
        <Form.Item
          label="新密码" name="newPassword"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 12, max: 512, message: '新密码长度须为 12–512 个字符' },
          ]}
        >
          <Input.Password autoComplete="new-password" maxLength={512} />
        </Form.Item>
        <Form.Item
          label="确认新密码" name="confirmPassword" dependencies={['newPassword']}
          rules={[
            { required: true, message: '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) return Promise.resolve()
                return Promise.reject(new Error('两次输入的新密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" maxLength={512} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={busy}>修改密码</Button>
            <Button htmlType="reset" onClick={() => setError('')}>重置</Button>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  )
}
