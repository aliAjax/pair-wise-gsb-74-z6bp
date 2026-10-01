# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选送审时冻结事件、属性与下游血缘摘要，审批、迁移确认和导出均以冻结内容为准
- 事件或血缘变更后按摘要精准失效受影响的未发布确认并退回重审，未受影响确认保留
- 迁移/审批提交带乐观锁修订号，多窗口并发时后到一方先看到版本冲突
- WAL 预提交日志：写入失败从最后一个完整候选恢复，同 requestId 重试不重复生成确认
- 回滚恢复以原候选的冻结快照为准
- 事件废弃计划、替代事件和迁移说明
- 发布回滚记录与结果验证
- JSON 契约（工作区/送审冻结两种口径）和 Markdown 契约文档导出

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
- `src/stores/governance.ts`：Pinia 编辑、冻结送审、审批、废弃和回滚状态
- `src/services/freeze.ts`：送审冻结、血缘摘要、漂移检测与确认失效校准
- `src/services/repository.ts`：localStorage 持久化、WAL 写入失败恢复与版本冲突错误
- `src/services/selectors.ts`：契约比较、影响分析和校验规则

## 验证脚本

```bash
node_modules/.bin/esbuild scripts/verify-freeze.ts --bundle --platform=node \
  --format=esm --alias:@=./src --outfile=/tmp/verify-freeze.mjs && node /tmp/verify-freeze.mjs
node_modules/.bin/esbuild scripts/verify-store.ts --bundle --platform=node \
  --format=esm --alias:@=./src --outfile=scripts/.verify-store.mjs \
  && node scripts/.verify-store.mjs; rm -f scripts/.verify-store.mjs
```

发布评审页工具栏的“模拟下次写入失败”可手动演示 WAL 恢复与幂等重试。
