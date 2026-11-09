export type Kind = 'host' | 'vm' | 'switch'
export type LinkKind = 'hosts'

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
}

export interface Link {
  id: number
  kind: LinkKind
  fromId: number
  fromName: string
  toId: number
  toName: string
}

export interface SubnetFields {
  name: string
  cidr: string
  gateway: string
  vlan: string
  notes: string
}

export interface Subnet extends SubnetFields {
  id: number
  version: number
  usable: number
  used: number
  free: number
}

export interface IPUsage {
  ip: string
  status: 'gateway' | 'asset' | 'allocated'
  assetId?: number
  assetName?: string
  allocationId?: number
  label?: string
  notes?: string
  version?: number
}

export interface SubnetDetail extends Subnet {
  usedIps: IPUsage[]
  freeIps: string[]
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

export interface User {
  username: string
  role: 'admin' | 'operator' | 'viewer'
}

export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => null)
  return data?.error ?? '请求失败，请稍后重试'
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new APIError(res.status, await errorMessage(res))
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function apiCSV<T>(path: string, file: File): Promise<T> {
  const res = await fetch('/api' + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
    body: file,
  })
  if (!res.ok) throw new APIError(res.status, await errorMessage(res))
  return res.json() as Promise<T>
}
