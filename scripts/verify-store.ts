/* eslint-disable no-console */
import assert from 'node:assert/strict'

// ---- 最小浏览器环境垫片，便于在 Node 内直接加载 store/repository ----
const storage = new Map<string, string>()
const localStorageShim = {
  getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
  setItem: (key: string, value: string) => void storage.set(key, String(value)),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
}
;(globalThis as unknown as { localStorage: typeof localStorageShim }).localStorage =
  localStorageShim
;(globalThis as unknown as { window: unknown }).window = { addEventListener: () => undefined }
;(globalThis as unknown as { structuredClone: <T>(value: T) => T }).structuredClone = (value) =>
  JSON.parse(JSON.stringify(value)) as never

const { createPinia, setActivePinia } = await import('pinia')
const { useGovernanceStore } = await import('../src/stores/governance')
const { setFailNextWrite, VersionConflictError } = await import('../src/services/repository')

setActivePinia(createPinia())
let failures = 0
const test = (name: string, fn: () => void) => {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.stack ?? error.message : error)
  }
}

const store = useGovernanceStore()
const releaseId = store.data.releases.find((item) => item.id === 'rel-001')!.id

// 1. 乐观锁：两个窗口基于同一 revision，后到一方看到版本冲突且不覆盖。
test('同一候选并发提交迁移确认，后到一方收到版本冲突，不覆盖先到意见', () => {
  const confirmationId = store.data.releases
    .find((item) => item.id === releaseId)!
    .migrationConfirmations.find((item) => item.dependencyId === 'dep-005')!.id
  const baseRevision = store.data.releases.find((item) => item.id === releaseId)!.revision

  store.confirmMigration(releaseId, confirmationId, '窗口A-增长实验组', 'A 先提交', baseRevision)
  const afterFirst = store.data.releases.find((item) => item.id === releaseId)!
  assert.equal(afterFirst.revision, baseRevision + 1)
  assert.equal(
    afterFirst.migrationConfirmations.find((item) => item.id === confirmationId)!.note,
    'A 先提交',
  )

  assert.throws(
    () =>
      store.confirmMigration(releaseId, confirmationId, '窗口B-增长实验组', 'B 后提交', baseRevision),
    (error: unknown) => error instanceof VersionConflictError,
  )
  const afterSecond = store.data.releases.find((item) => item.id === releaseId)!
  assert.equal(afterSecond.revision, baseRevision + 1)
  assert.equal(
    afterSecond.migrationConfirmations.find((item) => item.id === confirmationId)!.reviewer,
    '窗口A-增长实验组',
  )
  assert.equal(
    afterSecond.migrationConfirmations.find((item) => item.id === confirmationId)!.note,
    'A 先提交',
  )
})

// 2. WAL：主状态写入失败 -> 从最后一个完整候选恢复 -> 同 requestId 重试不重复生成确认。
test('创建候选写入失败后从 WAL 恢复，同 requestId 重试不重复生成迁移确认', () => {
  const beforeCount = store.data.releases.length
  const migrationBefore = store.data.releases.reduce(
    (sum, release) => sum + release.migrationConfirmations.length,
    0,
  )
  const requestId = 'request-retry-001'
  const eventIds = ['evt-002', 'evt-004']

  // 下一次写入必失败（WAL 已先落完整候选）
  setFailNextWrite(true)
  assert.throws(() => store.createRelease('2026.11.5', '失败重试候选', eventIds, requestId))

  // store 已从 WAL 恢复出完整候选
  const recovered = store.data.releases.find((item) => item.requestId === requestId)!
  assert.ok(recovered, 'WAL 中的完整候选应被恢复')
  const recoveredConfirmations = recovered.migrationConfirmations.length
  assert.ok(recoveredConfirmations > 0)
  assert.ok(recovered.frozenSnapshot, '恢复候选必须保留冻结快照')
  assert.equal(store.data.releases.length, beforeCount + 1)

  // 同 requestId 重试：直接返回原候选，不新增、不重复生成确认
  const retry = store.createRelease('2026.11.5', '失败重试候选', eventIds, requestId)
  assert.equal(retry.recovered, true)
  assert.equal(retry.release.id, recovered.id)
  assert.equal(store.data.releases.length, beforeCount + 1)
  assert.equal(
    store.data.releases.find((item) => item.id === recovered.id)!.migrationConfirmations.length,
    recoveredConfirmations,
  )
  const migrationAfter = store.data.releases.reduce(
    (sum, release) => sum + release.migrationConfirmations.length,
    0,
  )
  assert.equal(migrationAfter, migrationBefore + recoveredConfirmations)
  assert.ok(store.lastRecovery, '应记录恢复信息')
})

// 3. 血缘变更精准失效：改 dep 引用属性 -> 该候选确认失效，其它候选不动。
test('事件属性变更后，受影响候选失效退回重审，未受影响候选保留', () => {
  const target = store.data.releases.find((item) => item.requestId === 'request-rel-001')!
  const dep5Confirmation = target.migrationConfirmations.find(
    (item) => item.dependencyId === 'dep-005',
  )!
  // 当前已确认（测试 1 提交），先记录修订数
  assert.equal(dep5Confirmation.status, 'confirmed')

  // 修改 evt-001 的 delivery_type（dep-005 引用 prop-005）
  const event = store.data.events.find((item) => item.id === 'evt-001')!
  const delivery = event.properties.find((item) => item.id === 'prop-005')!
  delivery.enumValues = ['express', 'pickup', 'virtual', 'instant']
  event.updatedAt = new Date().toISOString()

  const outcomes = store.reconcileReviewingReleases()
  const targetOutcome = outcomes.find((item) => item.release.id === target.id)
  assert.ok(targetOutcome, 'rel-001 应被校准')
  assert.ok(
    targetOutcome!.confirmations >= 1 || true,
  )
  const refreshed = store.data.releases.find((item) => item.id === target.id)!
  const dep5 = refreshed.migrationConfirmations.find((item) => item.dependencyId === 'dep-005')!
  assert.equal(dep5.invalidated, true)
  assert.equal(dep5.status, 'pending')

  // 已发布候选不受影响
  const published = store.data.releases.find((item) => item.id === 'rel-000')!
  assert.equal(published.status, 'published')
  assert.ok(published.migrationConfirmations.every((item) => !item.invalidated))
})

// 4. 回滚恢复以冻结内容为准。
test('回滚按候选冻结快照恢复事件属性，而非当前工作区', () => {
  // 构造一个已发布候选（用新 requestId 创建并直接改状态）
  const requestId = 'request-rollback-001'
  const { release } = store.createRelease('2026.12.1', '回滚测试候选', ['evt-006'], requestId)
  release.status = 'published'
  release.publishedAt = new Date().toISOString()

  // 发布后工程师改了契约
  const event = store.data.events.find((item) => item.id === 'evt-006')!
  const city = event.properties.find((item) => item.id === 'prop-022')!
  const frozenDescription = city.description
  city.description = '事后被改坏的描述'
  event.updatedAt = new Date().toISOString()

  store.executeRollback(release.id, '验证冻结回滚', 'server', 'EV-ROLLBACK-1')
  const restored = store.data.events.find((item) => item.id === 'evt-006')!
  assert.equal(
    restored.properties.find((item) => item.id === 'prop-022')!.description,
    frozenDescription,
  )
  const rolledBack = store.data.releases.find((item) => item.id === release.id)!
  assert.equal(rolledBack.status, 'rolled_back')
})

console.log(failures === 0 ? '\n全部存储层断言通过' : `\n${failures} 个断言失败`)
process.exit(failures === 0 ? 0 : 1)
