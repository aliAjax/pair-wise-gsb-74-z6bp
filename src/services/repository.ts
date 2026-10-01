import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'
import { freezeReleaseSnapshot } from '@/services/releaseSnapshot'

const STORAGE_KEY = 'eventrail-governance-v1'
const BACKUP_KEY = 'eventrail-governance-v1-backup'

const isCompleteState = (value: unknown): value is GovernanceState => {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<GovernanceState>
  return (
    Array.isArray(state.events) &&
    Array.isArray(state.dependencies) &&
    Array.isArray(state.releases) &&
    Array.isArray(state.audit)
  )
}

const migrateState = (state: GovernanceState): GovernanceState => {
  state.releases.forEach((release) => {
    release.revision ??= 1
    release.processedSubmissionIds ??= []
    if (!release.snapshot) {
      release.snapshot = freezeReleaseSnapshot(
        state.events,
        state.dependencies,
        release.eventIds,
        release.affectedDependencyIds,
      )
    }
  })
  state.rollbacks.forEach((record) => {
    record.restoredEventIds ??= []
  })
  return state
}

const parseState = (raw: string | null): GovernanceState | null => {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isCompleteState(parsed) ? migrateState(parsed) : null
  } catch {
    return null
  }
}

export const loadState = (): GovernanceState => {
  const primary = parseState(localStorage.getItem(STORAGE_KEY))
  if (primary) return primary
  const backupRaw = localStorage.getItem(BACKUP_KEY)
  const backup = parseState(backupRaw)
  if (backup) {
    localStorage.setItem(STORAGE_KEY, backupRaw!)
    return backup
  }
  const seed = createSeedState()
  const snapshot = JSON.stringify(seed)
  localStorage.setItem(STORAGE_KEY, snapshot)
  localStorage.setItem(BACKUP_KEY, snapshot)
  return seed
}

export const saveState = (state: GovernanceState): void => {
  const snapshot = JSON.stringify(structuredClone(state))
  const previous = localStorage.getItem(STORAGE_KEY)
  try {
    if (previous && parseState(previous)) {
      localStorage.setItem(BACKUP_KEY, previous)
    }
    localStorage.setItem(STORAGE_KEY, snapshot)
  } catch (error) {
    if (previous) {
      try {
        localStorage.setItem(STORAGE_KEY, previous)
      } catch {
        // 主键恢复也失败时保留备份键，下次加载从备份恢复
      }
    }
    throw error
  }
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
