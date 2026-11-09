<script setup lang="ts">
import { ref } from 'vue'
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
  <a-form layout="vertical" :model="fields" class="asset-form" @finish="save">
    <a-alert v-if="validation || error" type="error" :message="validation || error" show-icon class="form-alert" />
    <a-row :gutter="16">
      <a-col :span="12">
        <a-form-item label="资源类型" required>
          <a-select v-model:value="fields.kind" :disabled="!!asset">
            <a-select-option value="host">物理机</a-select-option>
            <a-select-option value="switch">交换机</a-select-option>
            <a-select-option value="vm">虚拟机</a-select-option>
          </a-select>
        </a-form-item>
      </a-col>
      <a-col :span="12">
        <a-form-item label="资源名称" required>
          <a-input v-model:value="fields.name" maxlength="160" />
        </a-form-item>
      </a-col>
      <a-col :span="12">
        <a-form-item label="平台">
          <a-select v-model:value="fields.platform">
            <a-select-option value="">未指定</a-select-option>
            <a-select-option value="pve">Proxmox VE</a-select-option>
            <a-select-option value="kvm">KVM / libvirt</a-select-option>
          </a-select>
        </a-form-item>
      </a-col>
      <a-col :span="12">
        <a-form-item label="状态">
          <a-select v-model:value="fields.status">
            <a-select-option value="unknown">未知</a-select-option>
            <a-select-option value="online">在线</a-select-option>
            <a-select-option value="offline">离线</a-select-option>
            <a-select-option value="running">运行中</a-select-option>
            <a-select-option value="stopped">已停止</a-select-option>
            <a-select-option value="paused">已暂停</a-select-option>
          </a-select>
        </a-form-item>
      </a-col>
      <a-col :span="12">
        <a-form-item label="负责人">
          <a-input v-model:value="fields.owner" maxlength="160" placeholder="姓名或团队" />
        </a-form-item>
      </a-col>
      <a-col :span="12">
        <a-form-item label="环境">
          <a-input v-model:value="fields.environment" maxlength="40" placeholder="例如：生产" />
        </a-form-item>
      </a-col>
      <a-col :span="24">
        <a-form-item label="管理地址 / IP">
          <a-input v-model:value="fields.address" maxlength="160" placeholder="例如：192.0.2.11" />
        </a-form-item>
      </a-col>
      <a-col :span="12">
        <a-form-item label="CPU 核数 / vCPU">
          <a-input-number v-model:value="fields.cpu" :min="0" :max="65536" style="width: 100%" />
        </a-form-item>
      </a-col>
      <a-col :span="12">
        <a-form-item label="内存（MiB）">
          <a-input-number v-model:value="fields.memoryMiB" :min="0" :max="1073741824" style="width: 100%" />
        </a-form-item>
      </a-col>
      <a-col v-if="asset" :span="24">
        <a-form-item label="生命周期">
          <a-select v-model:value="fields.lifecycle">
            <a-select-option value="active">在册</a-select-option>
            <a-select-option value="retired">已退役</a-select-option>
          </a-select>
        </a-form-item>
      </a-col>
      <a-col :span="24">
        <a-form-item label="备注">
          <a-textarea v-model:value="fields.notes" :rows="3" maxlength="2500" />
        </a-form-item>
      </a-col>
      <a-col :span="24">
        <a-form-item label="扩展属性（JSON）">
          <a-textarea v-model:value="attrs" :rows="4" class="mono" spellcheck="false" />
        </a-form-item>
      </a-col>
    </a-row>
    <a-space class="form-actions">
      <a-button @click="emit('cancel')">取消</a-button>
      <a-button type="primary" html-type="submit" :loading="busy">{{ busy ? '正在保存…' : '保存资产' }}</a-button>
    </a-space>
  </a-form>
</template>

<style scoped>
.form-alert { margin-bottom: 16px; }
.form-actions { display: flex; justify-content: flex-end; }
</style>
