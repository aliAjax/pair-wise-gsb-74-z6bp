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
import { createId, loadState, resetState, saveState } from '@/services/repository'
import {
  detectReleaseDrift,
  emptyDrift,
  freezeReleaseSnapshot,
} from '@/services/releaseSnapshot'
import {
  affectedDependencies,
  contractDifferences,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'

export interface SubmissionOptions {
  expectedRevision: number
  submissionId: string
}

export type MutationResult =
  | { ok: true; duplicated?: boolean }
  | { ok: false; reason: 'conflict' | 'not_found' | 'not_actionable' | 'drift' | 'gate' }

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
  }

  const auditInto = (
    state: GovernanceState,
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    state.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    auditInto(data.value, entityType, entityId, action, detail)
  }

  // 事件或血缘变化后，使评审中候选里受影响的未发布确认失效，未受影响的保留
  const reconcileReviewingReleases = (): void => {
    const now = new Date().toISOString()
    data.value.releases
      .filter((release) => release.status === 'reviewing')
      .forEach((release) => {
        const drift = detectReleaseDrift(data.value, release)
        if (emptyDrift(drift)) return
        let changed = false
        release.migrationConfirmations.forEach((confirmation) => {
          const affected = drift.dependencyDrifts.some(
            (item) => item.dependencyId === confirmation.dependencyId,
          )
          if (!affected) return
          if (confirmation.status !== 'confirmed' && confirmation.status !== 'rejected') return
          confirmation.status = 'invalidated'
          confirmation.invalidatedAt = now
          confirmation.invalidatedReason = '送审后事件契约或血缘发生变化，需重新确认'
          changed = true
          const dependency = data.value.dependencies.find(
            (item) => item.id === confirmation.dependencyId,
          )
          if (dependency && dependency.status === 'migrated') {
            dependency.status = 'migration_required'
          }
          audit(
            'dependency',
            confirmation.dependencyId,
            '确认失效',
            '事件契约或血缘在会签期间变化，迁移确认退回重审',
          )
        })
        if (drift.eventDrifts.length > 0) {
          const keys = drift.eventDrifts.map((item) => item.eventKey).join('、')
          let approvalInvalidated = false
          release.approvals.forEach((approval) => {
            if (approval.status !== 'approved' && approval.status !== 'rejected') return
            approval.status = 'invalidated'
            approval.invalidatedAt = now
            approval.invalidatedReason = `事件 ${keys} 在会签期间发生变化`
            approvalInvalidated = true
            changed = true
          })
          if (approvalInvalidated) {
            audit('release', release.id, '审批失效', `事件 ${keys} 变化，已提交的审批退回重审`)
          }
        }
        if (changed) release.revision += 1
      })
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

  const createRelease = (
    version: string,
    title: string,
    eventIds: string[],
    idempotencyKey?: string,
  ): ReleaseCandidate => {
    if (idempotencyKey) {
      const existing = data.value.releases.find((item) => item.idempotencyKey === idempotencyKey)
      if (existing) return existing
    }
    const differences = contractDifferences(data.value, eventIds)
    const affected = affectedDependencies(data.value, differences)
    const releaseId = createId('rel')
    const release: ReleaseCandidate = {
      id: releaseId,
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      migrationConfirmations: affected.map((dependencyId) => ({
        id: `mig-${releaseId}-${dependencyId}`,
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      snapshot: freezeReleaseSnapshot(data.value.events, data.value.dependencies, eventIds, affected),
      revision: 1,
      idempotencyKey,
      processedSubmissionIds: [],
      createdAt: new Date().toISOString(),
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 冻结 ${eventIds.length} 个事件契约，血缘摘要 ${release.snapshot.overallDigest}，影响 ${affected.length} 个下游依赖`,
    )
    persist()
    return release
  }

  // 基于持久化状态的读-改-写：期望版本不一致时拒绝并用最新状态刷新内存
  const mutateRelease = (
    releaseId: string,
    options: SubmissionOptions,
    apply: (release: ReleaseCandidate, state: GovernanceState) => MutationResult,
  ): MutationResult => {
    const persisted = loadState()
    const release = persisted.releases.find((item) => item.id === releaseId)
    if (!release) return { ok: false, reason: 'not_found' }
    if (release.processedSubmissionIds.includes(options.submissionId)) {
      data.value = persisted
      lastSavedAt.value = new Date().toISOString()
      return { ok: true, duplicated: true }
    }
    if (release.revision !== options.expectedRevision) {
      data.value = persisted
      return { ok: false, reason: 'conflict' }
    }
    const result = apply(release, persisted)
    if (!result.ok) {
      data.value = persisted
      return result
    }
    release.revision += 1
    release.processedSubmissionIds.push(options.submissionId)
    saveState(persisted)
    data.value = persisted
    lastSavedAt.value = new Date().toISOString()
    return result
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
    options: SubmissionOptions,
  ): MutationResult =>
    mutateRelease(releaseId, options, (release, state) => {
      const confirmation = release.migrationConfirmations.find((item) => item.id === confirmationId)
      if (!confirmation) return { ok: false, reason: 'not_found' }
      if (confirmation.status === 'confirmed') return { ok: false, reason: 'not_actionable' }
      const now = new Date().toISOString()
      confirmation.status = 'confirmed'
      confirmation.reviewer = reviewer
      confirmation.note = note
      confirmation.confirmedAt = now
      confirmation.invalidatedAt = undefined
      confirmation.invalidatedReason = undefined
      const dependency = state.dependencies.find((item) => item.id === confirmation.dependencyId)
      if (dependency) dependency.status = 'migrated'
      auditInto(state, 'dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
      return { ok: true }
    })

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
    options: SubmissionOptions,
  ): MutationResult =>
    mutateRelease(releaseId, options, (release, state) => {
      const approval = release.approvals.find((item) => item.role === role)
      if (!approval) return { ok: false, reason: 'not_found' }
      approval.status = status
      approval.actor = actor
      approval.comment = comment
      approval.createdAt = new Date().toISOString()
      approval.invalidatedAt = undefined
      approval.invalidatedReason = undefined
      auditInto(state, 'release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
      return { ok: true }
    })

  // 契约变化后重新送审：以当前契约重新冻结，未受影响的确认保留，受影响的重置待审
  const refreshReleaseSnapshot = (releaseId: string): MutationResult => {
    const persisted = loadState()
    const release = persisted.releases.find((item) => item.id === releaseId)
    if (!release) return { ok: false, reason: 'not_found' }
    if (release.status !== 'reviewing') return { ok: false, reason: 'not_actionable' }
    const previousSnapshot = release.snapshot
    const differences = contractDifferences(persisted, release.eventIds)
    const affected = affectedDependencies(persisted, differences)
    const snapshot = freezeReleaseSnapshot(
      persisted.events,
      persisted.dependencies,
      release.eventIds,
      affected,
    )
    release.migrationConfirmations = affected.map((dependencyId) => {
      const existing = release.migrationConfirmations.find(
        (item) => item.dependencyId === dependencyId,
      )
      const previousDigest = previousSnapshot.dependencies.find(
        (item) => item.dependencyId === dependencyId,
      )?.digest
      const nextDigest = snapshot.dependencies.find(
        (item) => item.dependencyId === dependencyId,
      )?.digest
      if (existing && previousDigest === nextDigest) return existing
      if (existing) {
        return {
          ...existing,
          status: 'pending',
          confirmedAt: undefined,
          invalidatedAt: undefined,
          invalidatedReason: undefined,
        }
      }
      return {
        id: `mig-${release.id}-${dependencyId}`,
        dependencyId,
        version: release.version,
        status: 'pending' as const,
        reviewer:
          persisted.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      }
    })
    release.affectedDependencyIds = affected
    release.differences = differences
    release.snapshot = snapshot
    release.approvals = release.approvals.map((approval) => ({
      ...approval,
      status: 'pending',
      comment: '',
      createdAt: undefined,
      invalidatedAt: undefined,
      invalidatedReason: undefined,
    }))
    release.revision += 1
    auditInto(
      persisted,
      'release',
      release.id,
      '重新送审冻结',
      `以当前契约重新冻结，血缘摘要 ${snapshot.overallDigest}，未受影响的确认已保留`,
    )
    saveState(persisted)
    data.value = persisted
    lastSavedAt.value = new Date().toISOString()
    return { ok: true }
  }

  const publishRelease = (releaseId: string): MutationResult => {
    const persisted = loadState()
    const release = persisted.releases.find((item) => item.id === releaseId)
    if (!release) return { ok: false, reason: 'not_found' }
    if (release.status !== 'reviewing') return { ok: false, reason: 'not_actionable' }
    if (!emptyDrift(detectReleaseDrift(persisted, release))) {
      data.value = persisted
      return { ok: false, reason: 'drift' }
    }
    const readiness = releaseReadiness(release, validateGovernance(persisted))
    const migrationsReady = release.migrationConfirmations.every((item) => item.status === 'confirmed')
    const approvalsReady = release.approvals.every((item) => item.status === 'approved')
    if (!migrationsReady || !approvalsReady || readiness < 90) {
      data.value = persisted
      return { ok: false, reason: 'gate' }
    }
    const now = new Date().toISOString()
    release.status = 'published'
    release.publishedAt = now
    release.eventIds.forEach((eventId) => {
      const event = persisted.events.find((item) => item.id === eventId)
      const frozen = release.snapshot.events.find((item) => item.eventId === eventId)
      if (event && frozen) {
        event.status = 'published'
        persisted.baselines.unshift({
          id: createId('base'),
          eventId,
          version: frozen.version,
          properties: structuredClone(frozen.properties),
          createdAt: now,
          status: 'published',
        })
      }
    })
    release.revision += 1
    auditInto(persisted, 'release', release.id, '发布契约', `${release.version} 已按送审冻结内容发布`)
    saveState(persisted)
    data.value = persisted
    lastSavedAt.value = now
    return { ok: true }
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

  // 回滚恢复以候选送审时的冻结内容为准，不取当前可能被再次修改的契约
  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return
    const now = new Date().toISOString()
    const restoredEventIds: string[] = []
    release.snapshot.events.forEach((frozen) => {
      const event = data.value.events.find((item) => item.id === frozen.eventId)
      if (!event) return
      event.key = frozen.key
      event.displayName = frozen.displayName
      event.version = frozen.version
      event.trigger = frozen.trigger
      event.owner = frozen.owner
      event.properties = structuredClone(frozen.properties)
      event.platformRules = structuredClone(frozen.platformRules)
      event.status = 'reviewing'
      event.updatedAt = now
      restoredEventIds.push(frozen.eventId)
    })
    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: release.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: now,
      status: 'executed',
      evidence,
      restoredEventIds,
    }
    data.value.rollbacks.unshift(record)
    release.status = 'rolled_back'
    release.revision += 1
    audit(
      'rollback',
      record.id,
      '执行回滚',
      `${release.version}：${reason}，已按冻结内容恢复 ${restoredEventIds.length} 个事件`,
    )
    persist()
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
  }

  // 导出只认送审时冻结的事件、属性和依赖关系
  const exportContract = (releaseId: string, eventIds?: string[]): string => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return ''
    const frozenEvents = release.snapshot.events.filter(
      (frozen) => !eventIds || eventIds.includes(frozen.eventId),
    )
    return JSON.stringify(
      {
        version: release.version,
        releaseId: release.id,
        frozenAt: release.snapshot.frozenAt,
        lineageDigest: release.snapshot.overallDigest,
        generatedAt: new Date().toISOString(),
        events: frozenEvents.map((frozen) => ({
          key: frozen.key,
          displayName: frozen.displayName,
          version: frozen.version,
          trigger: frozen.trigger,
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
        dependencies: release.snapshot.dependencies,
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    confirmMigration,
    updateApproval,
    refreshReleaseSnapshot,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    resetDemo,
    exportContract,
  }
})
