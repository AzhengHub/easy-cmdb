import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import type { Asset, Link } from '../api'
import { Chart } from './Chart'

interface Props {
  asset: Asset
  links: Link[]
  assets: Asset[]
  dark: boolean
}

const nodeColors: Record<string, string> = {
  host: '#1677ff',
  vm: '#13c2c2',
  switch: '#52c41a',
}

function shortName(value: string, limit = 12) {
  return value.length > limit ? value.slice(0, limit) + '…' : value
}

export function AssetRelationGraph({ asset, links, assets, dark }: Props) {
  const option = useMemo<EChartsOption>(() => {
    const byID = new Map(assets.map(item => [item.id, item]))
    const neighbors = new Map<number, { asset: Asset; label: string }>()
    for (const link of links) {
      const otherID = link.fromId === asset.id ? link.toId : link.fromId
      const other = byID.get(otherID)
      if (!other || neighbors.has(other.id)) continue
      const label = asset.kind === 'host' && link.fromId === asset.id
        ? '承载'
        : asset.kind === 'vm' && link.toId === asset.id ? '宿主机' : '关联'
      neighbors.set(other.id, { asset: other, label })
    }
    const entries = Array.from(neighbors.values()).slice(0, 8)
    const count = Math.max(entries.length, 1)
    const nodes = [{
      id: String(asset.id),
      name: shortName(asset.name, 14),
      x: 0, y: 0,
      symbolSize: 54,
      symbol: 'roundRect',
      itemStyle: { color: nodeColors[asset.kind], borderRadius: 7 },
      label: { show: true, position: 'bottom' as const, color: dark ? '#f0f0f0' : '#1f1f1f', fontWeight: 600, fontSize: 11, distance: 7 },
    }, ...entries.map((entry, index) => {
      const angle = (Math.PI * 2 * index) / count
      return {
        id: String(entry.asset.id),
        name: shortName(entry.asset.name),
        x: Math.cos(angle) * 105,
        y: Math.sin(angle) * 72,
        symbolSize: 38,
        itemStyle: { color: nodeColors[entry.asset.kind] ?? '#8c8c8c' },
        label: { show: true, position: 'bottom' as const, color: dark ? '#d9d9d9' : '#595959', fontSize: 10 },
      }
    })]
    const edges = entries.map(entry => ({
      source: String(asset.id), target: String(entry.asset.id),
      label: {
        show: entries.length <= 4, formatter: entry.label,
        color: dark ? '#bfbfbf' : '#8c8c8c', fontSize: 9,
      },
      lineStyle: { color: dark ? '#5c5c5c' : '#b7cce8', width: 1.3 },
    }))
    return {
      tooltip: {
        backgroundColor: dark ? '#1f1f1f' : '#fff',
        borderColor: dark ? '#303030' : '#f0f0f0',
        textStyle: { color: dark ? '#f0f0f0' : '#1f1f1f' },
      },
      series: [{
        type: 'graph', layout: 'none', roam: false, animationDuration: 350,
        coordinateSystem: undefined, edgeSymbol: ['none', 'none'],
        data: nodes, links: edges,
        lineStyle: { curveness: 0 },
      }],
    }
  }, [asset, assets, dark, links])

  return <Chart option={option} height={230} dark={dark} />
}
