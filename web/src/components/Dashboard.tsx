import { useMemo } from 'react'
import { Card, Col, Empty, List, Progress, Row, Statistic, Tag } from 'antd'
import {
  ApartmentOutlined, CloudServerOutlined, DesktopOutlined, GlobalOutlined,
  HddOutlined, SwapOutlined,
} from '@ant-design/icons'
import type { EChartsOption } from 'echarts'
import type { Asset, Change, Subnet } from '../api'
import type { Facilities } from '../facilities'
import type { Page } from '../types'
import { Chart } from './Chart'
import { ChangeList } from './ChangeList'

interface Props {
  assets: Asset[]
  subnets: Subnet[]
  facilities: Facilities
  changes: Change[]
  dark: boolean
  onGo: (page: Page) => void
  onOpenAsset: (id: number) => void
}

const colors = ['#1677ff', '#13c2c2', '#faad14', '#722ed1', '#52c41a']

export function Dashboard({ assets, subnets, facilities, changes, dark, onGo, onOpenAsset }: Props) {
  const stats = useMemo(() => {
    const active = assets.filter(asset => asset.lifecycle === 'active')
    const hosts = active.filter(asset => asset.kind === 'host')
    const vms = active.filter(asset => asset.kind === 'vm')
    const switches = active.filter(asset => asset.kind === 'switch')
    return {
      active,
      hosts,
      vms,
      switches,
      running: vms.filter(asset => asset.status === 'running').length,
      usable: subnets.reduce((sum, item) => sum + item.usable, 0),
      used: subnets.reduce((sum, item) => sum + item.used, 0),
      free: subnets.reduce((sum, item) => sum + item.free, 0),
    }
  }, [assets, subnets])

  const typeOption = useMemo<EChartsOption>(() => ({
    tooltip: {
      trigger: 'item',
      backgroundColor: dark ? '#1f1f1f' : '#ffffff',
      borderColor: dark ? '#303030' : '#f0f0f0',
      textStyle: { color: dark ? '#f0f0f0' : '#1f1f1f' },
    },
    legend: {
      bottom: 0, left: 'center',
      textStyle: { color: dark ? '#d9d9d9' : '#595959' },
    },
    color: colors,
    series: [{
      type: 'pie',
      radius: ['45%', '70%'],
      center: ['50%', '44%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: dark ? '#1f1f1f' : '#fff', borderWidth: 2 },
      label: { show: false },
      data: [
        { value: stats.hosts.length, name: '物理机' },
        { value: stats.vms.length, name: '虚拟机' },
        { value: stats.switches.length, name: '交换机' },
      ],
    }],
  }), [dark, stats])

  const vmStatusOption = useMemo<EChartsOption>(() => {
    const labels: Record<string, string> = {
      running: '运行中', stopped: '已停止', paused: '已暂停', offline: '离线', online: '在线', unknown: '未知',
    }
    const counts = new Map<string, number>()
    for (const vm of stats.vms) counts.set(vm.status, (counts.get(vm.status) ?? 0) + 1)
    return {
      tooltip: {
        trigger: 'item',
        backgroundColor: dark ? '#1f1f1f' : '#ffffff',
        borderColor: dark ? '#303030' : '#f0f0f0',
        textStyle: { color: dark ? '#f0f0f0' : '#1f1f1f' },
      },
      legend: {
        bottom: 0, left: 'center',
        textStyle: { color: dark ? '#d9d9d9' : '#595959' },
      },
      color: ['#52c41a', '#bfbfbf', '#faad14', '#ff4d4f', '#1677ff'],
      series: [{
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['50%', '44%'],
        itemStyle: { borderColor: dark ? '#1f1f1f' : '#fff', borderWidth: 2 },
        label: { show: false },
        data: Array.from(counts, ([key, value]) => ({ value, name: labels[key] ?? key })),
      }],
    }
  }, [dark, stats.vms])

  const platformOption = useMemo<EChartsOption>(() => {
    const labels: Record<string, string> = { pve: 'Proxmox VE', kvm: 'KVM / libvirt', '': '未指定' }
    const counts = new Map<string, number>()
    for (const asset of [...stats.hosts, ...stats.vms]) counts.set(asset.platform, (counts.get(asset.platform) ?? 0) + 1)
    return {
      tooltip: {
        trigger: 'axis',
        backgroundColor: dark ? '#1f1f1f' : '#ffffff',
        borderColor: dark ? '#303030' : '#f0f0f0',
        textStyle: { color: dark ? '#f0f0f0' : '#1f1f1f' },
      },
      grid: { left: 8, right: 12, bottom: 8, top: 20, containLabel: true },
      xAxis: {
        type: 'category', data: Array.from(counts.keys(), key => labels[key] ?? key), axisTick: { show: false },
        axisLabel: { color: dark ? '#d9d9d9' : '#595959' },
      },
      yAxis: {
        type: 'value', minInterval: 1,
        axisLabel: { color: dark ? '#d9d9d9' : '#595959' },
        splitLine: { lineStyle: { color: dark ? '#303030' : '#f0f0f0' } },
      },
      series: [{
        type: 'bar',
        barMaxWidth: 42,
        itemStyle: { color: '#1677ff', borderRadius: [4, 4, 0, 0] },
        data: Array.from(counts.values()),
      }],
    }
  }, [dark, stats.hosts, stats.vms])

  const subnetOption = useMemo<EChartsOption>(() => {
    const top = [...subnets].sort((a, b) => b.used / Math.max(1, b.usable) - a.used / Math.max(1, a.usable)).slice(0, 6).reverse()
    return {
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: dark ? '#1f1f1f' : '#ffffff',
        borderColor: dark ? '#303030' : '#f0f0f0',
        textStyle: { color: dark ? '#f0f0f0' : '#1f1f1f' },
      },
      grid: { left: 8, right: 24, bottom: 8, top: 10, containLabel: true },
      xAxis: {
        type: 'value', max: 100, axisLabel: { formatter: '{value}%', color: dark ? '#d9d9d9' : '#595959' },
        splitLine: { lineStyle: { color: dark ? '#303030' : '#f0f0f0' } },
      },
      yAxis: {
        type: 'category', data: top.map(item => `${item.name} ${item.cidr}`),
        axisLabel: { color: dark ? '#d9d9d9' : '#595959' },
      },
      series: [{
        type: 'bar',
        barMaxWidth: 20,
        itemStyle: { color: '#13c2c2', borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right', formatter: '{c}%', color: dark ? '#d9d9d9' : '#1f1f1f' },
        data: top.map(item => Math.round(item.used / Math.max(1, item.usable) * 100)),
      }],
    }
  }, [dark, subnets])

  const ipPercent = stats.usable ? Math.round(stats.used / stats.usable * 100) : 0

  return (
    <div>
      <Row gutter={[16, 16]} className="metric-row">
        {[
          { label: '资产总数', value: stats.active.length, icon: <HddOutlined />, hint: '在册资产', target: undefined },
          { label: '物理机', value: stats.hosts.length, icon: <CloudServerOutlined />, hint: '独立主机与虚拟化节点', target: 'host' as Page },
          { label: '虚拟机', value: stats.vms.length, icon: <DesktopOutlined />, hint: `${stats.running} 台运行中`, target: 'vm' as Page },
          { label: '交换机', value: stats.switches.length, icon: <SwapOutlined />, hint: '网络设备', target: 'switch' as Page },
          { label: '数据中心', value: facilities.rooms.length, icon: <ApartmentOutlined />, hint: `${facilities.racks.length} 台机柜`, target: 'facilities' as Page },
          { label: 'IP 空闲', value: stats.free, icon: <GlobalOutlined />, hint: `${subnets.length} 个网段 · 使用率 ${ipPercent}%`, target: 'ipam' as Page },
        ].map(item => (
          <Col key={item.label} xs={24} sm={12} lg={8} xl={4}>
            <Card
              hoverable={!!item.target} className="metric-card"
              style={{ cursor: item.target ? 'pointer' : 'default' }}
              onClick={() => item.target && onGo(item.target)}
            >
              <span className="metric-icon">{item.icon}</span>
              <Statistic title={item.label} value={item.value} />
              <div className="metric-hint">{item.hint}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} className="dashboard-grid">
        <Col xs={24} lg={8}>
          <Card title="资源类型" size="small">
            {stats.active.length ? <Chart option={typeOption} dark={dark} /> : <div className="dashboard-chart-empty"><Empty description="暂无资产" /></div>}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="虚拟机状态" size="small">
            {stats.vms.length ? <Chart option={vmStatusOption} dark={dark} /> : <div className="dashboard-chart-empty"><Empty description="暂无虚拟机" /></div>}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="平台分布" size="small">
            {stats.hosts.length + stats.vms.length ? <Chart option={platformOption} dark={dark} /> : <div className="dashboard-chart-empty"><Empty description="暂无物理机或虚拟机" /></div>}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="dashboard-section">
        <Col xs={24} lg={14}>
          <Card title="网段使用率" size="small">
            {subnets.length ? <Chart option={subnetOption} height={280} dark={dark} /> : <div className="dashboard-chart-empty"><Empty description="暂无网段" /></div>}
            <div style={{ marginTop: 12 }}>
              <Progress percent={ipPercent} status={ipPercent > 85 ? 'exception' : 'normal'} />
              <div className="muted">可用 {stats.usable.toLocaleString()} · 已用 {stats.used.toLocaleString()} · 空闲 {stats.free.toLocaleString()}</div>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="最近变更" size="small">
            {changes.length ? <ChangeList changes={changes.slice(0, 6)} onOpen={onOpenAsset} /> : <Empty description="暂无变更记录" />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="dashboard-section">
        <Col xs={24}>
          <Card title="快速入口" size="small">
            <List
              dataSource={[
                { title: '维护物理机', desc: '查看服务器、宿主机和硬件信息', page: 'host' as Page, tag: '物理机' },
                { title: '维护虚拟机', desc: '查看虚拟机状态和宿主机关系', page: 'vm' as Page, tag: '虚拟机' },
                { title: '管理网段', desc: '查看网段使用率、已用和空闲 IP', page: 'ipam' as Page, tag: 'IPAM' },
                { title: '查看数据中心', desc: '机柜、U 位和三维布局', page: 'facilities' as Page, tag: '数据中心' },
              ]}
              renderItem={item => (
                <List.Item onClick={() => onGo(item.page)} style={{ cursor: 'pointer' }}>
                  <List.Item.Meta title={item.title} description={item.desc} />
                  <Tag color="blue">{item.tag}</Tag>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
