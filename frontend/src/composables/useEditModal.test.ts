import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useEditModal } from './useEditModal'

describe('editing rights are checked at open and submission', () => {
  it('cannot open an unauthorized object even with an explicit open call', () => {
    const save = vi.fn()
    const modal = useEditModal<{ id: number }>(() => [], save, () => 'Edit', undefined, (item) => item.id === 7)
    modal.open({ id: 8 })
    expect(modal.bind.value.open).toBe(false)
    modal.open({ id: 7 })
    expect(modal.bind.value.open).toBe(true)
  })
  it('revocation hides the existing editor immediately and prevents a queued submit', async () => {
    const granted = ref(true), save = vi.fn()
    const modal = useEditModal<{ id: number }>(() => [], save, () => 'Edit', undefined, () => granted.value)
    modal.open({ id: 7 })
    granted.value = false
    expect(modal.bind.value.open).toBe(false)
    await modal.submit({ title: 'Forbidden' })
    expect(save).not.toHaveBeenCalled()
    await nextTick()
    granted.value = true
    expect(modal.bind.value.open).toBe(false)
  })
  it('preserves authorized submissions and callers without an object gate', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true })
    const modal = useEditModal<{ id: number }>(() => [], save, () => 'Edit')
    modal.open({ id: 7 })
    await modal.submit({ title: 'Allowed' })
    expect(save).toHaveBeenCalledWith({ id: 7 }, { title: 'Allowed' })
    expect(modal.bind.value.open).toBe(false)
  })
})
