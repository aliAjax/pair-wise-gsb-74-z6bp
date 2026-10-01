/* eslint-disable no-console */
import assert from 'node:assert/strict'
import { createSeedState } from '../src/models/seed'
import {
  buildFrozenRelease,
  releaseDrift,
  reconcileRelease,
} from '../src/services/freeze'
import { releaseReadiness } from '../src/services/selectors'
import type { ReleaseCandidate } from '../src/models/domain'

let counter = 0
const createId = (prefix: string) => `${prefix}-test-${counter++}`

let failures = 0
const test = async (name: string, fn: () => void) => {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name}`)
    console.error(error instanceof Error ? error.message : error)
  }
}

// 1. 种子候选 rel-001 首次加载即校准：工程师在会签期间改了 evt-001/evt-003。
test('种子候选送审冻结后，受影响确认与旧审批立即失效，未受影响确认保留', () => {
  const state = createSeedState()
  const release = state.releases.find((item) => item.id === 'rel-001')!
  assert.ok(release.frozenSnapshot, '候选必须带冻结快照')
  assert.equal(release.revision >= 1, true)

  const mig4 = release.migrationConfirmations.find((item) => item.dependencyId === 'dep-004')!
  const mig1 = release.migrationConfirmations.find((item) => item.dependencyId === 'dep-001')!
  const mig5 = release.migrationConfirmations.find((item) => item.dependencyId === 'dep-005')!
  const mig6 = release.migrationConfirmations.find((item) => item.dependencyId === 'dep-006')!

  // dep-004 的已确认迁移基于旧血缘 -> 失效退回
  assert.equal(mig4.invalidated, true)
  assert.equal(mig4.status, 'pending')
  assert.equal(mig4.confirmedAt, undefined)
  // dep-001 引用的 order_id 类型变了，待确认也标记为需按新血缘重提
  assert.equal(mig1.invalidated, true)
  // dep-005 / dep-006 血缘没受影响 -> 保留
  assert.equal(mig5.invalidated, undefined)
  assert.equal(mig6.invalidated, undefined)

  // 数据负责人旧审批失效，其他本来就 pending 的不受影响
  const dataApproval = release.approvals.find((item) => item.role === 'data')!
  assert.equal(dataApproval.invalidated, true)
  assert.equal(dataApproval.status, 'pending')
  const productApproval = release.approvals.find((item) => item.role === 'product')!
  assert.equal(productApproval.invalidated, undefined)

  // 4 项迁移（仅 dep-004 旧确认失效、dep-001 为带提示的待确认）+ 4 项审批（1 项旧意见失效）
  // 迁移 0/4 -> 0，审批 0/4 -> 0，基础 30，失效扣分 (2 项 * 6) = 12，并封顶 60
  assert.equal(releaseReadiness(release, []), 12)
})

// 2. 新建候选：冻结快照与差异、确认清单一致；之后改事件触发精准失效。
test('送审冻结后修改事件：只失效引用变更属性血缘的依赖', () => {
  const state = createSeedState()
  // 用未参与 rel-001 的 evt-002 新建候选
  const build = buildFrozenRelease(state, '2026.11.0', ['evt-002'], createId, '2026-10-01T10:00:00Z')
  const release: ReleaseCandidate = {
    id: 'rel-test',
    version: '2026.11.0',
    title: '测试候选',
    status: 'reviewing',
    eventIds: ['evt-002'],
    affectedDependencyIds: build.affectedDependencyIds,
    differences: build.differences,
    migrationConfirmations: build.confirmations,
    approvals: [],
    frozenSnapshot: build.frozenSnapshot,
    revision: 1,
    createdAt: '2026-10-01T10:00:00Z',
  }
  state.releases.unshift(release)
  assert.equal(releaseDrift(state, release).drifted, false)

  // 修改 evt-002 的 pay_result 枚举（dep-002、dep-003 都引用 prop-007）
  const event = state.events.find((item) => item.id === 'evt-002')!
  const payResult = event.properties.find((item) => item.id === 'prop-007')!
  payResult.enumValues = ['success', 'failed', 'cancel', 'pending']
  event.updatedAt = '2026-10-01T11:00:00Z'

  const drift = releaseDrift(state, release)
  assert.deepEqual(drift.changedEventIds, ['evt-002'])
  assert.deepEqual([...drift.changedDependencyIds].sort(), ['dep-002', 'dep-003'])

  // 先确认两个迁移，再校准 -> 两个都应失效
  release.migrationConfirmations.forEach((confirmation) => {
    confirmation.status = 'confirmed'
    confirmation.confirmedAt = '2026-10-01T10:30:00Z'
  })
  const outcome = reconcileRelease(state, release, '2026-10-01T11:05:00Z')!
  assert.equal(outcome.invalidatedConfirmationIds.length, 2)
  assert.ok(release.migrationConfirmations.every((item) => item.status === 'pending'))

  // 修改一个与候选无关的事件（evt-006），候选不再漂移出新增项
  const city = state.events.find((item) => item.id === 'evt-006')!
  city.properties[0]!.description = '改了说明'
  city.updatedAt = '2026-10-01T12:00:00Z'
  // 已校准过的候选不重复失效；且 drift 里不会出现 evt-006
  const drift2 = releaseDrift(state, release)
  assert.ok(!drift2.changedEventIds.includes('evt-006'))
})

// 3. 幂等：同一 requestId 下的冻结构建两次必须产出相同血缘摘要。
test('冻结摘要稳定：同样内容重复构建摘要一致', () => {
  const stateA = createSeedState()
  const stateB = createSeedState()
  const a = buildFrozenRelease(stateA, '2026.12.0', ['evt-002'], createId, '2026-10-01T10:00:00Z')
  const b = buildFrozenRelease(stateB, '2026.12.0', ['evt-002'], createId, '2026-10-01T10:00:00Z')
  assert.equal(a.frozenSnapshot.lineageDigest, b.frozenSnapshot.lineageDigest)
  assert.deepEqual(a.affectedDependencyIds.sort(), b.affectedDependencyIds.sort())
})

// 4. 冻结导出内容不随后续修改改变（以冻结对象为数据源）。
test('审批与导出只读取冻结内容，事后修改不改变冻结快照', () => {
  const state = createSeedState()
  const release = state.releases.find((item) => item.id === 'rel-001')!
  const frozenOrderId = release.frozenSnapshot!.events
    .find((item) => item.event.id === 'evt-001')!
    .properties.find((item) => item.id === 'prop-001')!
  // 冻结时 order_id 是 number（送审时刻），当前是 string
  assert.equal(frozenOrderId.type, 'number')
  const currentOrderId = state.events
    .find((item) => item.id === 'evt-001')!
    .properties.find((item) => item.id === 'prop-001')!
  assert.equal(currentOrderId.type, 'string')
})

console.log(failures === 0 ? '\n全部断言通过' : `\n${failures} 个断言失败`)
process.exit(failures === 0 ? 0 : 1)
