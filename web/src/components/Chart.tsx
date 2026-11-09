import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'

export function Chart({ option, height = 240 }: { option: EChartsOption; height?: number }) {
  const holder = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!holder.current) return
    chart.current = echarts.init(holder.current)
    const observer = new ResizeObserver(() => chart.current?.resize())
    observer.observe(holder.current)
    return () => {
      observer.disconnect()
      chart.current?.dispose()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, true)
  }, [option])

  return <div ref={holder} style={{ width: '100%', height }} />
}
