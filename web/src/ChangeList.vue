<script setup lang="ts">
import { History } from '@lucide/vue'
import type { Change } from './api'

defineProps<{ changes: Change[]; hideAsset?: boolean }>()
const emit = defineEmits<{ open: [id: number] }>()

const actionLabels: Record<string, string> = {
  create: '创建', update: '编辑', discover: '自动发现', sync: '配置同步', move: '宿主机变更',
  missing: '连续未发现', link: '关联资源', unlink: '解除关系',
  room_create: '新增机房', room_update: '编辑机房', room_delete: '删除机房',
  rack_create: '新增机柜', rack_update: '编辑机柜', rack_delete: '删除机柜',
  mount: '设备上架', relocate: '上架位置变更', unmount: '设备下架',
}
const fieldLabels: Record<string, string> = {
  name: '名称', status: '状态', lifecycle: '生命周期', platform: '平台', owner: '负责人',
  environment: '环境', address: '地址', cpu: 'CPU', memoryMiB: '内存（MiB）', notes: '备注',
  attributes: '扩展属性', observed: '采集信息', missingCount: '缺失次数',
  columns: '机房列数', rows: '机房行数', heightU: '机柜高度（U）', column: '机柜所在列', row: '机柜所在行', rotation: '朝向',
}
const relationLabels: Record<string, string> = { contains: '容纳', member: '集群成员', hosts: '承载', uses: '使用资源' }

function summary(change: Change) {
  if (change.action === 'move') return String(change.before?.fromName ?? '—') + ' → ' + String(change.after?.fromName ?? '—')
  if (change.action === 'link' || change.action === 'unlink') {
    const relation = change.after ?? change.before
    return String(relation?.fromName ?? '—') + ' · ' + (relationLabels[String(relation?.kind)] ?? '关系') + ' · ' + String(relation?.toName ?? '—')
  }
  if (change.action === 'missing') return '请核查平台中的资源状态'
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
  if (!change.before || !change.after || !['update', 'sync', 'room_update', 'rack_update'].includes(change.action)) return []
  return Object.entries(change.after)
    .filter(([key, after]) => value(change.before?.[key]) !== value(after))
    .map(([key, after]) => ({ field: fieldLabels[key] ?? key, before: value(change.before?.[key]), after: value(after) }))
}
</script>

<template>
  <div v-if="!changes.length" class="empty-state compact">
    <History :size="23" /><p>暂无变更记录</p>
  </div>
  <div v-else class="change-list">
    <article v-for="change in changes" :key="change.id" class="change-item">
      <div class="change-dot"></div>
      <div>
        <div class="change-header">
          <span class="tag blue">{{ actionLabels[change.action] ?? change.action }}</span>
          <button v-if="!hideAsset && change.assetId" type="button" class="text-button" @click="emit('open', change.assetId)">{{ change.assetName }}</button>
          <strong v-else-if="!hideAsset">{{ change.assetName }}</strong>
          <span class="muted">{{ change.actor }} · {{ new Date(change.createdAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
        </div>
        <p v-if="summary(change)" class="change-summary">{{ summary(change) }}</p>
        <div v-for="diff in differences(change)" :key="diff.field" class="change-field">
          <span>{{ diff.field }}</span><del>{{ diff.before }}</del><span aria-hidden="true">→</span><ins>{{ diff.after }}</ins>
        </div>
      </div>
    </article>
  </div>
</template>
