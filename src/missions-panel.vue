<!--
  任务面板：发起 /Submit、查看任务进度与候选、确认后在浏览器里投递并回报。
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { AgentMission, MissionApplyJob, MissionCandidate, PluginConfig } from './types'
import { cancelMission, createMission, listMissions } from './missions-api'
import {
  loadMissionSession,
  resumeMissionApply,
  startMissionApply,
} from './missions-apply'

const props = defineProps<{ config: PluginConfig; loggedIn: boolean }>()

const missions = ref<AgentMission[]>([])
const loading = ref(false)
const error = ref('')
const objective = ref('')
const creating = ref(false)
const expandedId = ref<number | null>(null)
const session = ref(loadMissionSession())

const statusMap: Record<string, { label: string; cls: string }> = {
  pending: { label: '待规划', cls: 's-pending' },
  planning: { label: '规划中', cls: 's-planning' },
  running: { label: '执行中', cls: 's-running' },
  awaiting_apply: { label: '待投递', cls: 's-await' },
  done: { label: '已完成', cls: 's-done' },
  failed: { label: '失败', cls: 's-failed' },
  cancelled: { label: '已取消', cls: 's-cancel' },
}

const ACTIVE_STATUSES = ['pending', 'planning', 'running', 'awaiting_apply']

function statusBadge(status: string): { label: string; cls: string } {
  return statusMap[status] || { label: status, cls: 's-pending' }
}

let refreshTimer: number | undefined

async function refresh(): Promise<void> {
  if (!props.loggedIn) return
  loading.value = true
  error.value = ''
  try {
    missions.value = await listMissions(props.config)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
    scheduleAutoRefresh()
  }
}

/** 有进行中的任务时每 5 秒轮询一次 */
function scheduleAutoRefresh(): void {
  if (refreshTimer !== undefined) clearInterval(refreshTimer)
  refreshTimer = undefined
  if (missions.value.some((m) => ACTIVE_STATUSES.includes(m.status))) {
    refreshTimer = window.setInterval(() => void refresh(), 5000)
  }
}

async function submitMission(): Promise<void> {
  const text = objective.value.trim()
  if (!text || creating.value) return
  creating.value = true
  error.value = ''
  try {
    await createMission(props.config, text)
    objective.value = ''
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    creating.value = false
  }
}

function toggleExpand(id: number): void {
  expandedId.value = expandedId.value === id ? null : id
}

async function cancelTask(mission: AgentMission): Promise<void> {
  if (!confirm(`确定取消任务「${mission.objective}」吗？`)) return
  try {
    await cancelMission(props.config, mission.id)
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function formatSalary(c: MissionCandidate): string {
  const lo = c.salary_min || 0
  const hi = c.salary_max || 0
  if (lo && hi) return `${lo}-${hi}k`
  if (hi) return `${hi}k 以下`
  return '面议'
}

/** 由 checkpoint 的选中应用 + 候选拼出待投递岗位列表 */
function buildApplyJobs(mission: AgentMission): MissionApplyJob[] {
  const checkpoint = mission.checkpoint || {}
  const selected = (checkpoint.selected as Array<{ job_id: number; reason?: string }>) || []
  const appIds = (checkpoint.selected_applications as number[]) || []
  const byJob = new Map(mission.candidates.map((c) => [c.job_id, c]))
  const jobs: MissionApplyJob[] = []
  appIds.forEach((appId, i) => {
    const cand = byJob.get(selected[i]?.job_id ?? 0)
    if (!cand) return
    jobs.push({
      application_id: appId,
      platform: cand.platform,
      title: cand.title,
      company: cand.company,
      city: cand.city,
      salary: formatSalary(cand),
      url: cand.url,
    })
  })
  return jobs
}

function startApply(mission: AgentMission): void {
  const jobs = buildApplyJobs(mission)
  if (!jobs.length) {
    error.value = '没有可投递的岗位（候选或选中信息缺失）'
    return
  }
  if (!confirm(`将逐个打开 ${jobs.length} 个岗位页并在浏览器里投递，确定开始？`)) return
  startMissionApply(props.config, mission.id, jobs)
  session.value = loadMissionSession()
  window.setTimeout(() => {
    session.value = loadMissionSession()
    void refresh()
  }, 1500)
}

function sessionProgress(): string {
  const s = session.value
  if (!s) return ''
  const job = s.jobs[s.index]
  return `正在投递 ${s.index + 1}/${s.jobs.length}：${job?.title ?? '…'}`
}

onMounted(() => {
  void refresh()
  void resumeMissionApply().then((done) => {
    if (done) window.setTimeout(() => void refresh(), 2000)
  })
})

onUnmounted(() => {
  if (refreshTimer !== undefined) clearInterval(refreshTimer)
})

watch(() => props.loggedIn, () => void refresh())
</script>

<template>
  <div class="ms-root">
    <template v-if="!loggedIn">
      <p class="aah-tip">尚未登录后端，请先到「设置」页配置并登录。</p>
    </template>

    <template v-else>
      <p v-if="error" class="aah-error">{{ error }}</p>

      <!-- 投递会话进行中提示 -->
      <div v-if="session" class="ms-session">
        <span>{{ sessionProgress() }}</span>
        <span class="ms-session-hint">页面正在自动跳转投递，请勿关闭面板</span>
      </div>

      <!-- 发起任务 -->
      <div class="ms-create">
        <input
          v-model="objective"
          class="ob-input"
          placeholder="例如：投递 10 个 Python 后端岗位"
          :disabled="creating"
          @keyup.enter="submitMission"
        />
        <button class="aah-btn-primary ms-send" :disabled="creating || !objective.trim()" @click="submitMission">
          {{ creating ? '创建中…' : '发起任务' }}
        </button>
      </div>

      <!-- 任务列表 -->
      <div v-if="loading && !missions.length" class="ob-hint">加载中…</div>
      <p v-else-if="!missions.length" class="ob-hint">
        还没有任务。用一句话告诉 Agent 你想做什么，例如「投递 10 个岗位」。
      </p>

      <div v-for="mission in missions" :key="mission.id" class="ms-card">
        <div class="ms-head" role="button" tabindex="0" @click="toggleExpand(mission.id)" @keydown.enter="toggleExpand(mission.id)">
          <div class="ms-title-wrap">
            <span class="ms-title">{{ mission.objective }}</span>
            <span class="ms-badge" :class="statusBadge(mission.status).cls">{{ statusBadge(mission.status).label }}</span>
          </div>
          <div class="ms-meta">
            <span v-if="mission.result">候选 {{ mission.result.recommended ?? 0 }} · 已投 {{ mission.result.applied ?? 0 }}</span>
            <span v-else-if="mission.candidates?.length">候选 {{ mission.candidates.length }}</span>
            <span class="ms-time">{{ mission.created_at.slice(5, 16) }}</span>
          </div>
        </div>

        <div v-if="expandedId === mission.id" class="ms-detail">
          <!-- 计划 -->
          <div v-if="mission.plan?.steps?.length" class="ms-section">
            <div class="ms-section-title">执行计划</div>
            <div class="ms-steps">
              <span v-for="(step, i) in mission.plan.steps" :key="i" class="ms-step">
                {{ step.platform }} · {{ step.keyword }} · {{ step.city }}
              </span>
            </div>
          </div>

          <!-- 候选 -->
          <div v-if="mission.candidates?.length" class="ms-section">
            <div class="ms-section-title">候选岗位（{{ mission.candidates.length }}）</div>
            <div v-for="c in mission.candidates.slice(0, 10)" :key="c.job_id" class="ms-cand">
              <div class="ms-cand-main">
                <span class="ms-cand-title">{{ c.title }}</span>
                <span class="ms-cand-score">{{ c.score }} 分</span>
              </div>
              <div class="ms-cand-sub">
                {{ c.company }} · {{ c.city }} · {{ formatSalary(c) }}
              </div>
              <div class="ms-cand-reason">{{ c.reason }}</div>
            </div>
          </div>

          <!-- 错误 -->
          <p v-if="mission.error" class="aah-error">{{ mission.error }}</p>

          <!-- 操作 -->
          <div class="ms-ops">
            <button
              v-if="mission.status === 'awaiting_apply'"
              class="aah-btn-primary ms-btn"
              @click="startApply(mission)"
            >
              开始投递（{{ (mission.checkpoint?.selected_applications as number[])?.length ?? 0 }} 个）
            </button>
            <button
              v-if="!['done', 'failed', 'cancelled'].includes(mission.status)"
              class="ms-cancel"
              @click="cancelTask(mission)"
            >
              取消任务
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ms-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ms-session {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
}

.ms-session-hint {
  color: #93c5fd;
  font-size: 11px;
}

.ms-create {
  display: flex;
  gap: 8px;
}

.ms-send {
  width: auto;
  padding: 8px 14px;
  white-space: nowrap;
}

.ms-card {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
}

.ms-head {
  padding: 10px 12px;
  cursor: pointer;
}

.ms-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ms-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ms-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
}

.s-pending,
.s-planning,
.s-running {
  background: #dbeafe;
  color: #1d4ed8;
}

.s-await {
  background: #fef3c7;
  color: #b45309;
}

.s-done {
  background: #dcfce7;
  color: #15803d;
}

.s-failed {
  background: #fee2e2;
  color: #b91c1c;
}

.s-cancel {
  background: #f3f4f6;
  color: #6b7280;
}

.ms-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  color: #9ca3af;
  font-size: 11px;
}

.ms-detail {
  padding: 4px 12px 12px;
  border-top: 1px solid #f3f4f6;
}

.ms-section {
  margin-top: 10px;
}

.ms-section-title {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}

.ms-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ms-step {
  padding: 4px 8px;
  border-radius: 6px;
  background: #f3f4f6;
  color: #374151;
  font-size: 12px;
}

.ms-cand {
  padding: 8px 0;
  border-bottom: 1px dashed #f3f4f6;
}

.ms-cand-main {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.ms-cand-title {
  font-size: 13px;
  color: #111827;
}

.ms-cand-score {
  flex-shrink: 0;
  font-size: 12px;
  color: #2563eb;
}

.ms-cand-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #6b7280;
}

.ms-cand-reason {
  margin-top: 2px;
  font-size: 11px;
  color: #9ca3af;
}

.ms-ops {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}

.ms-btn {
  width: auto;
  padding: 8px 14px;
}

.ms-cancel {
  border: none;
  background: none;
  color: #dc2626;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}
</style>
