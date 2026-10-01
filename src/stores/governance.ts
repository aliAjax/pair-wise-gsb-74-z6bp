import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import {
  createId,
  loadState,
  resetState,
  saveState,
  takeRecoveryNotice,
  VersionConflictError,
} from '@/services/repository'
import {
  buildFrozenRelease,
  frozenDependency,
  reconcileRelease,
  releaseDrift,
  upgradeLegacyRelease,
} from '@/services/freeze'
import {
  validateGovernance,
} from '@/services/selectors'

export interface WriteRecoveryInfo {
  requestId?: string
  releaseId?: string
  recoveredAt: string
}

const REMOTE_UPDATE_EVENT = 'eventrail:remote-update'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  const writeError = ref<string | null>(null)
  const lastRecovery = ref<WriteRecoveryInfo | null>(takeRecoveryNotice())

  const issues = computed(() => validateGovernance(data.value))

  // 旧版本候选没有冻结快照，加载后按当前血缘补齐一次，后续统一按冻结语义处理。
  data.value.releases.forEach((release) =>
    upgradeLegacyRelease(data.value, release, new Date().toISOString(), createId),
  )

  /**
   * 带 WAL 的持久化：先落完整候选到预提交日志，再提交主状态。
   * 提交失败时从最后一个完整候选恢复内存状态，并把错误上抛给调用方，
   * 调用方携带相同 requestId 重试时可直接复用已恢复候选，不重复生成确认。
   */
  const persist = (request?: { requestId?: string; releaseId?: string }): void => {
    try {
      saveState(data.value, request)
      lastSavedAt.value = new Date().toISOString()
      writeError.value = null
    } catch (error) {
      const recovered = loadState()
      data.value = recovered
      const notice = takeRecoveryNotice()
      if (notice) {
        lastRecovery.value = {
          requestId: notice.requestId,
          releaseId: notice.releaseId,
          recoveredAt: notice.recoveredAt,
        }
      }
      writeError.value = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  // 其他窗口完成写入后，本窗口以最新持久化状态为准，避免乐观锁基于旧版本号放行。
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== 'eventrail-governance-v1' || !event.newValue) return
      try {
        data.value = JSON.parse(event.newValue) as GovernanceState
        data.value.releases.forEach((release) =>
          upgradeLegacyRelease(data.value, release, new Date().toISOString(), createId),
        )
        lastSavedAt.value = new Date().toISOString()
        window.dispatchEvent(new Event(REMOTE_UPDATE_EVENT))
      } catch {
        // 损坏的跨窗口负载直接忽略，保留本窗口状态。
      }
    })
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  /** 事件或血缘变化后，让所有评审中候选按冻结摘要重新校准。 */
  const reconcileReviewingReleases = (): Array<{
    release: ReleaseCandidate
    confirmations: number
    approvals: number
  }> => {
    const now = new Date().toISOString()
    const outcomes: Array<{ release: ReleaseCandidate; confirmations: number; approvals: number }> = []
    data.value.releases
      .filter((release) => release.status === 'reviewing')
      .forEach((release) => {
        const outcome = reconcileRelease(data.value, release, now)
        if (outcome) {
          outcomes.push({
            release,
            confirmations: outcome.invalidatedConfirmationIds.length,
            approvals: outcome.invalidatedApprovalRoles.length,
          })
          audit(
            'release',
            release.id,
            '血缘变更退回重审',
            `${release.version}：失效迁移确认 ${outcome.invalidatedConfirmationIds.length} 项、审批 ${outcome.invalidatedApprovalRoles.length} 项，未受影响确认保留`,
          )
        }
      })
    return outcomes
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const saved = { ...event, updatedAt: new Date().toISOString() }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    audit('event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    reconcileReviewingReleases()
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, index >= 0 ? '更新属性' : '新增属性', `${event.key}.${property.name}`)
    reconcileReviewingReleases()
    persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    reconcileReviewingReleases()
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    audit('platform_rule', rule.id, index >= 0 ? '更新平台规则' : '新增平台规则', `${event.key}/${rule.platform}`)
    reconcileReviewingReleases()
    persist()
  }

  /**
   * 冻结送审。requestId 为幂等键：写入失败后重试时若完整候选已从
   * WAL 恢复，则直接返回原候选，不会重复生成迁移确认。
   */
  const createRelease = (
    version: string,
    title: string,
    eventIds: string[],
    requestId = `request-${createId('rel')}`,
  ): { release: ReleaseCandidate; recovered: boolean } => {
    const existing = data.value.releases.find((release) => release.requestId === requestId)
    if (existing) {
      return { release: existing, recovered: true }
    }

    const frozenAt = new Date().toISOString()
    const frozen = buildFrozenRelease(data.value, version, eventIds, createId, frozenAt)
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: frozen.affectedDependencyIds,
      differences: frozen.differences,
      migrationConfirmations: frozen.confirmations,
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      frozenSnapshot: frozen.frozenSnapshot,
      revision: 1,
      requestId,
      createdAt: frozenAt,
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 已冻结 ${eventIds.length} 个事件、${frozen.affectedDependencyIds.length} 个下游血缘（摘要 ${frozen.lineageDigest.slice(0, 8)}）`,
    )
    persist({ requestId, releaseId: release.id })
    return { release, recovered: false }
  }

  const assertRevision = (release: ReleaseCandidate, expectedRevision: number): void => {
    if (release.revision !== expectedRevision) {
      throw new VersionConflictError(release.id, expectedRevision, release.revision)
    }
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
    expectedRevision: number,
  ): { revision: number } => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!release || !confirmation) throw new Error('迁移确认不存在，可能已被血缘变更失效')
    assertRevision(release, expectedRevision)
    if (!confirmation.invalidated && confirmation.status === 'confirmed') {
      return { revision: release.revision }
    }
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    confirmation.invalidated = false
    confirmation.invalidatedReason = undefined
    confirmation.invalidatedAt = undefined
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    release.revision += 1
    audit('dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    persist({ releaseId })
    return { revision: release.revision }
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
    expectedRevision: number,
  ): { revision: number } => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const approval = release?.approvals.find((item) => item.role === role)
    if (!release || !approval) throw new Error('审批项不存在')
    assertRevision(release, expectedRevision)
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    approval.invalidated = false
    approval.invalidatedReason = undefined
    approval.invalidatedAt = undefined
    release.revision += 1
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist({ releaseId })
    return { revision: release.revision }
  }

  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return false
    // 发布门禁只认送审冻结：冻结之后血缘漂移、确认失效或旧审批都不能放行。
    const drift = releaseDrift(data.value, release)
    const migrationsReady = release.migrationConfirmations.every(
      (item) => item.status === 'confirmed' && !item.invalidated,
    )
    const approvalsReady = release.approvals.every(
      (item) => item.status === 'approved' && !item.invalidated,
    )
    if (drift.drifted || !migrationsReady || !approvalsReady) return false

    release.status = 'published'
    release.publishedAt = new Date().toISOString()
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      const frozen = release.frozenSnapshot?.events.find((item) => item.event.id === eventId)
      if (event) {
        event.status = 'published'
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: frozen?.event.version ?? event.version,
          properties: structuredClone(frozen?.properties ?? event.properties),
          createdAt: new Date().toISOString(),
          status: 'published',
        })
      }
    })
    audit('release', release.id, '发布契约', `${release.version} 按冻结快照发布`)
    persist({ releaseId })
    return true
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') event.status = 'deprecated'
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  /**
   * 回滚恢复以原候选的冻结内容为准：把候选冻结的事件、属性和平台规则
   * 恢复回当前契约，而不是回滚到事后被改动过的工作区状态。
   */
  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): RollbackRecord => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) throw new Error('发布候选不存在')
    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: release.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: new Date().toISOString(),
      status: 'executed',
      evidence,
    }
    data.value.rollbacks.unshift(record)
    release.status = 'rolled_back'

    const restoredEventKeys: string[] = []
    release.frozenSnapshot?.events.forEach((frozen) => {
      const event = data.value.events.find((item) => item.id === frozen.event.id)
      if (!event) return
      event.key = frozen.event.key
      event.displayName = frozen.event.displayName
      event.category = frozen.event.category
      event.version = frozen.event.version
      event.owner = frozen.event.owner
      event.trigger = frozen.event.trigger
      event.description = frozen.event.description
      event.properties = structuredClone(frozen.properties)
      event.platformRules = structuredClone(frozen.platformRules)
      event.downstreamDependencyIds = [...frozen.downstreamDependencyIds]
      restoredEventKeys.push(frozen.event.key)
    })
    audit(
      'rollback',
      record.id,
      '执行回滚',
      `${release.version}：按冻结快照恢复 ${restoredEventKeys.length} 个事件（${restoredEventKeys.join('、') || '无'}）`,
    )
    persist({ releaseId })
    return record
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
  }

  const resetDemo = (): void => {
    data.value = resetState()
    lastSavedAt.value = new Date().toISOString()
    writeError.value = null
    lastRecovery.value = null
  }

  /** 工作区导出：按当前编辑中的契约导出（非送审口径）。 */
  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        generatedAt: new Date().toISOString(),
        frozen: false,
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  /** 送审口径导出：只认候选冻结时的事件、属性和依赖关系。 */
  const exportFrozenRelease = (releaseId: string): string => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) throw new Error('发布候选不存在')
    const snapshot = release.frozenSnapshot
    if (!snapshot) throw new Error('该候选缺少送审冻结快照')
    return JSON.stringify(
      {
        release: release.version,
        title: release.title,
        frozen: true,
        frozenAt: snapshot.frozenAt,
        lineageDigest: snapshot.lineageDigest,
        revision: release.revision,
        events: snapshot.events.map((frozen) => ({
          key: frozen.event.key,
          displayName: frozen.event.displayName,
          version: frozen.event.version,
          trigger: frozen.event.trigger,
          owner: frozen.event.owner,
          digest: frozen.digest,
          platforms: frozen.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: frozen.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
        dependencies: snapshot.dependencies.map((dependency) => ({
          name: dependency.name,
          type: dependency.type,
          owner: dependency.owner,
          environment: dependency.environment,
          propertyRefs: dependency.propertyRefs,
          digest: dependency.digest,
        })),
        migrationConfirmations: release.migrationConfirmations.map((confirmation) => ({
          dependency:
            frozenDependency(release, confirmation.dependencyId)?.name ?? confirmation.dependencyId,
          status: confirmation.status,
          invalidated: Boolean(confirmation.invalidated),
          reviewer: confirmation.reviewer,
          note: confirmation.note,
        })),
        approvals: release.approvals.map((approval) => ({
          role: approval.role,
          actor: approval.actor,
          status: approval.status,
          invalidated: Boolean(approval.invalidated),
          comment: approval.comment,
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    writeError,
    lastRecovery,
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
    exportFrozenRelease,
    reconcileReviewingReleases,
  }
})
