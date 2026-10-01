<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  ErrorCircleIcon,
  LockOnIcon,
  RefreshIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import type { ReleaseApproval } from '@/models/domain'
import { releaseDrift } from '@/services/freeze'
import { VersionConflictError } from '@/services/repository'
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
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const readiness = computed(() => (release.value ? releaseReadiness(release.value, store.issues) : 0))

/** 乐观锁：本窗口打开候选时看到的版本号，提交时必须仍等于它。 */
const expectedRevision = ref(0)
const refreshRevision = (): void => {
  expectedRevision.value = release.value?.revision ?? 0
}
watch(
  () => release.value?.id,
  () => refreshRevision(),
)

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
  requestId: '',
})
const migrationForm = reactive({
  confirmationId: '',
  reviewer: '',
  note: '',
})
const selectedApprovalIds = ref<string[]>([])
const approvalComment = ref('')
const singleApproval = ref<ReleaseApproval | null>(null)

const drift = computed(() =>
  release.value ? releaseDrift(store.data, release.value) : { drifted: false, changedEventIds: [], changedDependencyIds: [] },
)
const frozenAtText = computed(() =>
  release.value?.frozenSnapshot
    ? new Date(release.value.frozenSnapshot.frozenAt).toLocaleString('zh-CN')
    : '',
)
const lineageDigestShort = computed(() =>
  release.value?.frozenSnapshot?.lineageDigest.slice(0, 8) ?? '',
)
const invalidatedConfirmations = computed(
  () => release.value?.migrationConfirmations.filter((item) => item.invalidated) ?? [],
)
const invalidatedApprovals = computed(
  () => release.value?.approvals.filter((item) => item.invalidated) ?? [],
)

const eventName = (eventId: string): string => {
  const frozen = release.value?.frozenSnapshot?.events.find((item) => item.event.id === eventId)
  if (frozen) return `${frozen.event.displayName} (${frozen.event.key})`
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
  refreshRevision()
}

const onRemoteUpdate = (): void => {
  void invalidate()
  void MessagePlugin.warning('检测到其他窗口已提交该候选，本地版本已刷新')
}
onMounted(() => {
  refreshRevision()
  window.addEventListener('eventrail:remote-update', onRemoteUpdate)
})
onUnmounted(() => window.removeEventListener('eventrail:remote-update', onRemoteUpdate))

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  // 幂等键在打开弹窗时生成一次；写入失败后重试复用它，不重复生成迁移确认。
  createForm.requestId = `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  try {
    const result = store.createRelease(
      createForm.version,
      createForm.title,
      createForm.eventIds,
      createForm.requestId,
    )
    releaseId.value = result.release.id
    createVisible.value = false
    await invalidate()
    await MessagePlugin.success(
      result.recovered
        ? '已从写入前的完整候选恢复，未重复生成迁移确认'
        : '发布候选已冻结送审，已生成下游迁移清单',
    )
  } catch {
    await MessagePlugin.error(
      `写入失败，已从最后一个完整候选恢复（${store.writeError ?? '未知错误'}）。请直接重试，不会重复生成确认。`,
    )
  }
}

const injectWriteFailure = async (): Promise<void> => {
  const { setFailNextWrite } = await import('@/services/repository')
  setFailNextWrite(true)
  await MessagePlugin.warning('下一次写入将模拟失败，可重试创建/确认观察恢复行为')
}

const openMigration = (confirmationId: string): void => {
  const confirmation = release.value?.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  try {
    store.confirmMigration(
      release.value.id,
      migrationForm.confirmationId,
      migrationForm.reviewer,
      migrationForm.note,
      expectedRevision.value,
    )
    migrationVisible.value = false
    await invalidate()
    await MessagePlugin.success('下游迁移已按冻结血缘确认')
  } catch (error) {
    if (error instanceof VersionConflictError) {
      await invalidate()
      await MessagePlugin.error(
        `版本冲突：该候选刚被其他窗口更新（r${error.actualRevision}），你的意见未覆盖对方提交，请刷新后重提`,
      )
    } else {
      await MessagePlugin.error('写入失败，已从最后一个完整候选恢复，请重试')
    }
  }
}

const openApproval = (approval: ReleaseApproval): void => {
  singleApproval.value = approval
  approvalComment.value = approval.invalidated ? '' : approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  try {
    store.updateApproval(
      release.value.id,
      singleApproval.value.role,
      status,
      singleApproval.value.actor,
      approvalComment.value,
      expectedRevision.value,
    )
    approvalVisible.value = false
    await invalidate()
    await MessagePlugin.success(status === 'approved' ? '审批已通过' : '审批已驳回')
  } catch (error) {
    if (error instanceof VersionConflictError) {
      await invalidate()
      await MessagePlugin.error(
        `版本冲突：该候选刚被其他窗口更新（r${error.actualRevision}），你的意见未覆盖对方提交，请刷新后重提`,
      )
    } else {
      await MessagePlugin.error('写入失败，已从最后一个完整候选恢复，请重试')
    }
  }
}

const batchApprove = async (): Promise<void> => {
  if (!release.value) return
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  try {
    for (const id of selectedApprovalIds.value) {
      const approval = store.data.releases
        .find((item) => item.id === release.value!.id)
        ?.approvals.find((item) => item.id === id)
      if (!approval) continue
      store.updateApproval(
        release.value.id,
        approval.role,
        'approved',
        approval.actor,
        approvalComment.value,
        expectedRevision.value,
      )
      // 每次成功提交后跟随最新修订号，保证同窗口连续提交不被自己判定为冲突。
      expectedRevision.value += 1
    }
    selectedApprovalIds.value = []
    approvalComment.value = ''
    await invalidate()
    await MessagePlugin.success('批量审批已提交')
  } catch (error) {
    await invalidate()
    await MessagePlugin.error(
      error instanceof VersionConflictError
        ? `版本冲突：该候选刚被其他窗口更新（r${error.actualRevision}），批量审批已中断，未覆盖对方意见`
        : '写入失败，已从最后一个完整候选恢复，请重试',
    )
  }
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  if (drift.value.drifted) {
    await MessagePlugin.error('冻结之后事件或血缘已变化，受影响确认退回重审后才能发布')
    return
  }
  if (!store.publishRelease(release.value.id)) {
    await MessagePlugin.error('迁移确认或四角色审批尚未全部完成（失效项不计入），当前不可发布')
    return
  }
  await invalidate()
  await MessagePlugin.success('事件契约版本已按冻结快照发布')
}

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      frozenAt: release.value.frozenSnapshot?.frozenAt,
      lineageDigest: release.value.frozenSnapshot?.lineageDigest,
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

const downloadFrozen = (): void => {
  if (!release.value) return
  const content = store.exportFrozenRelease(release.value.id)
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-frozen-contract.json`
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
      description="比较发布候选契约，生成受影响依赖，要求迁移确认并完成数据、产品、客户端和测试四角色审批。"
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
          <t-button variant="outline" :disabled="!release?.frozenSnapshot" @click="downloadFrozen">
            <template #icon><LockOnIcon /></template>
            导出冻结契约
          </t-button>
          <t-button variant="outline" theme="warning" @click="injectWriteFailure">
            <template #icon><ErrorCircleIcon /></template>
            模拟下次写入失败
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <section v-if="release?.frozenSnapshot" class="panel freeze-banner" :class="{ drifted: drift.drifted }">
      <LockOnIcon />
      <div class="freeze-text">
        <strong>
          送审冻结于 {{ frozenAtText }} · 血缘摘要 {{ lineageDigestShort }} · 修订 r{{ release.revision }}
        </strong>
        <span>审批、迁移确认与导出均以送审时冻结的事件、属性和依赖关系为准。</span>
      </div>
      <StatusTag v-if="drift.drifted" value="invalidated" />
      <StatusTag v-else value="confirmed" />
      <div v-if="store.lastRecovery" class="freeze-recovery">
        <RefreshIcon />
        <span>
          上次写入失败后已于 {{ new Date(store.lastRecovery.recoveredAt).toLocaleTimeString('zh-CN') }}
          从最后一个完整候选恢复{{ store.lastRecovery.requestId ? `（${store.lastRecovery.requestId}）` : '' }}
        </span>
      </div>
    </section>

    <section v-if="drift.drifted" class="panel drift-panel">
      <ErrorCircleIcon />
      <div>
        <strong>冻结血缘已漂移，受影响的未发布确认已退回重审</strong>
        <p>
          变化事件：{{ drift.changedEventIds.map(eventName).join('、') || '无' }}；
          受影响下游：{{ drift.changedDependencyIds.map(dependencyName).join('、') || '无' }}。
          未受影响的迁移确认继续保留；所有审批均需按当前契约重新会签后才能放行。
        </p>
      </div>
    </section>

    <template v-if="release">
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
          <span>发布就绪度</span>
          <strong>{{ readiness }}%</strong>
        </div>
        <t-button
          theme="primary"
          :disabled="release.status === 'published' || release.status === 'rolled_back'"
          @click="publish"
        >
          发布契约
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>

      <div class="release-grid">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">契约差异</h2>
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
              <CheckCircleIcon />
              <div>
                <strong>契约差异已生成</strong>
                <span>{{ release.differences.length }} 个事件参与比较</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: release.migrationConfirmations.some(
                    (item) => item.status !== 'confirmed' || item.invalidated,
                  ),
                }"
              />
              <div>
                <strong>下游迁移确认</strong>
                <span>
                  {{
                    release.migrationConfirmations.filter(
                      (item) => item.status === 'confirmed' && !item.invalidated,
                    ).length
                  }}/{{ release.migrationConfirmations.length }} 已确认
                  <em v-if="invalidatedConfirmations.length">
                    （{{ invalidatedConfirmations.length }} 项因血缘变化失效）
                  </em>
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: release.approvals.some(
                    (item) => item.status !== 'approved' || item.invalidated,
                  ),
                }"
              />
              <div>
                <strong>四角色批量审批</strong>
                <span>
                  {{
                    release.approvals.filter((item) => item.status === 'approved' && !item.invalidated)
                      .length
                  }}/{{ release.approvals.length }}
                  已通过
                  <em v-if="invalidatedApprovals.length">
                    （{{ invalidatedApprovals.length }} 项旧意见已失效）
                  </em>
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
              :class="{ invalidated: confirmation.invalidated }"
            >
              <div>
                <strong>{{ dependencyName(confirmation.dependencyId) }}</strong>
                <span>{{ confirmation.reviewer || '未指定确认人' }}</span>
              </div>
              <StatusTag v-if="confirmation.invalidated" value="invalidated" />
              <StatusTag v-else :value="confirmation.status" />
              <p v-if="confirmation.invalidated" class="invalidated-reason">
                {{ confirmation.invalidatedReason }} · 旧确认已退回，请基于最新血缘重新确认
              </p>
              <p v-else>{{ confirmation.note || '尚未填写迁移确认说明。' }}</p>
              <t-button
                variant="outline"
                size="small"
                :disabled="!confirmation.invalidated && confirmation.status === 'confirmed'"
                @click="openMigration(confirmation.id)"
              >
                {{ confirmation.invalidated ? '重新确认迁移' : '确认迁移' }}
              </t-button>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批</h2>
          </div>
          <div class="approval-list">
            <label
              v-for="approval in release.approvals"
              :key="approval.id"
              class="approval-row"
              :class="{ invalidated: approval.invalidated }"
            >
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="!approval.invalidated && approval.status === 'approved'"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>{{ roleLabel(approval.role) }}</strong>
                <span>
                  {{ approval.actor }} ·
                  <template v-if="approval.invalidated">
                    旧意见已失效：{{ approval.invalidatedReason }}
                  </template>
                  <template v-else>{{ approval.comment || '待填写意见' }}</template>
                </span>
              </div>
              <StatusTag v-if="approval.invalidated" value="invalidated" />
              <StatusTag v-else :value="approval.status" />
              <t-button variant="text" size="small" @click.prevent="openApproval(approval)">
                {{ approval.invalidated ? '重新审批' : '审批' }}
              </t-button>
            </label>
          </div>
          <div class="batch-bar">
            <t-input v-model="approvalComment" placeholder="批量审批意见" />
            <t-button theme="primary" @click="batchApprove">批量通过</t-button>
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
        <t-button theme="primary" @click="createRelease">创建并比较</t-button>
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
        <t-button theme="primary" @click="confirmMigration">确认迁移</t-button>
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
        <t-button theme="danger" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitApproval('approved')">
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

.freeze-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 14px 0;
  padding: 12px 16px;
  border-left: 3px solid #0f8a62;
}

.freeze-banner.drifted {
  border-left-color: #c46a00;
  background: #fff8ed;
}

.freeze-banner svg {
  color: #0f8a62;
}

.freeze-banner.drifted svg {
  color: #c46a00;
}

.freeze-text {
  display: grid;
  gap: 3px;
  margin-right: auto;
}

.freeze-text strong {
  font-size: 12px;
}

.freeze-text span,
.freeze-recovery {
  color: #727d8f;
  font-size: 11px;
}

.freeze-recovery {
  display: flex;
  align-items: center;
  gap: 6px;
}

.drift-panel {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 16px;
  padding: 14px 16px;
  border: 1px solid #f2d8a7;
  background: #fff8ed;
}

.drift-panel svg {
  margin-top: 2px;
  color: #c46a00;
}

.drift-panel strong {
  font-size: 13px;
  color: #8a4b00;
}

.drift-panel p {
  margin: 5px 0 0;
  color: #7a5a2e;
  font-size: 12px;
  line-height: 1.6;
}

.migration-card.invalidated,
.approval-row.invalidated {
  background: #fff8ed;
}

.invalidated-reason {
  color: #a15c00 !important;
}

.gate-row em {
  color: #c46a00;
  font-style: normal;
}

.release-overview {
  display: grid;
  grid-template-columns: 180px minmax(260px, 1fr) 130px 140px auto;
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
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
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
