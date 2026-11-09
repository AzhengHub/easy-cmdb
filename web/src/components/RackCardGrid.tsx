import { ClusterOutlined, CloudServerOutlined, RightOutlined } from '@ant-design/icons'
import { Empty, Progress } from 'antd'
import type { Asset } from '../api'
import type { Placement, Rack } from '../facilities'

interface Props {
  racks: Rack[]
  placements: Placement[]
  assets: Map<number, Asset>
  keyword: string
  onOpen: (rackId: number) => void
}

export function RackCardGrid({ racks, placements, assets, keyword, onOpen }: Props) {
  const needle = keyword.trim().toLowerCase()
  const filtered = needle ? racks.filter(rack => rack.name.toLowerCase().includes(needle)) : racks

  if (!racks.length) {
    return <Empty description="当前数据中心还没有机柜" />
  }
  if (!filtered.length) {
    return <Empty description="没有匹配的机柜" />
  }

  return (
    <div className="rack-card-grid">
      {filtered.map(rack => {
        const devices = placements.filter(item => item.rackId === rack.id)
        const used = devices.reduce((sum, item) => sum + item.units, 0)
        const percent = Math.round(used / rack.heightU * 100)
        return (
          <button key={rack.id} type="button" className="rack-card" onClick={() => onOpen(rack.id)}>
            <div className="rack-card-head">
              <span className="rack-card-name">{rack.name}</span>
              <span className="rack-card-height">{rack.heightU}U</span>
            </div>

            <div className="rack-card-visual">
              <div className="mini-rack">
                <div className="mini-rack-top" />
                <div className="mini-rack-body">
                  {devices.map(device => {
                    const asset = assets.get(device.assetId)
                    const top = (rack.heightU - (device.startU + device.units - 1)) / rack.heightU * 100
                    const height = device.units / rack.heightU * 100
                    return (
                      <span
                        key={device.assetId}
                        className={`mini-rack-device ${asset?.kind === 'switch' ? 'switch' : 'host'}`}
                        style={{ top: `${top}%`, height: `${height}%` }}
                        title={asset?.name}
                      />
                    )
                  })}
                </div>
                <div className="mini-rack-foot" />
              </div>
            </div>

            <div className="rack-card-meta">
              <span><CloudServerOutlined /> {devices.length} 台设备</span>
              <span className="muted">{used} / {rack.heightU}U</span>
            </div>
            <Progress percent={percent} showInfo={false} size="small" />
            <div className="rack-card-foot">
              <span><ClusterOutlined /> 机柜详情</span>
              <span>查看详情 <RightOutlined /></span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
