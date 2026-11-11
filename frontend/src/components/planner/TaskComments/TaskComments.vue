<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ModalForm } from '../../common'
import { dateLocale, fmtDateTime } from '@/i18n/date'
import { t } from '@/i18n'
import type { DtoCommentResponse } from '@/api'
import {
  flattenComments,
  type TaskCommentsProps,
  type SendCommentPayload,
  type DeleteCommentPayload,
} from './types'

const props = withDefaults(defineProps<TaskCommentsProps>(), {
  taskTitle: '',
  comments: () => [],
  users: () => [],
  busy: false,
  error: null,
  disabledReason: null,
  canManage: false,
  userId: null,
})

const emit = defineEmits<{
  close: []
  send: [payload: SendCommentPayload, acknowledge?: (saved: boolean) => void]
  draftChange: [dirty: boolean]
  delete: [payload: DeleteCommentPayload]
}>()

/** Drafts of the root comment and a reply (only one active reply at a time) */
const rootDraft = ref('')
const replyTo = ref<number | null>(null)
const replyDraft = ref('')

const sending = ref(false)
const sendError = ref(false)
watch([rootDraft, replyDraft], () => emit('draftChange', !!rootDraft.value.trim() || !!replyDraft.value.trim()))
const composerDisabled = computed(() => props.busy || sending.value || props.disabledReason != null)

/** Flat pre-order list for indented rendering */
const flat = computed(() => flattenComments(props.comments))

const userById = computed(() => new Map((props.users || []).map((u) => [u.id ?? 0, u])))

function fmtDate(iso?: string): string {
  if (!iso) return ''
  return fmtDateTime(iso)
}

/** Full date-time for the hover title (with seconds) */
function fmtDateFull(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(dateLocale(), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
}

function authorName(c: DtoCommentResponse): string {
  if (c.author_id == null) return '—'
  return userById.value.get(c.author_id)?.name ?? t('planner.taskComments.userFallback', { id: c.author_id })
}

/** Deletion: own always, others only with canManage (admin/vp) */
function canDelete(c: DtoCommentResponse): boolean {
  return c.author_id != null && (c.author_id === props.userId || props.canManage)
}

function openReply(commentId: number) {
  if (composerDisabled.value) return
  if (replyTo.value === commentId) {
    replyTo.value = null
    replyDraft.value = ''
    return
  }
  replyTo.value = commentId
  replyDraft.value = ''
}

function sendDraft(parentId?: number) {
  const draft = parentId == null ? rootDraft : replyDraft
  const content = draft.value.trim()
  if (!content || composerDisabled.value) return
  sendError.value = false
  if (!props.embedded) {
    emit('send', { content, parent_id: parentId })
    draft.value = ''
    if (parentId != null) replyTo.value = null
    return
  }
  sending.value = true
  emit('send', { content, parent_id: parentId }, (saved) => {
    sending.value = false
    sendError.value = !saved
    if (!saved) return
    draft.value = ''
    if (parentId != null) replyTo.value = null
  })
}

function sendRoot() {
  sendDraft()
}

function sendReply(commentId: number) {
  sendDraft(commentId)
}
</script>

<template>
  <component :is="embedded ? 'div' : ModalForm" v-bind="embedded ? {} : { open, title: taskTitle ? t('planner.taskComments.titleNamed', { title: taskTitle }) : t('planner.taskComments.titleFallback', { id: taskId }) }" @close="emit('close')">
    <div class="tc">
      <p v-if="error || sendError" class="tc-error" role="alert">{{ error || t('planner.workspace.saveFailed') }}</p>
      <p v-if="disabledReason" class="tc-offline">{{ disabledReason }}</p>

      <div class="tc-list">
        <div v-if="busy && flat.length === 0" class="tc-state">{{ t('planner.taskComments.loading') }}</div>
        <div v-else-if="flat.length === 0" class="tc-state">{{ t('planner.taskComments.empty') }}</div>

        <div
          v-for="(n, i) in flat"
          :key="n.comment.id ?? i"
          class="tc-item"
          :style="{ marginLeft: `${Math.min(n.depth, 8) * 14}px` }"
        >
          <div class="tc-head">
            <span class="tc-author">{{ authorName(n.comment) }}</span>
            <span v-if="n.orphan" class="tc-orphan" :title="t('planner.taskComments.orphanTitle')">{{ t('planner.taskComments.orphan') }}</span>
            <span class="tc-date" :title="fmtDateFull(n.comment.created_at)">{{ fmtDate(n.comment.created_at) }}</span>
          </div>
          <div class="tc-text">{{ n.comment.content }}</div>
          <div class="tc-actions">
            <button
              type="button"
              class="tc-btn"
              :disabled="composerDisabled"
              @click="openReply(n.comment.id ?? 0)"
            >{{ t('planner.taskComments.reply') }}</button>
            <button
              v-if="canDelete(n.comment)"
              type="button"
              class="tc-icon tc-del"
              :disabled="composerDisabled"
              :title="t('planner.taskComments.deleteTitle')"
              :aria-label="t('planner.taskComments.deleteTitle')"
              @click="emit('delete', { comment_id: n.comment.id ?? 0 })"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
            </button>
          </div>
          <div v-if="replyTo === (n.comment.id ?? 0)" class="tc-reply">
            <textarea
              v-model="replyDraft"
              class="tc-input"
              :aria-label="t('planner.taskComments.replyPlaceholder')"
              rows="2"
              :disabled="composerDisabled"
              :placeholder="t('planner.taskComments.replyPlaceholder')"
              @keydown.enter.exact.prevent="sendReply(n.comment.id ?? 0)"
            />
            <div class="tc-reply-row">
              <button
                type="button"
                class="tc-btn tc-send"
                :disabled="composerDisabled || !replyDraft.trim()"
                @click="sendReply(n.comment.id ?? 0)"
              >{{ t('planner.taskComments.send') }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="tc-composer">
        <textarea
          v-model="rootDraft"
          class="tc-input"
          :aria-label="t('planner.taskComments.composerPlaceholder')"
          rows="3"
          :disabled="composerDisabled"
          :placeholder="t('planner.taskComments.composerPlaceholder')"
          @keydown.enter.exact.prevent="sendRoot"
        />
        <div class="tc-composer-row">
          <span v-if="disabledReason" class="tc-hint">{{ disabledReason }}</span>
          <button
            type="button"
            class="tc-btn tc-send"
            :disabled="composerDisabled || !rootDraft.trim()"
            @click="sendRoot"
          >{{ t('planner.taskComments.send') }}</button>
        </div>
      </div>
    </div>
  </component>
</template>

<style scoped>
@import '../../../styles/tokens.css';
.tc {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
}
.tc-error {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-danger);
}
.tc-offline {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-warning);
}
.tc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 46vh;
  overflow-y: auto;
  padding: 2px;
}
.tc-state {
  padding: 18px 0;
  text-align: center;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  color: var(--ui-text-muted);
  border: 1px dashed var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
}
.tc-item {
  padding: 8px 10px;
  background: var(--ui-surface-2);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
}
.tc-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.tc-author {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 700;
  color: var(--ui-accent);
}
.tc-orphan {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-muted);
  font-style: italic;
}
.tc-date {
  margin-left: auto;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-2);
  white-space: nowrap;
}
.tc-text {
  margin-top: 4px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  line-height: 1.45;
  color: var(--ui-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.tc-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.tc-reply {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tc-reply-row {
  display: flex;
  justify-content: flex-end;
}
.tc-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--ui-border);
  padding-top: 12px;
}
.tc-composer-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.tc-hint {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-warning);
}
.tc-input {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 9px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}
.tc-input:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.tc-input:disabled {
  background: var(--ui-surface-2);
  color: var(--ui-text-muted);
  cursor: not-allowed;
}
.tc-btn {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 6px 14px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  cursor: pointer;
  background: transparent;
  color: var(--ui-accent);
}
.tc-btn:hover:not(:disabled) {
  background: rgba(26, 115, 232, 0.08);
}
.tc-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
/* Square icon button (comment deletion) */
.tc-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
}
.tc-icon:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.tc-del {
  color: var(--ui-danger);
}
.tc-del:hover:not(:disabled) {
  background: var(--ui-danger-soft);
}
.tc-send {
  background: var(--ui-accent);
  color: var(--ui-accent-on);
}
.tc-send:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
</style>