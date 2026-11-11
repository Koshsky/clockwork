import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ModalField, ModalFormProps } from '../components/common/ModalForm'

export interface EditModalResult {
  ok: boolean
  error?: string | null
}

/**
 * Edit/create modal: edit/saving state + ready-made props for <ModalForm>.
 * buildFields(state) builds fields, onSave(state, values) saves and returns
 * { ok, error? } — the modal stays open when the save fails; the mutation
 * error itself is surfaced by the global toast stack (http.ts interceptor),
 * so the composable no longer renders it inside the modal.
 * getTitle/submitLabel provide the title and the button text for the state.
 */
export function useEditModal<T>(
  buildFields: (state: T) => ModalField[],
  onSave: (state: T, values: Record<string, string | number>) => Promise<EditModalResult>,
  getTitle: (state: T) => string,
  submitLabel?: (state: T) => string,
  canEdit?: (state: T) => boolean,
) {
  const edit: Ref<T | null> = ref(null)
  const saving = ref(false)

  const fields = computed(() => (edit.value ? buildFields(edit.value) : []))
  const title = computed(() => (edit.value ? getTitle(edit.value) : ''))

  function open(state: T) {
    if (canEdit && !canEdit(state)) return
    edit.value = state
  }

  function close() {
    edit.value = null
  }

  async function submit(values: Record<string, string | number>) {
    if (!edit.value || (canEdit && !canEdit(edit.value))) return
    saving.value = true
    const res = await onSave(edit.value, values)
    saving.value = false
    if (res.ok) {
      edit.value = null
    }
    // On failure the modal stays open; the toast reports the error.
  }

  const bind = computed<ModalFormProps>(() => ({
    open: !!edit.value && (!canEdit || canEdit(edit.value)),
    title: title.value,
    fields: fields.value,
    busy: saving.value,
    submitLabel: edit.value && submitLabel ? submitLabel(edit.value) : undefined,
  }))

  if (canEdit) {
    watch(() => edit.value != null && !canEdit(edit.value), (denied) => {
      if (denied) close()
    })
  }

  return { edit, saving, fields, open, close, submit, bind }
}
