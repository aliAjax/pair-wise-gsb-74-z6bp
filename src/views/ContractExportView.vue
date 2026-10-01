<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CheckCircleIcon, DownloadIcon } from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)
const release = computed(
  () => store.data.releases.find((item) => item.id === releaseId.value) ?? null,
)
const selectedEventIds = ref<string[]>([])
const format = ref<'json' | 'markdown'>('json')

const frozenEvents = computed(() => release.value?.snapshot.events ?? [])

watch(
  release,
  (value) => {
    selectedEventIds.value = value ? value.snapshot.events.map((event) => event.eventId) : []
  },
  { immediate: true },
)

const markdown = computed(() => {
  if (!release.value) return ''
  const events = frozenEvents.value.filter((event) => selectedEventIds.value.includes(event.eventId))
  return [
    `# 埋点事件契约 ${release.value.version}（送审冻结）`,
    '',
    `- 血缘摘要：#${release.value.snapshot.overallDigest}`,
    `- 冻结时间：${new Date(release.value.snapshot.frozenAt).toLocaleString('zh-CN')}`,
    '',
    ...events.flatMap((event) => [
      `## ${event.displayName} (\`${event.key}\`)`,
      '',
      `- 版本：${event.version}`,
      `- 负责人：${event.owner}`,
      `- 触发时机：${event.trigger}`,
      `- 事件摘要：#${event.digest}`,
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
  if (!release.value) return ''
  return format.value === 'json'
    ? store.exportContract(release.value.id, selectedEventIds.value)
    : markdown.value
})

const download = async (): Promise<void> => {
  if (!release.value) {
    await MessagePlugin.error('请先选择发布候选')
    return
  }
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
  anchor.download = `event-contract-${release.value.version}-frozen.${extension}`
  anchor.click()
  URL.revokeObjectURL(url)
  await MessagePlugin.success('已按送审冻结内容导出契约文件')
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
      description="导出内容只认送审时冻结的事件、属性和依赖关系，会签期间的契约改动不会混入交付物。"
    />

    <div class="export-layout">
      <aside class="panel export-options">
        <div class="panel-header">
          <h2 class="panel-title">导出范围</h2>
          <span class="muted">{{ selectedEventIds.length }} 个事件</span>
        </div>
        <div class="release-picker">
          <label>发布候选</label>
          <t-select
            v-model="releaseId"
            :options="
              store.data.releases.map((item) => ({
                label: `${item.version} ${item.title}`,
                value: item.id,
              }))
            "
          />
          <template v-if="release">
            <div class="freeze-meta">
              <StatusTag :value="release.status" />
              <span>血缘摘要 #{{ release.snapshot.overallDigest }}</span>
              <span>冻结于 {{ new Date(release.snapshot.frozenAt).toLocaleString('zh-CN') }}</span>
            </div>
          </template>
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
        <div class="event-checklist">
          <label v-for="event in frozenEvents" :key="event.eventId" class="event-check">
            <t-checkbox
              :value="selectedEventIds.includes(event.eventId)"
              @change="setExportSelection(event.eventId, $event)"
            />
            <span>
              <strong>{{ event.displayName }}</strong>
              <small>{{ event.key }} · {{ event.version }} · #{{ event.digest }}</small>
            </span>
          </label>
          <div v-if="frozenEvents.length === 0" class="empty-state">该候选没有冻结事件。</div>
        </div>
        <t-button theme="primary" class="download-button" :disabled="!release" @click="download">
          <template #icon><DownloadIcon /></template>
          导出冻结契约
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

.release-picker {
  display: grid;
  gap: 10px;
  padding: 14px 16px;
}

.release-picker > label {
  color: #596579;
  font-size: 12px;
}

.freeze-meta {
  display: grid;
  gap: 6px;
  justify-items: start;
  color: #7a8494;
  font-size: 11px;
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

.event-checklist {
  max-height: 420px;
  overflow: auto;
  border-top: 1px solid #e8ebef;
}

.event-check {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
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
