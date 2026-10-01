import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v1'
const WAL_KEY = 'eventrail-governance-wal-v1'

/** 并发提交同一候选时，后到的一方会收到版本冲突。 */
export class VersionConflictError extends Error {
  constructor(
    public readonly entity: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(`版本冲突：${entity} 已被其他窗口更新（期望 r${expectedRevision}，实际 r${actualRevision}）`)
    this.name = 'VersionConflictError'
  }
}

export interface RecoveryNotice {
  source: 'wal' | 'candidate'
  requestId?: string
  releaseId?: string
  recoveredAt: string
}

export interface PendingWrite {
  state: GovernanceState
  requestId?: string
  releaseId?: string
  savedAt: string
}

let recoveryNotice: RecoveryNotice | null = null

/** 读取上一次启动时从 WAL 恢复的说明（一次性消费）。 */
export const takeRecoveryNotice = (): RecoveryNotice | null => {
  const notice = recoveryNotice
  recoveryNotice = null
  return notice
}

const readJson = <T>(key: string): T | null => {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  return JSON.parse(raw) as T
}

/** 测试钩子：置位后下一次 saveState 抛错，用于验证“写入失败后恢复”。 */
export let failNextWrite = false
export const setFailNextWrite = (value: boolean): void => {
  failNextWrite = value
}

/**
 * WAL 语义：先把完整候选状态写入预提交日志，再提交主状态。
 * 提交阶段失败时，下一次加载会从最后一个完整候选恢复，
 * 调用方带相同 requestId 重试可直接取回已恢复候选，不重复生成确认。
 */
export const saveState = (state: GovernanceState, request?: { requestId?: string; releaseId?: string }): void => {
  const pending: PendingWrite = {
    state: structuredClone(state),
    requestId: request?.requestId,
    releaseId: request?.releaseId,
    savedAt: new Date().toISOString(),
  }
  localStorage.setItem(WAL_KEY, JSON.stringify(pending))
  if (failNextWrite) {
    failNextWrite = false
    throw new Error('模拟写入失败：主状态提交中断，完整候选保留在预提交日志中')
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pending.state))
  localStorage.removeItem(WAL_KEY)
}

const seedAndStore = (): GovernanceState => {
  const seed = createSeedState()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
  localStorage.removeItem(WAL_KEY)
  return seed
}

export const loadState = (): GovernanceState => {
  let wal: PendingWrite | null = null
  try {
    wal = readJson<PendingWrite>(WAL_KEY)
  } catch {
    wal = null
  }

  if (wal?.state) {
    // 上次写入在提交阶段失败：以 WAL 中最后一个完整候选为准恢复。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wal.state))
    localStorage.removeItem(WAL_KEY)
    recoveryNotice = {
      source: 'wal',
      requestId: wal.requestId,
      releaseId: wal.releaseId,
      recoveredAt: new Date().toISOString(),
    }
    return wal.state
  }

  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return seedAndStore()
  try {
    return JSON.parse(raw) as GovernanceState
  } catch {
    return seedAndStore()
  }
}

export const resetState = (): GovernanceState => {
  const seed = seedAndStore()
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
