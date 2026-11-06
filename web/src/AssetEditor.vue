<script setup lang="ts">
import { ref } from 'vue'
import { X } from '@lucide/vue'
import type { Asset, AssetFields, Kind } from './api'

const props = defineProps<{
  asset: Asset | null
  defaultKind: Kind
  busy: boolean
  error: string
}>()
const emit = defineEmits<{
  cancel: []
  save: [fields: AssetFields & { version: number }]
}>()

const current = props.asset
const fields = ref<AssetFields>({
  kind: current?.kind ?? props.defaultKind,
  name: current?.name ?? '',
  platform: current?.platform ?? '',
  status: current?.status ?? 'unknown',
  lifecycle: current?.lifecycle ?? 'active',
  owner: current?.owner ?? '',
  environment: current?.environment ?? '',
  address: current?.address ?? '',
  cpu: current?.cpu ?? 0,
  memoryMiB: current?.memoryMiB ?? 0,
  notes: current?.notes ?? '',
  attributes: current?.attributes ?? {},
})
const attrs = ref(JSON.stringify(fields.value.attributes, null, 2))
const validation = ref('')

function save() {
  validation.value = ''
  try {
    const parsed: unknown = JSON.parse(attrs.value || '{}')
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error()
    fields.value.attributes = parsed as Record<string, unknown>
  } catch {
    validation.value = '扩展属性须为有效的 JSON 对象'
    return
  }
  emit('save', {
    ...fields.value,
    cpu: Number(fields.value.cpu || 0),
    memoryMiB: Number(fields.value.memoryMiB || 0),
    version: current?.version ?? 0,
  })
}
</script>

<template>
  <form @submit.prevent="save" class="drawer-form">
    <div class="drawer-title">
      <div>
        <p class="eyebrow">ASSET RECORD</p>
        <h2>{{ asset ? '编辑资产' : '新增资产' }}</h2>
      </div>
      <button type="button" class="icon-button" aria-label="关闭编辑" @click="emit('cancel')"><X :size="19" /></button>
    </div>
    <div class="drawer-body">
      <p v-if="asset?.sourceKey" class="notice">配置由 {{ asset.sourceKey }} 同步。业务资料和扩展属性可在这里维护。</p>
      <p v-if="validation || error" class="error" role="alert">{{ validation || error }}</p>
      <div class="form-grid">
        <label>资源类型
          <select v-model="fields.kind" :disabled="!!asset">
            <option value="host">物理机</option><option value="vm">虚拟机</option>
            <option value="cluster">集群</option><option value="chassis">机箱</option><option value="business">业务</option>
          </select>
        </label>
        <label>资源名称<input v-model.trim="fields.name" :disabled="!!asset?.sourceKey" required maxlength="160" /></label>
        <label>平台
          <select v-model="fields.platform" :disabled="!!asset?.sourceKey">
            <option value="">未指定</option><option value="pve">Proxmox VE</option><option value="kvm">KVM / libvirt</option>
          </select>
        </label>
        <label>状态
          <select v-model="fields.status" :disabled="!!asset?.sourceKey">
            <option value="unknown">未知</option><option value="online">在线</option><option value="offline">离线</option>
            <option value="running">运行中</option><option value="stopped">已停止</option><option value="paused">已暂停</option>
          </select>
        </label>
        <label>负责人<input v-model.trim="fields.owner" maxlength="160" placeholder="姓名或团队" /></label>
        <label>环境<input v-model.trim="fields.environment" maxlength="40" placeholder="例如：生产" /></label>
        <label class="wide">管理地址 / IP<input v-model.trim="fields.address" maxlength="160" placeholder="例如：192.0.2.11" /></label>
        <label>CPU 核数 / vCPU<input v-model.number="fields.cpu" type="number" min="0" max="65536" :disabled="!!asset?.sourceKey" /></label>
        <label>内存（MiB）<input v-model.number="fields.memoryMiB" type="number" min="0" max="1073741824" :disabled="!!asset?.sourceKey" /></label>
        <label v-if="asset" class="wide">生命周期
          <select v-model="fields.lifecycle"><option value="active">在册</option><option value="retired">已退役</option></select>
        </label>
        <label class="wide">备注<textarea v-model="fields.notes" rows="3" maxlength="2500" /></label>
        <label class="wide">扩展属性（JSON）<textarea class="code" v-model="attrs" rows="4" spellcheck="false" /></label>
      </div>
    </div>
    <div class="drawer-footer">
      <button type="button" class="button" @click="emit('cancel')">取消</button>
      <button type="submit" class="button primary" :disabled="busy">{{ busy ? '正在保存…' : '保存资产' }}</button>
    </div>
  </form>
</template>
