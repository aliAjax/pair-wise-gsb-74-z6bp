/* eslint-disable no-console */
// 逻辑验证：冻结快照 / 漂移失效 / 乐观锁 / 幂等 / 崩溃恢复 / 回滚还原
import './shim'
import { createPinia, setActivePinia } from 'pinia'

setActivePinia(createPinia())

const { useGovernanceStore } = await import('@/stores/governance')
const { loadState, saveState } = await import('@/services/repository')
const { detectReleaseDrift, emptyDrift } = await import('@/services/releaseSnapshot')

let passed = 0
let failed = 0
const check = (name: string, condition: boolean): void => {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

const store = useGovernanceStore()
const rel = () => store.data.releases.find((r) => r.id === 'rel-001')!
const mig = (depId: string) => rel().migrationConfirmations.find((c) => c.dependencyId === depId)!
const appr = (role: string) => rel().approvals.find((a) => a.role === role)!

console.log('1. 送审冻结')
check('候选带血缘摘要', Boolean(rel().snapshot.overallDigest))
check(
  '冻结 3 个事件 + 4 个依赖',
  rel().snapshot.events.length === 3 && rel().snapshot.dependencies.length === 4,
)
check('初始无漂移', emptyDrift(detectReleaseDrift(store.data, rel())))
check('初始 revision 为 1', rel().revision === 1)

console.log('2. 会签期间改契约 → 受影响确认失效，未受影响保留')
const evt003 = structuredClone(store.data.events.find((e) => e.id === 'evt-003')!)
evt003.properties.find((p) => p.id === 'prop-012')!.type = 'string'
store.saveEvent(evt003)
check('dep-004(引用 evt-003) 已确认 → 失效', mig('dep-004').status === 'invalidated')
check('dep-001(不引用 evt-003) 保持 pending', mig('dep-001').status === 'pending')
check('dep-006 的确认不受影响', mig('dep-006').status === 'pending')
check('已通过的数据审批 → 失效', appr('data').status === 'invalidated')
check('失效确认记录原因', Boolean(mig('dep-004').invalidatedReason))
check('失效使 revision 递增', rel().revision === 2)
check('漂移可检测', !emptyDrift(detectReleaseDrift(store.data, rel())))

console.log('3. 乐观锁：后到提交看到版本冲突，不覆盖')
const conflict = store.confirmMigration(rel().id, mig('dep-001').id, '窗口B', '旧版本提交', {
  expectedRevision: rel().revision - 1,
  submissionId: 'sub-stale',
})
check('过期版本提交被拒绝', !conflict.ok && conflict.reason === 'conflict')
check('冲突后 dep-001 仍未确认', mig('dep-001').status === 'pending')
const ok1 = store.confirmMigration(rel().id, mig('dep-001').id, '窗口A', '看板已适配', {
  expectedRevision: rel().revision,
  submissionId: 'sub-a',
})
check('正确版本提交成功', ok1.ok)
const ok2 = store.confirmMigration(rel().id, mig('dep-005').id, '窗口B', '实验已适配', {
  expectedRevision: rel().revision,
  submissionId: 'sub-b',
})
check('另一窗口基于最新版本提交成功', ok2.ok)
check(
  '两条确认都保留',
  mig('dep-001').status === 'confirmed' && mig('dep-005').status === 'confirmed',
)
check('窗口A意见未被覆盖', mig('dep-001').note === '看板已适配')

console.log('4. 幂等重试')
const dup = store.confirmMigration(rel().id, mig('dep-001').id, '窗口A', '看板已适配', {
  expectedRevision: rel().revision,
  submissionId: 'sub-a',
})
check('重复 submissionId 返回 duplicated', dup.ok && dup.duplicated === true)
check(
  '未重复生成确认记录',
  rel().migrationConfirmations.filter((c) => c.dependencyId === 'dep-001').length === 1,
)
check(
  '未重复写审计',
  store.data.audit.filter((a) => a.action === '确认迁移' && a.detail.includes('窗口A')).length ===
    1,
)

console.log('5. 重新送审冻结：受影响的重置，未受影响的保留')
const refreeze = store.refreshReleaseSnapshot(rel().id)
check('重新送审成功', refreeze.ok)
check('重新冻结后无漂移', emptyDrift(detectReleaseDrift(store.data, rel())))
check('dep-004 确认重置为 pending', mig('dep-004').status === 'pending')
check('dep-001 已确认且血缘未变 → 保留', mig('dep-001').status === 'confirmed')
check('dep-005 已确认且血缘未变 → 保留', mig('dep-005').status === 'confirmed')
check('审批全部重置待审', rel().approvals.every((a) => a.status === 'pending'))
const createDup = store.createRelease('2026.11.0', '幂等测试', ['evt-002'], 'idem-key-1')
const createDup2 = store.createRelease('2026.11.0', '幂等测试', ['evt-002'], 'idem-key-1')
check('同幂等键重复创建返回同一候选', createDup.id === createDup2.id)
check(
  '未重复生成候选',
  store.data.releases.filter((r) => r.idempotencyKey === 'idem-key-1').length === 1,
)

console.log('6. 发布门禁：漂移拒绝，全量通过后按冻结内容发布')
const clean = store.createRelease('2026.12.0', '发布验证', ['evt-002', 'evt-004', 'evt-006'], 'idem-pub')
const cleanRel = () => store.data.releases.find((r) => r.id === clean.id)!
const evt004 = structuredClone(store.data.events.find((e) => e.id === 'evt-004')!)
evt004.properties.find((p) => p.id === 'prop-016')!.enumValues.push('pending')
store.saveEvent(evt004)
const drifted = store.publishRelease(clean.id)
check('有漂移时拒绝发布', !drifted.ok && drifted.reason === 'drift')
store.refreshReleaseSnapshot(clean.id)
for (const c of cleanRel().migrationConfirmations) {
  if (c.status === 'confirmed') continue
  store.confirmMigration(clean.id, c.id, c.reviewer || '确认人', '已按冻结内容完成迁移', {
    expectedRevision: cleanRel().revision,
    submissionId: `pub-${c.id}`,
  })
}
for (const a of cleanRel().approvals) {
  store.updateApproval(clean.id, a.role, 'approved', a.actor, '同意发布', {
    expectedRevision: cleanRel().revision,
    submissionId: `pub-${a.id}`,
  })
}
const published = store.publishRelease(clean.id)
check('全部通过后发布成功', published.ok)
check('候选状态已发布', cleanRel().status === 'published')
const frozenEvt002 = cleanRel().snapshot.events.find((e) => e.eventId === 'evt-002')!
const baseline = store.data.baselines.find((b) => b.eventId === 'evt-002')
check(
  '基线属性来自冻结快照',
  baseline?.version === frozenEvt002.version &&
    baseline.properties.length === frozenEvt002.properties.length,
)

console.log('7. 回滚恢复以冻结内容为准')
const evt002 = store.data.events.find((e) => e.id === 'evt-002')!
evt002.properties.find((p) => p.id === 'prop-007')!.description = '发布后被改乱的内容'
store.saveEvent(evt002)
const frozenDesc = cleanRel().snapshot.events
  .find((e) => e.eventId === 'evt-002')!
  .properties.find((p) => p.id === 'prop-007')!.description
store.executeRollback(clean.id, '线上异常', '全端', 'EVID-1')
const evt002After = store.data.events.find((e) => e.id === 'evt-002')!
check(
  '回滚后事件恢复为冻结内容',
  evt002After.properties.find((p) => p.id === 'prop-007')!.description === frozenDesc,
)
check('事件状态退回评审', evt002After.status === 'reviewing')
check('回滚记录包含恢复事件', store.data.rollbacks[0]!.restoredEventIds.includes('evt-002'))

console.log('8. 写入失败从最后一个完整状态恢复')
const KEY = 'eventrail-governance-v1'
localStorage.setItem(KEY, '{"broken":')
const recovered = loadState()
check('主键损坏时从备份恢复', Array.isArray(recovered.releases) && recovered.releases.length > 0)
check('恢复后主键已修复', localStorage.getItem(KEY) === JSON.stringify(recovered))
const before = loadState()
const proto = Object.getPrototypeOf(localStorage) as Storage
const originalSet = proto.setItem
let calls = 0
proto.setItem = function (this: Storage, k: string, v: string): void {
  calls += 1
  if (k === KEY && calls === 2) throw new Error('quota exceeded')
  originalSet.call(this, k, v)
}
let threw = false
try {
  saveState({ ...before, currentVersion: '2099.01.0' })
} catch {
  threw = true
}
proto.setItem = originalSet
check('写入失败抛错', threw)
check('失败后主键仍是最后一个完整状态', loadState().currentVersion === before.currentVersion)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exit(1)
