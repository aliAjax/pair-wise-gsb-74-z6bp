# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 数据、产品、客户端和测试四角色批量审批与发布门禁
- 事件废弃计划、替代事件和迁移说明
- 发布回滚记录与结果验证
- JSON 契约和 Markdown 契约文档导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃和回滚状态
- `src/services/releaseSnapshot.ts`：送审冻结、血缘摘要与契约漂移检测
- `src/services/selectors.ts`：契约比较、影响分析和校验规则
- `src/services/repository.ts`：localStorage 持久化，写入前保留备份，损坏时从最后一个完整状态恢复

## 发布评审一致性

- 每次送审把事件契约、平台规则和下游依赖冻结进发布候选，并计算血缘摘要；审批、迁移确认、导出和发布只认冻结内容
- 会签期间事件或血缘变化时，受影响依赖的未发布确认即时失效退回重审，未受影响的确认继续保留；可按当前契约重新送审冻结
- 迁移确认和审批提交携带候选版本号（乐观锁），后到提交遇到版本冲突会被拒绝并载入最新意见，不会覆盖他人提交
- 提交带幂等键，重试不会重复生成确认；写入失败从最后一个完整状态恢复；回滚按候选冻结内容还原事件契约

## 验证

```bash
npm run verify
```

覆盖冻结、漂移失效、粒度保留、乐观锁冲突、幂等重试、发布门禁、回滚还原和崩溃恢复共 39 项断言。
