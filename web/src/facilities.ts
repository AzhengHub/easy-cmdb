import type { Asset, Link } from './api'

export interface RoomFields {
  name: string
  columns: number
  rows: number
}

export interface Room extends RoomFields {
  id: number
  version: number
}

export interface RackFields {
  name: string
  heightU: number
  column: number
  row: number
  rotation: number
}

export interface Rack extends RackFields {
  id: number
  roomId: number
  version: number
}

export interface Placement {
  rackId: number
  assetId: number
  startU: number
  units: number
  version: number
}

export interface Facilities {
  rooms: Room[]
  racks: Rack[]
  placements: Placement[]
}

export interface AssetLocation {
  placement: Placement
  rack: Rack
  room: Room
}

export const mountKinds = {
  host: '物理机',
  switch: '交换机',
} as const

export type MountKind = keyof typeof mountKinds

export function isMountKind(kind: Asset['kind']): kind is MountKind {
  return Object.hasOwn(mountKinds, kind)
}

export function uRange(placement: Pick<Placement, 'startU' | 'units'>) {
  const { startU, units } = placement
  return units === 1 ? 'U' + startU : 'U' + startU + '–U' + (startU + units - 1)
}

export function assetLocations(layout: Facilities, links: Link[]) {
  const result = new Map<number, AssetLocation>()
  const racks = new Map(layout.racks.map(rack => [rack.id, rack]))
  const rooms = new Map(layout.rooms.map(room => [room.id, room]))
  for (const placement of layout.placements) {
    const rack = racks.get(placement.rackId)
    const room = rack && rooms.get(rack.roomId)
    if (rack && room) result.set(placement.assetId, { placement, rack, room })
  }

  // VMs follow the location of the host that carries them.
  for (const link of links) {
    const parent = result.get(link.fromId)
    if (link.kind === 'hosts' && parent && !result.has(link.toId)) result.set(link.toId, parent)
  }
  return result
}

export function locationLabel(location: AssetLocation) {
  return [location.room.name, location.rack.name, uRange(location.placement)].join(' / ')
}
