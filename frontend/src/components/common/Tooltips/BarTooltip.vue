<script setup lang="ts">
import { computed } from 'vue'
import type { BarTooltipProps } from './types'

const props = withDefaults(defineProps<BarTooltipProps>(), {
  rows: () => [],
  resources: () => [],
  comments: () => [],
  accent: '',
})

/** How many log entries to show before collapsing */
const MAX_COMMENTS = 4

const shownComments = computed(() => props.comments.slice(0, MAX_COMMENTS))
const moreComments = computed(() => props.comments.length - shownComments.value.length)
</script>

<template>
  <div class="bt">
    <div class="bt-title" :style="accent ? { color: accent } : {}">{{ title }}</div>
    <div v-for="r in rows" :key="r" class="bt-row">{{ r }}</div>
    <div v-if="resources.length" class="bt-resources">
      <div v-for="(r, i) in resources" :key="i" class="bt-res">
        <span class="bt-res-dot" :style="{ background: r.color || accent || '#cfcfcf' }" />
        <span>{{ r.label }}</span>
        <template v-if="r.quantity != null"><span class="bt-res-qty">×{{ r.quantity }}</span></template>
      </div>
    </div>
    <div v-if="comments.length" class="bt-comments">
      <div class="bt-comments-title">Комментарии ({{ comments.length }})</div>
      <div class="bt-comments-log">
        <div v-for="(c, i) in shownComments" :key="i" class="bt-comment">
          <div class="bt-c-head">
            <span v-if="c.author" class="bt-c-author">{{ c.author }}</span>
            <span v-if="c.date" class="bt-c-date">{{ c.date }}</span>
          </div>
          <div class="bt-c-text">{{ c.text }}</div>
        </div>
        <div v-if="moreComments > 0" class="bt-c-more">…и ещё {{ moreComments }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.bt {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  line-height: 1.5;
}
.bt-title {
  font-weight: 700;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  margin-bottom: 2px;
}
.bt-row {
  color: var(--ui-text-2);
  white-space: nowrap;
}
.bt-resources {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bt-res {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.bt-res-dot {
  /* Resource color; falls back to the accent (task) color, then gray */
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.bt-res-qty {
  color: var(--ui-text-muted);
}
.bt-comments {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--ui-border);
}
.bt-comments-title {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 700;
  color: var(--ui-text-2);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 3px;
}
.bt-comments-log {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 132px;
  overflow-y: auto;
}
.bt-comment {
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-surface);
  padding: 4px 7px;
}
.bt-c-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.bt-c-author {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 700;
  color: var(--ui-accent);
}
.bt-c-date {
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  color: var(--ui-text-muted);
}
.bt-c-text {
  margin-top: 1px;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  line-height: 1.4;
  color: var(--ui-text-2);
  white-space: normal;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bt-c-more {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-muted);
  font-style: italic;
  padding-left: 2px;
}
</style>
