export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
}

export interface FrozenDependency {
  id: string
  name: string
  type: DownstreamDependency['type']
  owner: string
  environment: DownstreamDependency['environment']
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  digest: string
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected'
  reviewer: string
  note: string
  confirmedAt?: string
  /** 送审时该依赖的血缘摘要，事件/血缘变更后据此判定失效 */
  frozenDigest?: string
  /** 因冻结之后契约变更而失效，需下游重新确认 */
  invalidated?: boolean
  invalidatedReason?: string
  invalidatedAt?: string
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
  /** 会签期间契约变更后，已提交意见失效并退回重审 */
  invalidated?: boolean
  invalidatedReason?: string
  invalidatedAt?: string
}

export interface FrozenEventContract {
  event: Pick<
    EventDefinition,
    | 'id'
    | 'key'
    | 'displayName'
    | 'category'
    | 'version'
    | 'owner'
    | 'trigger'
    | 'description'
  >
  properties: EventProperty[]
  platformRules: PlatformRule[]
  downstreamDependencyIds: string[]
  /** 事件契约（含属性）摘要 */
  digest: string
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  /** 送审时冻结的事件、属性、平台规则与下游依赖，审批/迁移/导出只认该内容 */
  frozenSnapshot?: {
    events: FrozenEventContract[]
    dependencies: FrozenDependency[]
    /** 候选整体血缘摘要，契约变更后用于识别过期候选 */
    lineageDigest: string
    frozenAt: string
  }
  /** 并发提交的乐观锁版本，每次成功写入后递增 */
  revision: number
  /** 送审请求幂等键，写入失败重试时不重复生成迁移确认 */
  requestId?: string
  createdAt: string
  publishedAt?: string
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  version: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  audit: AuditEvent[]
  currentVersion: string
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
