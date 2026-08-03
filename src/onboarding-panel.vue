<!--
  画像采集面板：与后端 /api/onboarding/* 对话，采集用户核心画像；
  底部可展开「我的画像」查看/修正已采集字段。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type {
  OnboardingChatMessage,
  OnboardingFieldMeta,
  OnboardingQuestion,
  OnboardingStatus,
  PluginConfig,
} from './types'
import {
  fetchOnboardingStatus,
  patchOnboardingProfile,
  resetOnboardingProfile,
  sendOnboardingChat,
} from './onboarding-api'

const props = defineProps<{ config: PluginConfig; loggedIn: boolean }>()

const loading = ref(false)
const error = ref('')
const status = ref<OnboardingStatus | null>(null)
const messages = ref<OnboardingChatMessage[]>([])
const input = ref('')
const sending = ref(false)
const showProfile = ref(false)

const tierNames: Record<string, string> = { core: '核心', important: '重要', optional: '可选' }
const tierOrder = ['core', 'important', 'optional']

const completeness = computed(() => status.value?.completeness ?? null)
const fields = computed(() => status.value?.fields ?? [])
const hasMessages = computed(() => messages.value.length > 0)

/** 字段按层级分组（保持问题库顺序） */
const fieldsByTier = computed(() => {
  const grouped: Record<string, OnboardingFieldMeta[]> = { core: [], important: [], optional: [] }
  for (const f of fields.value) grouped[f.tier]?.push(f)
  return grouped
})

function pushQuestion(q: OnboardingQuestion | null): void {
  if (!q) return
  messages.value.push({ role: 'assistant', content: q.question, question: q, kind: 'question' })
}

/** 拉取画像状态；进行中的层级会自动补一条「下一问题」气泡 */
async function loadStatus(): Promise<void> {
  if (!props.loggedIn) return
  loading.value = true
  error.value = ''
  try {
    const next = await fetchOnboardingStatus(props.config)
    status.value = next
    const last = messages.value[messages.value.length - 1]
    if (
      next.onboarding?.status === 'active' &&
      next.next_question &&
      last?.question?.id !== next.next_question.id
    ) {
      pushQuestion(next.next_question)
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** 发送回答或命令 */
async function send(text?: string): Promise<void> {
  const msg = (text ?? input.value).trim()
  if (!msg || sending.value || !props.loggedIn) return
  input.value = ''
  messages.value.push({ role: 'user', content: msg })
  sending.value = true
  error.value = ''
  try {
    const res = await sendOnboardingChat(props.config, msg)
    // 合并最新画像数据与完整度（提取的字段立即反映到「我的画像」）
    const data = { ...(status.value?.data ?? {}), ...res.extracted }
    status.value = {
      data,
      fields: status.value?.fields ?? [],
      completeness: res.completeness,
      onboarding: { ...(status.value?.onboarding ?? {}), tier: res.tier ?? undefined },
      next_question: res.question,
    }
    const content = res.reply || res.question?.question || ''
    messages.value.push({
      role: 'assistant',
      content,
      question: res.question,
      kind: res.done ? 'done' : 'question',
    })
  } catch (e) {
    error.value = (e as Error).message
    messages.value.push({ role: 'assistant', content: (e as Error).message, kind: 'error' })
  } finally {
    sending.value = false
  }
}

function startOnboarding(): void {
  void send('/Describe yourself')
}

function skipQuestion(): void {
  void send('/skip')
}

function finishEarly(): void {
  void send('/done')
}

// ---- 我的画像：查看与修正 ----

const editingField = ref<string | null>(null)
const editValue = ref('')
const editError = ref('')

function valueToString(v: unknown): string {
  if (Array.isArray(v)) return v.join('、')
  if (v === null || v === undefined || v === '') return ''
  return String(v)
}

function beginEdit(field: OnboardingFieldMeta): void {
  editingField.value = field.name
  editValue.value = valueToString(status.value?.data?.[field.name])
  editError.value = ''
}

function cancelEdit(): void {
  editingField.value = null
  editValue.value = ''
  editError.value = ''
}

function parseFieldValue(raw: string): unknown {
  const text = raw.trim()
  if (!text) return text
  // 包含分隔符时按列表存储（覆盖 value_type=list 的字段）
  if (text.includes('、') || text.includes(',') || text.includes('，')) {
    return text
      .split(/[、,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const num = Number(text)
  return Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(text) ? num : text
}

async function saveEdit(): Promise<void> {
  if (editingField.value === null) return
  const fieldName = editingField.value
  editError.value = ''
  try {
    await patchOnboardingProfile(props.config, { [fieldName]: parseFieldValue(editValue.value) })
    cancelEdit()
    await loadStatus()
  } catch (e) {
    editError.value = (e as Error).message
  }
}

async function doReset(): Promise<void> {
  if (!confirm('确定清空画像并重新开始采集吗？\n\n清空后所有字段需要重新填写。')) return
  try {
    await resetOnboardingProfile(props.config)
    messages.value = []
    status.value = null
    await loadStatus()
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(loadStatus)
watch(() => props.loggedIn, loadStatus)
</script>

<template>
  <div class="ob-root">
    <!-- 未登录提示 -->
    <template v-if="!loggedIn">
      <p class="aah-tip">尚未登录后端，请先到「设置」页填写后端地址并登录。</p>
    </template>

    <template v-else>
      <p v-if="error" class="aah-error">{{ error }}</p>

      <!-- 完整度概览 -->
      <div v-if="completeness" class="ob-completeness">
        <div
          v-for="tier in tierOrder"
          :key="tier"
          class="ob-tier"
          :class="{ done: completeness[tier].ratio >= (tier === 'core' ? 1 : tier === 'important' ? 0.8 : 0) }"
        >
          <span class="ob-tier-name">{{ tierNames[tier] }}</span>
          <span class="ob-tier-count">{{ completeness[tier].filled }}/{{ completeness[tier].total }}</span>
        </div>
      </div>

      <!-- 快捷操作 -->
      <div class="ob-actions">
        <button class="aah-btn-secondary" @click="startOnboarding">开始采集</button>
        <button class="aah-btn-secondary" :disabled="sending" @click="skipQuestion">跳过</button>
        <button class="aah-btn-secondary" :disabled="sending" @click="finishEarly">结束</button>
        <button class="aah-btn-secondary" @click="showProfile = !showProfile">
          {{ showProfile ? '收起画像' : '我的画像' }}
        </button>
      </div>

      <!-- 对话区 -->
      <div class="ob-chat">
        <div v-if="loading && !hasMessages" class="ob-hint">加载画像状态…</div>
        <div v-else-if="!hasMessages" class="ob-hint">
          和 Agent 聊几句，帮你建立求职画像。点击「开始采集」或直接输入
          <code>/Describe yourself</code>。
        </div>
        <div
          v-for="(msg, idx) in messages"
          :key="idx"
          class="ob-bubble"
          :class="msg.role === 'user' ? 'ob-user' : 'ob-assistant'"
        >
          <template v-if="msg.question">
            <div class="ob-q-text">{{ msg.question.question }}</div>
            <div v-if="msg.question.options.length" class="ob-options">
              <button
                v-for="opt in msg.question.options"
                :key="opt"
                class="ob-option"
                :disabled="sending"
                @click="send(opt)"
              >
                {{ opt }}
              </button>
            </div>
            <button v-if="msg.question.skippable" class="ob-skip" :disabled="sending" @click="skipQuestion">
              跳过这个问题
            </button>
          </template>
          <template v-else>
            <span v-if="msg.kind === 'error'" class="ob-error-text">{{ msg.content }}</span>
            <span v-else>{{ msg.content }}</span>
          </template>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="ob-input-row">
        <input
          v-model="input"
          class="ob-input"
          placeholder="输入回答，或 /Describe yourself /skip /done"
          :disabled="sending"
          @keyup.enter="send()"
        />
        <button class="aah-btn-primary ob-send" :disabled="sending || !input.trim()" @click="send()">
          {{ sending ? '…' : '发送' }}
        </button>
      </div>

      <!-- 我的画像：查看与修正 -->
      <div v-if="showProfile" class="ob-profile">
        <div v-for="tier in tierOrder" :key="tier" class="ob-profile-group">
          <h4 class="ob-group-title">{{ tierNames[tier] }}</h4>
          <div
            v-for="field in fieldsByTier[tier]"
            :key="field.name"
            class="ob-field"
            :class="{ editing: editingField === field.name }"
          >
            <template v-if="editingField === field.name">
              <span class="ob-field-label">{{ field.label }}</span>
              <input
                v-model="editValue"
                class="ob-input"
                placeholder="多个值用顿号分隔"
                @keyup.enter="saveEdit"
              />
              <div class="ob-field-ops">
                <button class="ob-mini-btn ob-mini-ok" @click="saveEdit">保存</button>
                <button class="ob-mini-btn" @click="cancelEdit">取消</button>
              </div>
              <span v-if="editError" class="aah-error">{{ editError }}</span>
            </template>
            <template v-else>
              <span class="ob-field-label" :title="field.label">{{ field.label }}</span>
              <span class="ob-field-value">{{ valueToString(status?.data?.[field.name]) || '未填写' }}</span>
              <button class="ob-mini-btn" @click="beginEdit(field)">编辑</button>
            </template>
          </div>
        </div>
        <button class="ob-reset" @click="doReset">清空画像，重新采集</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ob-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ob-completeness {
  display: flex;
  gap: 8px;
}

.ob-tier {
  flex: 1;
  display: flex;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 8px;
  background: #f3f4f6;
  font-size: 12px;
  color: #374151;
}

.ob-tier.done {
  background: #dcfce7;
  color: #15803d;
}

.ob-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ob-actions .aah-btn-secondary {
  flex: 1;
  min-width: 0;
}

.ob-chat {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 38vh;
  overflow-y: auto;
  padding: 4px 2px;
}

.ob-hint {
  color: #9ca3af;
  font-size: 12px;
  text-align: center;
  padding: 12px 0;
}

.ob-bubble {
  max-width: 92%;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
}

.ob-user {
  align-self: flex-end;
  background: #2563eb;
  color: #fff;
  border-bottom-right-radius: 2px;
}

.ob-assistant {
  align-self: flex-start;
  background: #f3f4f6;
  color: #1f2937;
  border-bottom-left-radius: 2px;
}

.ob-q-text {
  margin-bottom: 6px;
}

.ob-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ob-option {
  padding: 5px 10px;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
}

.ob-option:hover {
  background: #dbeafe;
}

.ob-skip {
  margin-top: 6px;
  border: none;
  background: none;
  color: #9ca3af;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

.ob-error-text {
  color: #dc2626;
}

.ob-input-row {
  display: flex;
  gap: 8px;
}

.ob-input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 13px;
  background: #fff;
  color: #111827;
}

.ob-input:focus {
  outline: none;
  border-color: #2563eb;
}

.ob-send {
  width: auto;
  padding: 8px 16px;
}

.ob-profile {
  border-top: 1px solid #e5e7eb;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ob-group-title {
  margin: 4px 0;
  font-size: 12px;
  color: #6b7280;
}

.ob-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 5px 0;
}

.ob-field.editing {
  flex-wrap: wrap;
}

.ob-field-label {
  flex: 0 0 88px;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ob-field-value {
  flex: 1;
  min-width: 0;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ob-field.editing .ob-input {
  width: 100%;
}

.ob-field-ops {
  display: flex;
  gap: 6px;
}

.ob-mini-btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #374151;
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 12px;
  cursor: pointer;
}

.ob-mini-ok {
  border-color: #2563eb;
  color: #2563eb;
}

.ob-reset {
  align-self: flex-start;
  border: none;
  background: none;
  color: #dc2626;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
</style>
