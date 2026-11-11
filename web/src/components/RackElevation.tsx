import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Segmented } from 'antd'
import type { Asset } from '../api'
import { occupiedUnits, placementFaceLabel, placementsConflict, uRange } from '../facilities'
import type { Placement, Rack, RackFace } from '../facilities'
import { RackDeviceSvg } from './RackDeviceSvg'

interface Props {
  rack: Rack
  devices: Placement[]
  assets: Map<number, Asset>
  focused: number | null
  editable: boolean
  busy: boolean
  onOpen: (assetId: number) => void
  onMove: (placement: Placement, startU: number) => void
  onMountAt?: (startU: number, face: RackFace) => void
}

const defaultUnitHeight = 22

function overlaps(devices: Placement[], placement: Placement, startU: number) {
  return devices.some(item => placementsConflict({ ...placement, startU }, item))
}

export function RackElevation({ rack, devices, assets, focused, editable, busy, onOpen, onMove, onMountAt }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const dragRef = useRef<{ placement: Placement; startU: number; valid: boolean } | null>(null)
  const [drag, setDrag] = useState<{ placement: Placement; startU: number; valid: boolean } | null>(null)
  const [unitHeight, setUnitHeight] = useState(defaultUnitHeight)
  const [face, setFace] = useState<RackFace>('front')
  const units = Array.from({ length: rack.heightU }, (_, index) => rack.heightU - index)
  const visibleDevices = devices.filter(device => device.depth === 'full' || device.face === face)
  const occupied = occupiedUnits(visibleDevices)

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const fit = () => {
      const available = container.clientHeight - 28
      setUnitHeight(Math.max(8, Math.min(defaultUnitHeight, Math.floor(available / rack.heightU))))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    window.addEventListener('resize', fit)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [rack.heightU])

  function startDrag(event: React.DragEvent, placement: Placement) {
    if (!editable || busy) {
      event.preventDefault()
      return
    }
    const frame = frameRef.current
    if (!frame) return
    const rect = frame.getBoundingClientRect()
    const pointerU = rack.heightU - Math.floor((event.clientY - rect.top) / unitHeight)
    const startU = Math.max(1, Math.min(rack.heightU - placement.units + 1, pointerU - Math.floor((placement.units - 1) / 2)))
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(placement.assetId))
    const next = { placement, startU, valid: !overlaps(devices, placement, startU) }
    dragRef.current = next
    setDrag(next)
    suppressClick.current = true
  }

  function dragOver(event: React.DragEvent) {
    event.preventDefault()
    const current = dragRef.current
    if (!current) return
    const frame = frameRef.current
    if (!frame) return
    const rect = frame.getBoundingClientRect()
    const pointerU = rack.heightU - Math.floor((event.clientY - rect.top) / unitHeight)
    const startU = Math.max(1, Math.min(rack.heightU - current.placement.units + 1, pointerU - Math.floor((current.placement.units - 1) / 2)))
    const valid = !overlaps(devices, current.placement, startU)
    event.dataTransfer.dropEffect = valid ? 'move' : 'none'
    const next = { ...current, startU, valid }
    dragRef.current = next
    setDrag(next)
  }

  function drop(event: React.DragEvent) {
    event.preventDefault()
    const current = dragRef.current
    if (current?.valid && current.startU !== current.placement.startU) {
      onMove(current.placement, current.startU)
    }
    dragRef.current = null
    setDrag(null)
    window.setTimeout(() => { suppressClick.current = false }, 0)
  }

  function endDrag() {
    dragRef.current = null
    setDrag(null)
    window.setTimeout(() => { suppressClick.current = false }, 0)
  }

  function click(assetId: number) {
    if (suppressClick.current) return
    onOpen(assetId)
  }

  return (
    <div className="rack-elevation" style={{ '--rack-u-height': `${unitHeight}px` } as CSSProperties}>
      <div className="rack-stage-head">
        <div className="rack-face-switch">
          <Segmented
            size="small" value={face} onChange={value => setFace(value as RackFace)}
            options={[
              { value: 'front', label: '前视图' },
              { value: 'rear', label: '后视图' },
            ]}
          />
          <span className="muted">
            {visibleDevices.length} 台设备 · 已占用 {occupied.size}U
            {face === 'rear' ? '（含全深设备）' : ''}
          </span>
        </div>
        <span className="muted">拖动设备可调整 U 位</span>
      </div>
      <div
        ref={scrollRef} className="rack-scroll"
        onDragEnter={event => event.preventDefault()} onDragOver={dragOver} onDrop={drop}
      >
        <div className="rack-layout" style={{ height: rack.heightU * unitHeight }}>
          <div className="rack-u-labels" style={{ gridTemplateRows: `repeat(${rack.heightU}, ${unitHeight}px)` }}>
            {units.map(unit => <span key={unit} className="rack-u-label">U{unit}</span>)}
          </div>

          <div
            ref={frameRef} className={`rack-frame${drag ? ' is-dragging' : ''}`}
            style={{ height: rack.heightU * unitHeight }}
          >
            <div className="rack-unit-lines" style={{ gridTemplateRows: `repeat(${rack.heightU}, ${unitHeight}px)` }}>
              {units.map(unit => occupied.has(unit) || !onMountAt
                ? <span key={unit} className="rack-unit-line" />
                : (
                  <button
                    key={unit} type="button" className="rack-unit-line rack-unit-slot"
                    title={`在 U${unit} 上架设备`} aria-label={`在 U${unit} 上架设备`}
                    onClick={() => onMountAt(unit, face)}
                  />
                ))}
            </div>
            <div className="rack-device-layer">
              {visibleDevices.map(device => {
                const asset = assets.get(device.assetId)
                const kind = asset?.kind ?? 'host'
                const top = (rack.heightU - (device.startU + device.units - 1)) * unitHeight
                const height = device.units * unitHeight - 3
                return (
                  <button
                    key={device.assetId} type="button"
                    className={`rack-device ${kind}${drag?.placement.assetId === device.assetId ? ' dragging' : ''}`}
                    data-asset-id={device.assetId} data-focused={focused === device.assetId}
                    style={{ top, height }}
                    draggable={editable && !busy}
                    title={`${asset?.name ?? '资产 #' + device.assetId} · ${uRange(device)} · ${placementFaceLabel(device)}`}
                    aria-label={`${asset?.name ?? '资产 #' + device.assetId}，${uRange(device)}，${placementFaceLabel(device)}`}
                    onClick={() => click(device.assetId)}
                    onDragStart={event => startDrag(event, device)}
                    onDragEnd={endDrag}
                  >
                    <RackDeviceSvg kind={kind} units={device.units} status={asset?.status} />
                  </button>
                )
              })}
            </div>
            {drag && (
              <div
                className={`rack-drop-preview ${drag.valid ? 'valid' : 'invalid'}`}
                style={{
                  top: (rack.heightU - (drag.startU + drag.placement.units - 1)) * unitHeight,
                  height: drag.placement.units * unitHeight - 3,
                }}
              >
                {drag.valid ? `放置到 U${drag.startU}` : '位置被占用'}
              </div>
            )}
          </div>

          <div className="rack-annotations">
            {visibleDevices.map(device => {
              const asset = assets.get(device.assetId)
              const top = (rack.heightU - (device.startU + device.units - 1)) * unitHeight
              const height = device.units * unitHeight - 3
              const status = asset?.status
              const led = status === 'offline' ? 'offline' : status === 'paused' ? 'paused' : (status === 'stopped' ? 'idle' : '')
              return (
                <button
                  key={device.assetId} type="button" className="rack-annotation"
                  style={{ top: top + height / 2 - 11, height: 22 }}
                  onClick={() => onOpen(device.assetId)}
                >
                  <span className="rack-annotation-line" />
                  <span className={`rack-annotation-dot ${led}`} />
                  <span className="rack-annotation-copy">
                    <strong>{asset?.name ?? '资产 #' + device.assetId}</strong>
                    <span>{uRange(device)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
