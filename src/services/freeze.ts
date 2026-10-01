import type {
  ContractDifference,
  DownstreamDependency,
  EventDefinition,
  FrozenDependency,
  FrozenEventContract,
  GovernanceState,
  MigrationConfirmation,
  ReleaseApproval,
  ReleaseCandidate,
} from '@/models/domain'
import { affectedDependencies, contractDifferences } from '@/services/selectors'

/**
 * 冻结与血缘摘要服务。
 *
 * 送审时把事件、属性、平台规则、下游依赖冻结进发布候选，并为每段血缘
 * 生成稳定摘要；候选送审之后的审批、迁移确认和导出都只读取冻结内容。
 * 事件或血缘变化后，用当前摘要与冻结摘要对比，精准失效受影响的确认，
 * 未受影响的确认继续保留。
 */

const STABLE_EMPTY = '0'

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}

/** FNV-1a 32 位摘要，仅用于本地检测冻结内容是否漂移，不承担密码学职责。 */
export const digestOf = (value: unknown): string => {
  const text = stableStringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const eventContractPayload = (event: EventDefinition) => ({
  id: event.id,
  key: event.key,
  displayName: event.displayName,
  category: event.category,
  version: event.version,
  owner: event.owner,
  trigger: event.trigger,
  description: event.description,
  properties: event.properties
    .filter((property) => !property.deletedAt)
    .map((property) => ({
      id: property.id,
      name: property.name,
      displayName: property.displayName,
      type: property.type,
      required: property.required,
      description: property.description,
      enumValues: [...property.enumValues],
      owner: property.owner,
      synonyms: [...property.synonyms],
      platforms: [...property.platforms],
      lineageSourceId: property.lineageSourceId ?? null,
    })),
  platformRules: event.platformRules.map((rule) => ({
    id: rule.id,
    platform: rule.platform,
    enabled: rule.enabled,
    trigger: rule.trigger,
    owner: rule.owner,
    requiredPropertyIds: [...rule.requiredPropertyIds],
    note: rule.note,
  })),
  downstreamDependencyIds: [...event.downstreamDependencyIds],
})

const eventContractDigest = (event: EventDefinition): string => digestOf(eventContractPayload(event))

/** 单个下游依赖的血缘摘要：依赖引用了哪些事件的哪些属性。 */
const dependencyLineagePayload = (
  dependency: DownstreamDependency,
  events: EventDefinition[],
) => ({
  id: dependency.id,
  eventIds: [...dependency.eventIds].sort(),
  propertyRefs: dependency.propertyRefs
    .map((reference) => {
      const event = events.find((item) => item.id === reference.eventId)
      const property = event?.properties.find((item) => item.id === reference.propertyId)
      return {
        eventId: reference.eventId,
        propertyId: reference.propertyId,
        propertyName: property?.name ?? null,
        propertyType: property && !property.deletedAt ? property.type : 'removed',
        propertyRequired: property?.required ?? null,
        propertyEnumValues: property ? [...property.enumValues].sort() : [],
        propertySynonyms: property ? [...property.synonyms].sort() : [],
        propertyDeleted: property ? Boolean(property.deletedAt) : true,
        lineageSourceId: property?.lineageSourceId ?? null,
      }
    })
    .sort((left, right) =>
      `${left.eventId}:${left.propertyId}` < `${right.eventId}:${right.propertyId}` ? -1 : 1,
    ),
})

export const dependencyLineageDigest = (
  dependency: DownstreamDependency,
  events: EventDefinition[],
): string => digestOf(dependencyLineagePayload(dependency, events))

const buildFrozenEvent = (event: EventDefinition): FrozenEventContract => ({
  event: {
    id: event.id,
    key: event.key,
    displayName: event.displayName,
    category: event.category,
    version: event.version,
    owner: event.owner,
    trigger: event.trigger,
    description: event.description,
  },
  properties: structuredClone(event.properties),
  platformRules: structuredClone(event.platformRules),
  downstreamDependencyIds: [...event.downstreamDependencyIds],
  digest: eventContractDigest(event),
})

const buildFrozenDependency = (
  dependency: DownstreamDependency,
  events: EventDefinition[],
): FrozenDependency => ({
  id: dependency.id,
  name: dependency.name,
  type: dependency.type,
  owner: dependency.owner,
  environment: dependency.environment,
  eventIds: [...dependency.eventIds],
  propertyRefs: structuredClone(dependency.propertyRefs),
  digest: dependencyLineageDigest(dependency, events),
})

/** 候选当前对应的整体血缘摘要：冻结事件 + 冻结下游依赖的摘要集合。 */
export const releaseLineageDigest = (
  state: GovernanceState,
  eventIds: string[],
  dependencyIds: string[],
): string => {
  const events = state.events.filter((event) => eventIds.includes(event.id))
  const dependencies = state.dependencies.filter((dependency) =>
    dependencyIds.includes(dependency.id),
  )
  return digestOf({
    events: events
      .map(eventContractDigest)
      .sort(),
    dependencies: dependencies
      .map((dependency) => dependencyLineageDigest(dependency, state.events))
      .sort(),
  })
}

export interface FrozenSnapshotBuild {
  frozenSnapshot: NonNullable<ReleaseCandidate['frozenSnapshot']>
  frozenEvents: FrozenEventContract[]
  frozenDependencies: FrozenDependency[]
}

/** 按指定事件/依赖范围冻结当前血缘，不参与差异计算。 */
export const buildFrozenSnapshot = (
  state: GovernanceState,
  eventIds: string[],
  dependencyIds: string[],
  frozenAt: string,
): FrozenSnapshotBuild => {
  const frozenEvents = state.events
    .filter((event) => eventIds.includes(event.id))
    .map(buildFrozenEvent)
  const frozenDependencies = state.dependencies
    .filter((dependency) => dependencyIds.includes(dependency.id))
    .map((dependency) => buildFrozenDependency(dependency, state.events))
  const lineageDigest = digestOf({
    events: frozenEvents.map((event) => event.digest).sort(),
    dependencies: frozenDependencies.map((dependency) => dependency.digest).sort(),
  })
  return {
    frozenSnapshot: { events: frozenEvents, dependencies: frozenDependencies, lineageDigest, frozenAt },
    frozenEvents,
    frozenDependencies,
  }
}

export interface FrozenReleaseBuild {
  frozenSnapshot: NonNullable<ReleaseCandidate['frozenSnapshot']>
  differences: ContractDifference[]
  affectedDependencyIds: string[]
  confirmations: MigrationConfirmation[]
  lineageDigest: string
}

/** 送审冻结：固化事件、属性、依赖关系，并为每个受影响依赖挂血缘摘要。 */
export const buildFrozenRelease = (
  state: GovernanceState,
  version: string,
  eventIds: string[],
  createId: (prefix: string) => string,
  frozenAt: string,
): FrozenReleaseBuild => {
  const differences = contractDifferences(state, eventIds)
  // 差异命中的依赖，加上所有直接引用候选事件（含事件级关联）的下游，
  // 保证即使属性无差异，送审后血缘变化仍能精准失效对应确认。
  const diffAffected = new Set(affectedDependencies(state, differences))
  const referenced = state.dependencies
    .filter(
      (dependency) =>
        dependency.eventIds.some((eventId) => eventIds.includes(eventId)) ||
        dependency.propertyRefs.some((reference) => eventIds.includes(reference.eventId)),
    )
    .map((dependency) => dependency.id)
  const affectedDependencyIds = [...new Set([...diffAffected, ...referenced])]
  const { frozenSnapshot, frozenDependencies } = buildFrozenSnapshot(
    state,
    eventIds,
    affectedDependencyIds,
    frozenAt,
  )
  const confirmations: MigrationConfirmation[] = affectedDependencyIds.map((dependencyId) => {
    const dependency = state.dependencies.find((item) => item.id === dependencyId)
    const frozen = frozenDependencies.find((item) => item.id === dependencyId)
    return {
      id: createId('mig'),
      dependencyId,
      version,
      status: 'pending',
      reviewer: dependency?.owner ?? '',
      note: '',
      frozenDigest: frozen?.digest,
    }
  })
  return {
    frozenSnapshot,
    differences,
    affectedDependencyIds,
    confirmations,
    lineageDigest: frozenSnapshot.lineageDigest,
  }
}

export interface ReleaseDrift {
  drifted: boolean
  changedEventIds: string[]
  changedDependencyIds: string[]
}

/** 对比候选冻结摘要与当前血缘，返回漂移范围（事件级 + 依赖级）。 */
export const releaseDrift = (state: GovernanceState, release: ReleaseCandidate): ReleaseDrift => {
  const snapshot = release.frozenSnapshot
  if (!snapshot) return { drifted: false, changedEventIds: [], changedDependencyIds: [] }
  const changedEventIds: string[] = []
  snapshot.events.forEach((frozen) => {
    const current = state.events.find((event) => event.id === frozen.event.id)
    if (!current || eventContractDigest(current) !== frozen.digest) {
      changedEventIds.push(frozen.event.id)
    }
  })
  const changedDependencyIds: string[] = []
  snapshot.dependencies.forEach((frozen) => {
    const current = state.dependencies.find((dependency) => dependency.id === frozen.id)
    if (!current || dependencyLineageDigest(current, state.events) !== frozen.digest) {
      changedDependencyIds.push(frozen.id)
    }
  })
  return {
    drifted: changedEventIds.length > 0 || changedDependencyIds.length > 0,
    changedEventIds,
    changedDependencyIds,
  }
}

/**
 * 血缘变化后校准所有评审中的候选：
 * - 受影响（血缘摘要变化）的未发布迁移确认立即失效、退回待确认；
 * - 未受影响的确认原样保留；
 * - 事件/属性变更后已有审批意见同步失效，必须基于新冻结内容重审。
 * 返回受影响的候选与失效条目，供审计记录使用。
 */
export interface ReconcileOutcome {
  release: ReleaseCandidate
  invalidatedConfirmationIds: string[]
  invalidatedApprovalRoles: ReleaseApproval['role'][]
}

export const reconcileRelease = (
  state: GovernanceState,
  release: ReleaseCandidate,
  now: string,
): ReconcileOutcome | null => {
  if (release.status !== 'reviewing' || !release.frozenSnapshot) return null
  const drift = releaseDrift(state, release)
  if (!drift.drifted) return null

  const changedDependencyIds = new Set(drift.changedDependencyIds)
  const invalidatedConfirmationIds: string[] = []
  release.migrationConfirmations.forEach((confirmation) => {
    if (!changedDependencyIds.has(confirmation.dependencyId)) return
    const dependency = state.dependencies.find((item) => item.id === confirmation.dependencyId)
    const currentDigest = dependency
      ? dependencyLineageDigest(dependency, state.events)
      : STABLE_EMPTY
    if (confirmation.status === 'pending' && confirmation.frozenDigest === currentDigest) return
    confirmation.invalidated = true
    confirmation.invalidatedReason = '送审冻结之后，该依赖关联的事件或属性血缘已变化'
    confirmation.invalidatedAt = now
    confirmation.frozenDigest = currentDigest
    confirmation.status = 'pending'
    confirmation.confirmedAt = undefined
    invalidatedConfirmationIds.push(confirmation.id)
    if (dependency) dependency.status = 'migration_required'
  })

  const invalidatedApprovalRoles: ReleaseApproval['role'][] = []
  release.approvals.forEach((approval) => {
    // 尚未提交的审批本就需要按最新冻结内容会签，保持待处理即可。
    if (approval.status === 'pending') return
    approval.invalidated = true
    approval.invalidatedReason = '会签期间事件或属性血缘已变更，旧意见不再放行'
    approval.invalidatedAt = now
    approval.status = 'pending'
    approval.comment = ''
    approval.createdAt = undefined
    invalidatedApprovalRoles.push(approval.role)
  })

  // 冻结快照是送审时刻的凭证，不随当前血缘覆写；漂移由 releaseDrift 持续检测。

  return { release, invalidatedConfirmationIds, invalidatedApprovalRoles }
}

/** 旧版本数据（无冻结快照）按当前血缘补齐冻结内容，补齐后视为送审时刻冻结。 */
export const upgradeLegacyRelease = (
  state: GovernanceState,
  release: ReleaseCandidate,
  now: string,
  createId: (prefix: string) => string,
): ReleaseCandidate => {
  if (release.frozenSnapshot) return release
  const differences = release.differences.length
    ? release.differences
    : contractDifferences(state, release.eventIds)
  const affectedDependencyIds = release.affectedDependencyIds.length
    ? release.affectedDependencyIds
    : affectedDependencies(state, differences)
  const frozenEvents = state.events
    .filter((event) => release.eventIds.includes(event.id))
    .map(buildFrozenEvent)
  const frozenDependencies = state.dependencies
    .filter((dependency) => affectedDependencyIds.includes(dependency.id))
    .map((dependency) => buildFrozenDependency(dependency, state.events))
  const lineageDigest = digestOf({
    events: frozenEvents.map((event) => event.digest).sort(),
    dependencies: frozenDependencies.map((dependency) => dependency.digest).sort(),
  })
  release.frozenSnapshot = {
    events: frozenEvents,
    dependencies: frozenDependencies,
    lineageDigest,
    frozenAt: release.createdAt || now,
  }
  if (!release.affectedDependencyIds.length) release.affectedDependencyIds = affectedDependencyIds
  if (!release.differences.length) release.differences = differences
  release.migrationConfirmations.forEach((confirmation) => {
    const frozen = frozenDependencies.find((item) => item.id === confirmation.dependencyId)
    confirmation.frozenDigest = frozen?.digest
  })
  if (typeof release.revision !== 'number') release.revision = 1
  if (!release.requestId) release.requestId = `legacy-${release.id}`
  // 旧候选补齐差异清单需要的占位 ID 不会再被创建；仅在缺确认时补建。
  release.affectedDependencyIds.forEach((dependencyId) => {
    if (!release.migrationConfirmations.some((item) => item.dependencyId === dependencyId)) {
      const dependency = state.dependencies.find((item) => item.id === dependencyId)
      release.migrationConfirmations.push({
        id: createId('mig'),
        dependencyId,
        version: release.version,
        status: 'pending',
        reviewer: dependency?.owner ?? '',
        note: '',
        frozenDigest: frozenDependencies.find((item) => item.id === dependencyId)?.digest,
      })
    }
  })
  return release
}

/** 读取候选冻结的事件；不存在冻结快照时回退到当前事件（仅兜底）。 */
export const frozenEvent = (
  release: ReleaseCandidate,
  eventId: string,
): FrozenEventContract | undefined =>
  release.frozenSnapshot?.events.find((event) => event.event.id === eventId)

export const frozenDependency = (
  release: ReleaseCandidate,
  dependencyId: string,
): FrozenDependency | undefined =>
  release.frozenSnapshot?.dependencies.find((dependency) => dependency.id === dependencyId)
