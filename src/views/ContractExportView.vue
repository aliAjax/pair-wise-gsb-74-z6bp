<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CheckCircleIcon, DownloadIcon } from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const selectedEventIds = ref(
  store.data.events
    .filter((event) => ['approved', 'published', 'reviewing'].includes(event.status))
    .map((event) => event.id),
)
const format = ref<'json' | 'markdown'>('json')
const includeDeprecated = ref(false)
/** workspace：当前工作区；frozen：只认送审时冻结的事件、属性和依赖关系 */
const scope = ref<'workspace' | 'frozen'>('workspace')
const selectedReleaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)

const releaseOptions = computed(() =>
  store.data.releases.map((release) => ({
    label: `${release.version} ${release.title}（冻结于 ${
      release.frozenSnapshot
        ? new Date(release.frozenSnapshot.frozenAt).toLocaleDateString('zh-CN')
        : '无快照'
    }）`,
    value: release.id,
  })),
)
const selectedRelease = computed(
  () => store.data.releases.find((release) => release.id === selectedReleaseId.value) ?? null,
)

const eligibleEvents = computed(() =>
  scope.value === 'frozen' && selectedRelease.value?.frozenSnapshot
    ? selectedRelease.value.frozenSnapshot.events.map((frozen) => ({
        id: frozen.event.id,
        displayName: frozen.event.displayName,
        key: frozen.event.key,
        version: frozen.event.version,
        status: 'reviewing' as const,
      }))
    : store.data.events.filter((event) => includeDeprecated.value || event.status !== 'retired'),
)

watch(scope, (value) => {
  if (value === 'frozen' && selectedRelease.value?.frozenSnapshot) {
    selectedEventIds.value = selectedRelease.value.eventIds
  }
})
watch(selectedReleaseId, () => {
  if (scope.value === 'frozen' && selectedRelease.value?.frozenSnapshot) {
    selectedEventIds.value = selectedRelease.value.eventIds
  }
})

watch(includeDeprecated, () => {
  selectedEventIds.value = selectedEventIds.value.filter((id) =>
    eligibleEvents.value.some((event) => event.id === id),
  )
})

const markdown = computed(() => {
  if (scope.value === 'frozen' && selectedRelease.value?.frozenSnapshot) {
    const snapshot = selectedRelease.value.frozenSnapshot
    const events = snapshot.events.filter((event) => selectedEventIds.value.includes(event.event.id))
    return [
      `# 埋点事件契约 ${selectedRelease.value.version}（送审冻结）`,
      '',
      `> 冻结时间：${new Date(snapshot.frozenAt).toLocaleString('zh-CN')} · 血缘摘要：${snapshot.lineageDigest.slice(0, 8)}`,
      '',
      ...events.flatMap((frozen) => [
        `## ${frozen.event.displayName} (\`${frozen.event.key}\`)`,
        '',
        `- 版本：${frozen.event.version}`,
        `- 负责人：${frozen.event.owner}`,
        `- 触发时机：${frozen.event.trigger}`,
        '',
        '| 属性 | 类型 | 必填 | 枚举 | 说明 |',
        '| --- | --- | --- | --- | --- |',
        ...frozen.properties
          .filter((property) => !property.deletedAt)
          .map(
            (property) =>
              `| ${property.name} | ${property.type} | ${property.required ? '是' : '否'} | ${property.enumValues.join('/') || '-'} | ${property.description} |`,
          ),
        '',
        '**平台差异（冻结）**',
        '',
        ...frozen.platformRules.map(
          (rule) =>
            `- ${rule.platform}: ${rule.enabled ? rule.trigger : '已停用'}（${rule.owner}）`,
        ),
        '',
      ]),
    ].join('\n')
  }
  const events = store.data.events.filter((event) => selectedEventIds.value.includes(event.id))
  return [
    `# 埋点事件契约 ${store.data.currentVersion}`,
    '',
    ...events.flatMap((event) => [
      `## ${event.displayName} (\`${event.key}\`)`,
      '',
      `- 版本：${event.version}`,
      `- 负责人：${event.owner}`,
      `- 状态：${event.status}`,
      `- 触发时机：${event.trigger}`,
      '',
      '| 属性 | 类型 | 必填 | 枚举 | 说明 |',
      '| --- | --- | --- | --- | --- |',
      ...event.properties
        .filter((property) => !property.deletedAt)
        .map(
          (property) =>
            `| ${property.name} | ${property.type} | ${property.required ? '是' : '否'} | ${property.enumValues.join('/') || '-'} | ${property.description} |`,
        ),
      '',
      '**平台差异**',
      '',
      ...event.platformRules.map(
        (rule) =>
          `- ${rule.platform}: ${rule.enabled ? rule.trigger : '已停用'}（${rule.owner}）`,
      ),
      '',
    ]),
  ].join('\n')
})

const output = computed(() => {
  if (scope.value === 'frozen' && selectedRelease.value) {
    if (format.value === 'json') return store.exportFrozenRelease(selectedRelease.value.id)
    return markdown.value
  }
  return format.value === 'json' ? store.exportContract(selectedEventIds.value) : markdown.value
})

const download = async (): Promise<void> => {
  if (selectedEventIds.value.length === 0) {
    await MessagePlugin.error('至少选择一个事件')
    return
  }
  const extension = format.value === 'json' ? 'json' : 'md'
  const mime =
    format.value === 'json'
      ? 'application/json;charset=utf-8'
      : 'text/markdown;charset=utf-8'
  const blob = new Blob([output.value], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  const versionPart =
    scope.value === 'frozen' && selectedRelease.value
      ? `${selectedRelease.value.version}-frozen`
      : store.data.currentVersion
  anchor.download = `event-contract-${versionPart}.${extension}`
  anchor.click()
  URL.revokeObjectURL(url)
  await MessagePlugin.success(
    scope.value === 'frozen' ? '已按送审冻结内容导出契约' : '契约文件已导出',
  )
}

const setExportSelection = (eventId: string, checked: unknown): void => {
  selectedEventIds.value = checked
    ? [...selectedEventIds.value, eventId]
    : selectedEventIds.value.filter((id) => id !== eventId)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="交付物"
      title="契约导出"
      description="选择事件和格式，生成可直接交付给客户端、数据与服务团队的事件契约文件。"
    />

    <div class="export-layout">
      <aside class="panel export-options">
        <div class="panel-header">
          <h2 class="panel-title">导出范围</h2>
          <span class="muted">{{ selectedEventIds.length }} 个事件</span>
        </div>
        <div class="format-options">
          <label>
            <input v-model="scope" type="radio" value="workspace" />
            <span>
              <strong>工作区口径</strong>
              <small>按当前编辑中的事件契约导出</small>
            </span>
          </label>
          <label>
            <input v-model="scope" type="radio" value="frozen" />
            <span>
              <strong>送审冻结口径</strong>
              <small>只认候选冻结时的事件、属性和依赖</small>
            </span>
          </label>
        </div>
        <div v-if="scope === 'frozen'" class="release-picker">
          <label>发布候选</label>
          <t-select v-model="selectedReleaseId" :options="releaseOptions" />
          <p v-if="selectedRelease && !selectedRelease.frozenSnapshot" class="scope-warning">
            该候选没有送审冻结快照，无法按冻结口径导出。
          </p>
        </div>
        <div class="format-options">
          <label>
            <input v-model="format" type="radio" value="json" />
            <span>
              <strong>JSON 契约</strong>
              <small>适合程序解析、校验和版本比较</small>
            </span>
          </label>
          <label>
            <input v-model="format" type="radio" value="markdown" />
            <span>
              <strong>Markdown 文档</strong>
              <small>适合评审、归档和团队阅读</small>
            </span>
          </label>
        </div>
        <label v-if="scope === 'workspace'" class="deprecated-option">
          <t-checkbox v-model="includeDeprecated" />
          <span>包含已废弃但仍保留历史口径的事件</span>
        </label>
        <div class="event-checklist">
          <label v-for="event in eligibleEvents" :key="event.id" class="event-check">
            <t-checkbox
              :value="selectedEventIds.includes(event.id)"
              :disabled="scope === 'frozen'"
              @change="setExportSelection(event.id, $event)"
            />
            <span>
              <strong>{{ event.displayName }}</strong>
              <small>{{ event.key }} · {{ event.version }}</small>
            </span>
            <StatusTag v-if="'status' in event" :value="event.status" />
            <StatusTag v-else value="reviewing" />
          </label>
        </div>
        <t-button theme="primary" class="download-button" @click="download">
          <template #icon><DownloadIcon /></template>
          导出契约
        </t-button>
      </aside>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2 class="panel-title">预览</h2>
          <span class="muted">
            <CheckCircleIcon />
            {{ output.length }} 字符
          </span>
        </div>
        <pre>{{ output }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.export-layout {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.export-options {
  position: sticky;
  top: 82px;
  padding-bottom: 16px;
}

.format-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  background: #e8ebef;
}

.format-options label {
  display: flex;
  gap: 10px;
  padding: 14px 15px;
  background: #fff;
  cursor: pointer;
}

.format-options span {
  display: grid;
  gap: 4px;
}

.format-options strong {
  font-size: 12px;
}

.format-options small {
  color: #727d8f;
  font-size: 10px;
  line-height: 1.4;
}

.deprecated-option {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 16px;
  color: #596579;
  font-size: 12px;
}

.release-picker {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid #e8ebef;
}

.release-picker label {
  font-size: 12px;
  font-weight: 600;
}

.scope-warning {
  margin: 0;
  color: #c46a00;
  font-size: 11px;
}

.event-checklist {
  max-height: 420px;
  overflow: auto;
  border-top: 1px solid #e8ebef;
}

.event-check {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 11px 16px;
  border-bottom: 1px solid #eef0f3;
  cursor: pointer;
}

.event-check > span {
  display: grid;
  gap: 3px;
}

.event-check strong {
  font-size: 12px;
}

.event-check small {
  color: #7a8494;
  font-size: 10px;
}

.download-button {
  width: calc(100% - 32px);
  margin: 14px 16px 0;
}

.preview-panel {
  overflow: hidden;
}

.preview-panel .muted {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.preview-panel pre {
  max-height: calc(100vh - 168px);
  margin: 0;
  padding: 20px;
  overflow: auto;
  color: #2f3a4d;
  background: #fbfcfd;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>
