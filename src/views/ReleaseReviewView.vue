<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import type { ReleaseApproval } from '@/models/domain'
import { createId } from '@/services/repository'
import { detectReleaseDrift, emptyDrift } from '@/services/releaseSnapshot'
import { releaseReadiness } from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)
const releaseQuery = useReleaseQuery(releaseId)
const release = computed(
  () =>
    releaseQuery.data.value ??
    store.data.releases.find((item) => item.id === releaseId.value) ??
    null,
)
const storeRelease = computed(
  () => store.data.releases.find((item) => item.id === releaseId.value) ?? null,
)
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const readiness = computed(() => (release.value ? releaseReadiness(release.value, store.issues) : 0))
const drift = computed(() =>
  storeRelease.value ? detectReleaseDrift(store.data, storeRelease.value) : null,
)
const hasDrift = computed(() => (drift.value ? !emptyDrift(drift.value) : false))
const currentRevision = computed(() => storeRelease.value?.revision ?? 0)

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const creating = ref(false)
const migrationSubmitting = ref(false)
const approvalSubmitting = ref(false)
const batchSubmitting = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
  idempotencyKey: '',
})
const migrationForm = reactive({
  confirmationId: '',
  reviewer: '',
  note: '',
})
const migrationSubmission = reactive({ expectedRevision: 0, submissionId: '' })
const approvalSubmission = reactive({ expectedRevision: 0, submissionId: '' })
const selectedApprovalIds = ref<string[]>([])
const approvalComment = ref('')
const singleApproval = ref<ReleaseApproval | null>(null)

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
}

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  createForm.idempotencyKey = createId('relsub')
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  if (creating.value) return
  creating.value = true
  try {
    const created = store.createRelease(
      createForm.version,
      createForm.title,
      createForm.eventIds,
      createForm.idempotencyKey,
    )
    releaseId.value = created.id
    createVisible.value = false
    await invalidate()
    await MessagePlugin.success('发布候选已创建，送审内容已冻结并生成下游迁移清单')
  } finally {
    creating.value = false
  }
}

const openMigration = (confirmationId: string): void => {
  const confirmation = release.value?.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationSubmission.expectedRevision = currentRevision.value
  migrationSubmission.submissionId = createId('sub')
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || migrationSubmitting.value) return
  if (!migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  migrationSubmitting.value = true
  try {
    const result = store.confirmMigration(
      release.value.id,
      migrationForm.confirmationId,
      migrationForm.reviewer,
      migrationForm.note,
      {
        expectedRevision: migrationSubmission.expectedRevision,
        submissionId: migrationSubmission.submissionId,
      },
    )
    if (!result.ok) {
      if (result.reason === 'conflict') {
        await invalidate()
        migrationSubmission.expectedRevision = currentRevision.value
        await MessagePlugin.error('该候选刚被其他窗口更新（版本冲突），已载入最新意见，请核对后重新提交')
        return
      }
      await MessagePlugin.error('该确认当前状态不可提交，请刷新后重试')
      return
    }
    migrationVisible.value = false
    await invalidate()
    await MessagePlugin.success(result.duplicated ? '该提交已处理，未重复生成确认' : '下游迁移已确认')
  } finally {
    migrationSubmitting.value = false
  }
}

const openApproval = (approval: ReleaseApproval): void => {
  singleApproval.value = approval
  approvalComment.value = approval.comment
  approvalSubmission.expectedRevision = currentRevision.value
  approvalSubmission.submissionId = createId('sub')
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || approvalSubmitting.value) return
  if (!approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  approvalSubmitting.value = true
  try {
    const result = store.updateApproval(
      release.value.id,
      singleApproval.value.role,
      status,
      singleApproval.value.actor,
      approvalComment.value,
      {
        expectedRevision: approvalSubmission.expectedRevision,
        submissionId: approvalSubmission.submissionId,
      },
    )
    if (!result.ok) {
      if (result.reason === 'conflict') {
        await invalidate()
        approvalSubmission.expectedRevision = currentRevision.value
        await MessagePlugin.error('该候选刚被其他窗口更新（版本冲突），已载入最新意见，请核对后重新提交')
        return
      }
      await MessagePlugin.error('该审批当前状态不可提交，请刷新后重试')
      return
    }
    approvalVisible.value = false
    await invalidate()
    await MessagePlugin.success(status === 'approved' ? '审批已通过' : '审批已驳回')
  } finally {
    approvalSubmitting.value = false
  }
}

const batchApprove = async (): Promise<void> => {
  if (!release.value || batchSubmitting.value) return
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  batchSubmitting.value = true
  try {
    for (const id of selectedApprovalIds.value) {
      const approval = release.value?.approvals.find((item) => item.id === id)
      if (!approval) continue
      const result = store.updateApproval(
        release.value.id,
        approval.role,
        'approved',
        approval.actor,
        approvalComment.value,
        { expectedRevision: currentRevision.value, submissionId: createId('sub') },
      )
      if (!result.ok) {
        if (result.reason === 'conflict') {
          await invalidate()
          await MessagePlugin.error('批量审批期间候选被其他窗口更新，已中止并刷新，请核对后重试')
          return
        }
        await MessagePlugin.error('部分审批提交失败，请刷新后重试')
        return
      }
    }
    selectedApprovalIds.value = []
    approvalComment.value = ''
    await invalidate()
    await MessagePlugin.success('批量审批已提交')
  } finally {
    batchSubmitting.value = false
  }
}

const refreeze = async (): Promise<void> => {
  if (!release.value) return
  const result = store.refreshReleaseSnapshot(release.value.id)
  if (!result.ok) {
    await MessagePlugin.error('当前候选状态不支持重新送审')
    return
  }
  await invalidate()
  await MessagePlugin.success('已按当前契约重新冻结，未受影响的确认继续保留')
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  const result = store.publishRelease(release.value.id)
  if (!result.ok) {
    if (result.reason === 'drift') {
      await MessagePlugin.error('当前契约与送审冻结内容不一致，请先重新送审冻结')
    } else if (result.reason === 'gate') {
      await MessagePlugin.error('迁移确认或四角色审批尚未完成，当前不可发布')
    } else {
      await MessagePlugin.error('当前候选状态不可发布')
    }
    await invalidate()
    return
  }
  await invalidate()
  await MessagePlugin.success('事件契约版本已按送审冻结内容发布')
}

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      frozenAt: release.value.snapshot.frozenAt,
      lineageDigest: release.value.snapshot.overallDigest,
      revision: release.value.revision,
      events: release.value.eventIds.map(eventName),
      differences: release.value.differences,
      affectedDependencies: release.value.affectedDependencyIds.map(dependencyName),
      migrationConfirmations: release.value.migrationConfirmations,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-contract-diff.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const setApprovalChecked = (approvalId: string, checked: unknown): void => {
  selectedApprovalIds.value = checked
    ? [...selectedApprovalIds.value, approvalId]
    : selectedApprovalIds.value.filter((id) => id !== approvalId)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="版本差异与发布评审"
      description="送审时冻结事件契约与血缘摘要，审批、迁移确认和导出均以冻结内容为准；契约或血缘变化会使受影响的确认即时失效。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({ label: `${item.version} ${item.title}`, value: item.id }))"
          />
        </div>
        <div class="filter-actions">
          <t-button variant="outline" :disabled="!release" @click="downloadDiff">
            <template #icon><DownloadIcon /></template>
            导出差异
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <template v-if="release">
      <section v-if="hasDrift && release.status === 'reviewing'" class="drift-banner">
        <div>
          <strong>送审后事件契约或血缘已变化</strong>
          <span>
            <template v-if="drift && drift.eventDrifts.length > 0">
              事件 {{ drift.eventDrifts.map((item) => item.eventKey).join('、') }} 与冻结内容不一致；
            </template>
            {{ drift?.dependencyDrifts.length ?? 0 }} 个下游依赖的血缘受影响，相关确认已失效退回重审，未受影响的确认继续保留。
          </span>
        </div>
        <t-button theme="warning" variant="outline" @click="refreeze">
          <template #icon><RefreshIcon /></template>
          按当前契约重新送审
        </t-button>
      </section>

      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>标题</span>
          <strong>{{ release.title }}</strong>
        </div>
        <div>
          <span>事件范围</span>
          <strong>{{ release.eventIds.length }} 个</strong>
        </div>
        <div>
          <span>血缘摘要</span>
          <strong class="digest">#{{ release.snapshot.overallDigest }}</strong>
          <small>冻结于 {{ new Date(release.snapshot.frozenAt).toLocaleString('zh-CN') }}</small>
        </div>
        <div>
          <span>发布就绪度</span>
          <strong>{{ readiness }}%</strong>
          <small>候选版本 r{{ release.revision }}</small>
        </div>
        <t-button
          theme="primary"
          :disabled="release.status !== 'reviewing'"
          @click="publish"
        >
          发布契约
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>

      <div class="release-grid">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">契约差异（送审冻结）</h2>
            <span class="muted">{{ release.differences.length }} 个事件发生变化</span>
          </div>
          <div class="diff-list">
            <article v-for="difference in release.differences" :key="difference.eventId" class="diff-event">
              <div class="diff-event-head">
                <strong>{{ difference.eventKey }}</strong>
                <span>{{ eventName(difference.eventId) }}</span>
              </div>
              <div class="diff-columns">
                <div class="diff-block">
                  <h4>新增与删除</h4>
                  <ul>
                    <li v-for="item in difference.addedProperties" :key="`add-${item}`">
                      新增属性 {{ item }}
                    </li>
                    <li v-for="item in difference.removedProperties" :key="`remove-${item}`">
                      删除属性 {{ item }}
                    </li>
                  </ul>
                  <span
                    v-if="
                      difference.addedProperties.length === 0 &&
                      difference.removedProperties.length === 0
                    "
                    class="muted"
                  >
                    无属性增删
                  </span>
                </div>
                <div class="diff-block">
                  <h4>兼容性变化</h4>
                  <ul>
                    <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                  </ul>
                  <span
                    v-if="
                      difference.requiredChanges.length === 0 &&
                      difference.typeChanges.length === 0 &&
                      difference.enumChanges.length === 0
                    "
                    class="muted"
                  >
                    无破坏性变化
                  </span>
                </div>
              </div>
            </article>
            <div v-if="release.differences.length === 0" class="empty-state">该版本没有契约差异。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">发布门禁</h2>
          </div>
          <div class="gate-list">
            <div class="gate-row">
              <CheckCircleIcon :class="{ pending: hasDrift }" />
              <div>
                <strong>送审内容已冻结</strong>
                <span v-if="hasDrift">契约或血缘已漂移，需重新送审</span>
                <span v-else>血缘摘要 #{{ release.snapshot.overallDigest }}，与当前契约一致</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: release.migrationConfirmations.some((item) => item.status !== 'confirmed'),
                }"
              />
              <div>
                <strong>下游迁移确认</strong>
                <span>
                  {{
                    release.migrationConfirmations.filter((item) => item.status === 'confirmed').length
                  }}/{{ release.migrationConfirmations.length }} 已确认
                  <template
                    v-if="release.migrationConfirmations.some((item) => item.status === 'invalidated')"
                  >
                    · {{ release.migrationConfirmations.filter((item) => item.status === 'invalidated').length }} 已失效
                  </template>
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{ pending: release.approvals.some((item) => item.status !== 'approved') }"
              />
              <div>
                <strong>四角色批量审批</strong>
                <span>
                  {{ release.approvals.filter((item) => item.status === 'approved').length }}/{{
                    release.approvals.length
                  }}
                  已通过
                  <template v-if="release.approvals.some((item) => item.status === 'invalidated')">
                    · {{ release.approvals.filter((item) => item.status === 'invalidated').length }} 已失效
                  </template>
                </span>
              </div>
            </div>
            <div class="readiness">
              <span>综合就绪度</span>
              <strong>{{ readiness }}%</strong>
              <t-progress :percentage="readiness" :label="false" />
            </div>
          </div>
        </section>
      </div>

      <div class="review-columns">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">下游迁移确认</h2>
          </div>
          <div class="migration-list">
            <article
              v-for="confirmation in release.migrationConfirmations"
              :key="confirmation.id"
              class="migration-card"
            >
              <div>
                <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                <span>{{ confirmation.reviewer || '未指定确认人' }}</span>
              </div>
              <StatusTag :value="confirmation.status" />
              <p>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
              <p v-if="confirmation.status === 'invalidated'" class="invalidated-reason">
                {{ confirmation.invalidatedReason ?? '确认已失效，需重新确认。' }}
              </p>
              <t-button
                variant="outline"
                size="small"
                :disabled="confirmation.status === 'confirmed'"
                @click="openMigration(confirmation.id)"
              >
                {{ confirmation.status === 'invalidated' ? '重新确认' : '确认迁移' }}
              </t-button>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批</h2>
          </div>
          <div class="approval-list">
            <label v-for="approval in release.approvals" :key="approval.id" class="approval-row">
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="approval.status === 'approved'"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>{{ roleLabel(approval.role) }}</strong>
                <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
                <span v-if="approval.status === 'invalidated'" class="invalidated-reason">
                  {{ approval.invalidatedReason ?? '审批已失效，需重新审批。' }}
                </span>
              </div>
              <StatusTag :value="approval.status" />
              <t-button variant="text" size="small" @click.prevent="openApproval(approval)">
                审批
              </t-button>
            </label>
          </div>
          <div class="batch-bar">
            <t-input v-model="approvalComment" placeholder="批量审批意见" />
            <t-button theme="primary" :loading="batchSubmitting" @click="batchApprove">批量通过</t-button>
          </div>
        </section>
      </div>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选" width="720px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>版本号</label>
          <t-input v-model="createForm.version" />
        </div>
        <div class="field">
          <label>发布标题</label>
          <t-input v-model="createForm.title" />
        </div>
        <div class="field field-wide">
          <label>参与发布的事件</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({
                  label: `${event.displayName} (${event.key})`,
                  value: event.id,
                }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" :loading="creating" @click="createRelease">创建并冻结</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="确认下游迁移" width="620px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>确认人</label>
          <t-input v-model="migrationForm.reviewer" />
        </div>
        <div class="field field-wide">
          <label>迁移说明</label>
          <t-textarea v-model="migrationForm.note" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="migrationVisible = false">取消</t-button>
        <t-button theme="primary" :loading="migrationSubmitting" @click="confirmMigration">确认迁移</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="approvalVisible" header="提交审批" width="620px" :footer="false">
      <div v-if="singleApproval" class="selected-approval">
        <strong>{{ roleLabel(singleApproval.role) }}</strong>
        <span>{{ singleApproval.actor }}</span>
      </div>
      <div class="field">
        <label>审批意见</label>
        <t-textarea v-model="approvalComment" :autosize="{ minRows: 5, maxRows: 8 }" />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="approvalVisible = false">取消</t-button>
        <t-button theme="danger" :loading="approvalSubmitting" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" :loading="approvalSubmitting" @click="submitApproval('approved')">
          <template #icon><CheckCircleIcon /></template>
          通过
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.release-field {
  min-width: 390px;
}

.drift-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid #f0c36d;
  border-radius: 6px;
  background: #fff8ec;
}

.drift-banner > div {
  display: grid;
  gap: 4px;
}

.drift-banner strong {
  color: #8a5a00;
  font-size: 13px;
}

.drift-banner span {
  color: #7a6529;
  font-size: 12px;
}

.release-overview {
  display: grid;
  grid-template-columns: 150px minmax(220px, 1fr) 110px 210px 150px auto;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.release-overview > div,
.release-overview > button {
  align-self: stretch;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  align-content: start;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.release-overview small {
  color: #8a93a3;
  font-size: 10px;
}

.release-overview .digest {
  font-family: monospace;
  font-size: 13px;
}

.release-overview > button {
  border-radius: 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
}

.diff-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.diff-event {
  padding: 16px;
  background: #fff;
}

.diff-event-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.diff-event-head strong {
  font-family: monospace;
  font-size: 12px;
}

.diff-event-head span {
  color: #737e90;
  font-size: 11px;
}

.gate-list {
  padding: 10px 16px 18px;
}

.gate-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.gate-row svg {
  color: #0f8a62;
}

.gate-row svg.pending {
  color: #c46a00;
}

.gate-row > div {
  display: grid;
  gap: 4px;
}

.gate-row strong {
  font-size: 12px;
}

.gate-row span,
.readiness span {
  color: #727d8f;
  font-size: 11px;
}

.readiness {
  display: grid;
  gap: 7px;
  padding-top: 16px;
}

.readiness strong {
  font-size: 24px;
}

.review-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.migration-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.migration-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.migration-card > div {
  display: grid;
  gap: 4px;
}

.migration-card span,
.migration-card p {
  color: #6d788b;
  font-size: 11px;
}

.migration-card p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.5;
}

.migration-card .invalidated-reason,
.approval-row .invalidated-reason {
  color: #b42318;
}

.migration-card :deep(.t-button) {
  grid-column: 1 / -1;
  justify-self: start;
}

.approval-list {
  display: grid;
  padding: 6px 16px;
}

.approval-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
  cursor: pointer;
}

.approval-row > div {
  display: grid;
  gap: 4px;
}

.approval-row span {
  color: #717c8e;
  font-size: 11px;
}

.batch-bar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8ebef;
}

.selected-approval {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #fafbfc;
}

.selected-approval span {
  color: #717c8e;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>
