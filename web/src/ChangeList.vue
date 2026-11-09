<script setup lang="ts">
import type { Change } from './api'

defineProps<{ changes: Change[]; hideAsset?: boolean }>()
const emit = defineEmits<{ open: [id: number] }>()

const actionLabels: Record<string, string> = {
  create: '创建', update: '编辑', discover: '自动发现', sync: '配置同步', move: '宿主机变更',
  missing: '连续未发现', link: '关联资源', unlink: '解除关系',
  room_create: '新增数据中心', room_update: '编辑数据中心', room_delete: '删除数据中心',
  rack_create: '新增机柜', rack_update: '编辑机柜', rack_delete: '删除机柜',
  mount: '设备上架', relocate: '上架位置变更', unmount: '设备下架',
  subnet_create: '新增网段', subnet_update: '编辑网段', subnet_delete: '删除网段',
  ip_allocate: '分配 IP', ip_release: '释放 IP',
}
const fieldLabels: Record<string, string> = {
  name: '名称', status: '状态', lifecycle: '生命周期', platform: '平台', owner: '负责人',
  environment: '环境', address: '地址', cpu: 'CPU', memoryMiB: '内存（MiB）', notes: '备注',
  attributes: '扩展属性', observed: '采集信息', missingCount: '缺失次数',
  columns: '数据中心列数', rows: '数据中心行数', heightU: '机柜高度（U）', column: '机柜所在列', row: '机柜所在行', rotation: '朝向',
  cidr: 'CIDR', gateway: '网关', vlan: 'VLAN', ip: 'IP 地址', assetId: '关联资产', label: '标签',
}
const relationLabels: Record<string, string> = { hosts: '承载' }

function summary(change: Change) {
  if (change.action === 'move') return String(change.before?.fromName ?? '—') + ' → ' + String(change.after?.fromName ?? '—')
  if (change.action === 'link' || change.action === 'unlink') {
    const relation = change.after ?? change.before
    return String(relation?.fromName ?? '—') + ' · ' + (relationLabels[String(relation?.kind)] ?? '关系') + ' · ' + String(relation?.toName ?? '—')
  }
  if (change.action === 'missing') return '请核查平台中的资源状态'
  if (change.action.startsWith('subnet_')) {
    const subnet = change.after ?? change.before
    return [subnet?.name, subnet?.cidr].filter(Boolean).map(String).join(' · ')
  }
  if (change.action === 'ip_allocate' || change.action === 'ip_release') {
    const allocation = change.after ?? change.before
    return [allocation?.ip, allocation?.assetName || allocation?.label].filter(Boolean).map(String).join(' · ')
  }
  if (change.action === 'mount' || change.action === 'relocate' || change.action === 'unmount') {
    function rackPosition(position: Change['before']) {
      if (!position) return ''
      const start = Number(position.startU)
      const end = start + Number(position.units) - 1
      const units = start === end ? 'U' + start : 'U' + start + '–U' + end
      return [position.roomName, position.rackName, units].join(' / ')
    }
    return [rackPosition(change.before), rackPosition(change.after)].filter(Boolean).join(' → ')
  }
  return ''
}

function value(value: unknown): string {
  if (value === '' || value === undefined || value === null) return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function differences(change: Change) {
  if (!change.before || !change.after || !['update', 'sync', 'room_update', 'rack_update', 'subnet_update'].includes(change.action)) return []
  return Object.entries(change.after)
    .filter(([key, after]) => value(change.before?.[key]) !== value(after))
    .map(([key, after]) => ({ field: fieldLabels[key] ?? key, before: value(change.before?.[key]), after: value(after) }))
}

function date(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <a-empty v-if="!changes.length" description="暂无变更记录" />
  <a-timeline v-else>
    <a-timeline-item v-for="change in changes" :key="change.id" color="blue">
      <div class="change-head">
        <a-tag>{{ actionLabels[change.action] ?? change.action }}</a-tag>
        <a-button v-if="!hideAsset && change.assetId" type="link" size="small" @click="emit('open', change.assetId)">
          {{ change.assetName }}
        </a-button>
        <strong v-else-if="!hideAsset">{{ change.assetName }}</strong>
        <span class="muted">{{ change.actor }} · {{ date(change.createdAt) }}</span>
      </div>
      <p v-if="summary(change)" class="change-summary">{{ summary(change) }}</p>
      <div v-for="diff in differences(change)" :key="diff.field" class="change-field">
        <span class="muted">{{ diff.field }}</span>
        <del>{{ diff.before }}</del>
        <span aria-hidden="true">→</span>
        <ins>{{ diff.after }}</ins>
      </div>
    </a-timeline-item>
  </a-timeline>
</template>

<style scoped>
.change-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.change-summary { margin-top: 6px; color: #595959; }
.change-field { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; font-size: 12px; }
.change-field del { color: #8c8c8c; }
.change-field ins { color: #389e0d; text-decoration: none; }
</style>
