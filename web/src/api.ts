export type Kind = 'chassis' | 'host' | 'cluster' | 'vm' | 'business'
export type LinkKind = 'contains' | 'member' | 'hosts' | 'uses'

export interface AssetFields {
  kind: Kind
  name: string
  platform: '' | 'pve' | 'kvm'
  status: string
  lifecycle: 'active' | 'retired'
  owner: string
  environment: string
  address: string
  cpu: number
  memoryMiB: number
  notes: string
  attributes: Record<string, unknown>
}

export interface Asset extends AssetFields {
  id: number
  version: number
  updatedAt: string
  sourceKey?: string
  externalKey?: string
  lastSeenAt?: string
  missingCount: number
  observed: Record<string, unknown>
}

export interface Link {
  id: number
  kind: LinkKind
  fromId: number
  fromName: string
  toId: number
  toName: string
  sourceKey?: string
}

export interface Change {
  id: number
  assetId: number
  assetName: string
  actor: string
  action: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  createdAt: string
}

export interface SyncRun {
  sourceKey: string
  platform: 'pve' | 'kvm'
  status: 'ok' | 'failed'
  message: string
  resourceCount: number
  finishedAt: string
  lastSuccessAt: string | null
}

export interface User {
  username: string
  role: 'admin' | 'operator' | 'viewer'
}

export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new APIError(res.status, data?.error ?? '请求失败，请稍后重试')
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}
