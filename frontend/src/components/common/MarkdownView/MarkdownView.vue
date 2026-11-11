<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from './markdown'

defineOptions({ name: 'MarkdownView' })

const props = withDefaults(defineProps<{ source?: string }>(), { source: '' })

/** Sanitized HTML of the Markdown source (see markdown.ts for the safety model). */
const html = computed(() => renderMarkdown(props.source))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown.ts escapes raw HTML and unsafe URLs -->
  <div class="mdv" v-html="html"></div>
</template>

<style scoped>
@import '../../../styles/tokens.css';

/* Typography for Markdown-rendered content; element selectors via :deep
   because the HTML comes from v-html (no scope attributes on children). */
.mdv {
  font-size: calc(var(--ui-font-scale, 1) * 17px);
  line-height: 1.6;
  color: var(--ui-text);
}

.mdv :deep(p) {
  margin: 0 0 10px;
}

.mdv :deep(p:last-child) {
  margin-bottom: 0;
}

.mdv :deep(h1),
.mdv :deep(h2),
.mdv :deep(h3) {
  margin: 16px 0 8px;
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  font-weight: 700;
  color: var(--ui-text);
}

.mdv :deep(h1:first-child),
.mdv :deep(h2:first-child),
.mdv :deep(h3:first-child) {
  margin-top: 0;
}

.mdv :deep(ul),
.mdv :deep(ol) {
  margin: 0 0 10px;
  padding-left: 20px;
}

.mdv :deep(ul:last-child),
.mdv :deep(ol:last-child) {
  margin-bottom: 0;
}

.mdv :deep(li) {
  margin-bottom: 4px;
}

.mdv :deep(li:last-child) {
  margin-bottom: 0;
}

.mdv :deep(code) {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: calc(var(--ui-font-scale, 1) * 15px);
  background: var(--ui-surface-2);
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  padding: 1px 5px;
  color: var(--ui-accent);
}

.mdv :deep(pre) {
  margin: 0 0 10px;
  background: var(--ui-surface-2);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  padding: 8px 10px;
  overflow-x: auto;
}

.mdv :deep(pre:last-child) {
  margin-bottom: 0;
}

.mdv :deep(pre code) {
  display: block;
  background: none;
  border: none;
  padding: 0;
  color: var(--ui-accent);
  white-space: pre-wrap;
}

.mdv :deep(a) {
  color: var(--ui-accent);
  text-decoration: underline;
}

.mdv :deep(strong) {
  font-weight: 700;
}

.mdv :deep(em) {
  font-style: italic;
}

.mdv :deep(blockquote) {
  margin: 0 0 10px;
  padding: 4px 12px;
  border-left: 3px solid var(--ui-border-strong);
  color: var(--ui-text-2);
}

.mdv :deep(blockquote:last-child) {
  margin-bottom: 0;
}

.mdv :deep(table) {
  border-collapse: collapse;
  margin: 0 0 10px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
}

.mdv :deep(table:last-child) {
  margin-bottom: 0;
}

.mdv :deep(th),
.mdv :deep(td) {
  border: 1px solid var(--ui-border);
  padding: 6px 10px;
  text-align: left;
}

.mdv :deep(th) {
  background: var(--ui-surface-2);
  font-weight: 700;
}
</style>