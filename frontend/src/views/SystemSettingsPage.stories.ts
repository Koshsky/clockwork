import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import SystemSettingsPage from './SystemSettingsPage.vue'
import { LINK_STYLES } from '@/components/planner/linkStyle'
import { viewSettings } from '@/settings'
import { platformCapabilities } from '@/platform/context'
import { t } from '@/i18n'

/**
 * The settings screen (a view, not a component): its own stories exist for the
 * "Diagrams" section, where the connector style and the bar badges live. The
 * play test keeps both previews honest — an empty style dropdown, or a badge
 * preview that ignores the checkboxes, would otherwise ship unnoticed.
 */
const meta: Meta<typeof SystemSettingsPage> = {
  title: 'Views/SystemSettingsPage',
  component: SystemSettingsPage,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

/** Switches to the Diagrams section (the section switcher is a tab list). */
async function openDiagramsSection(root: HTMLElement): Promise<void> {
  const tab = Array.from(root.querySelectorAll<HTMLElement>('[aria-selected]')).find(
    (el) => el.textContent?.trim() === 'Диаграммы',
  )
  expect(tab).toBeTruthy()
  tab?.click()
  await new Promise((r) => setTimeout(r, 50))
}

/** The connector picker no longer has a visible label — find it by the preview. */
const connectorSelect = (root: HTMLElement): HTMLSelectElement | null =>
  root.querySelector<HTMLElement>('.dsp-preview')?.closest('.st-field')?.querySelector('select') ??
  null

/** Checkbox of a settings card, found by its label text. */
function checkboxByLabel(root: HTMLElement, label: string): HTMLInputElement | null {
  const option = Array.from(root.querySelectorAll<HTMLElement>('.st-option')).find((el) =>
    el.querySelector('span')?.textContent?.includes(label),
  )
  return option?.querySelector('input[type="checkbox"]') ?? null
}

const settle = () => new Promise((r) => setTimeout(r, 50))

/** The section switcher tabs, in document order. */
const sectionTabs = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]'))

/** Switches to a section by its visible tab label. */
async function openSection(root: HTMLElement, label: string): Promise<void> {
  const tab = sectionTabs(root).find((el) => el.textContent?.trim() === label)
  expect(tab, `no section tab "${label}"`).toBeTruthy()
  tab?.click()
  await settle()
}

/** Card titles of the cards currently mounted in the section body. */
const cardTitles = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.st-card-title')).map(
    (el) => el.textContent?.trim() ?? '',
  )

/**
 * The section switcher itself: it carries every section once, exactly one tab
 * is selected, and the tabs stay a comfortable click target. The size guard is
 * deliberate — these tabs were once the smallest control on the screen (29px,
 * below the 38px inputs next to them), and nothing else would catch a relapse.
 */
export const SectionSwitcher: Story = {
  play: async ({ canvasElement, step }) => {
    await step('every section is listed once, under a labelled tab list', () => {
      const list = canvasElement.querySelector<HTMLElement>('[role="tablist"]')
      expect(list).toBeTruthy()
      expect(list?.getAttribute('aria-label')?.trim()).not.toBe('')

      const labels = sectionTabs(canvasElement).map((tab) => tab.textContent?.trim() ?? '')
      expect(labels).toEqual(['Интерфейс', 'Диаграммы', 'Таблицы', t(platformCapabilities.serverSelection ? 'adminSystem.settings.sections.server' : 'adminSystem.settings.sync.refreshTitle')])
      for (const label of labels) {
        // A missing catalog key would render the raw key instead of a label.
        expect(label, label).not.toContain('adminSystem.')
      }

      // The interface hints ("applied immediately…") are gone as well.
      expect(canvasElement.textContent ?? '').not.toContain('Применяется сразу')
    })

    await step('the tabs are sized like a primary control', () => {
      const tabs = sectionTabs(canvasElement)
      expect(tabs.length).toBe(4)
      for (const tab of tabs) {
        const height = tab.getBoundingClientRect().height
        expect(height, `"${tab.textContent?.trim()}" is ${height}px tall`).toBeGreaterThanOrEqual(
          40,
        )
      }
    })

    await step('exactly one section is selected', () => {
      const selected = sectionTabs(canvasElement).filter(
        (tab) => tab.getAttribute('aria-selected') === 'true',
      )
      expect(selected.length).toBe(1)
      expect(selected[0].textContent?.trim()).toBe('Интерфейс')
    })

    await step('refresh settings follow platform capabilities in one card', async () => {
      const title = t(platformCapabilities.serverSelection ? 'adminSystem.settings.server.title' : 'adminSystem.settings.sync.refreshTitle')
      await openSection(canvasElement, title)
      const cards = Array.from(canvasElement.querySelectorAll<HTMLElement>('.st-card'))
      expect(cards.length).toBe(1)
      expect(cardTitles(canvasElement)).toEqual([title])

      const groups = Array.from(
        cards[0].querySelectorAll<HTMLElement>('.st-group-title'),
      ).map((el) => el.textContent?.trim() ?? '')
      expect(groups).toEqual(platformCapabilities.serverSelection ? ['Синхронизация', 'Подключение'] : [])

      expect(cards[0].querySelector('.st-option input[type="checkbox"]')).toBeTruthy()
      const address = cards[0].querySelector('.st-field input[type="text"]')
      if (platformCapabilities.serverSelection) expect(address).toBeTruthy()
      else expect(address).toBeNull()
      // The "Source: default." hint under the field is gone.
      expect(cards[0].textContent ?? '').not.toContain('Источник:')

      // ...and they belong to that section only.
      await openSection(canvasElement, 'Диаграммы')
      expect(cardTitles(canvasElement)).not.toContain(title)
      expect(canvasElement.querySelector('.st-field input[type="text"]')).toBeNull()
    })
  },
}

export const DiagramsSection: Story = {
  play: async ({ canvasElement, step }) => {
    await step('the connector style select lists all six shapes', async () => {
      await new Promise((r) => setTimeout(r, 50))
      await openDiagramsSection(canvasElement)
      const select = connectorSelect(canvasElement)
      expect(select).toBeTruthy()
      const options = Array.from(select?.options ?? [])
      expect(options.map((o) => o.value)).toEqual([...LINK_STYLES])
      // A missing catalog key would render the raw key (or nothing) — guard it.
      for (const option of options) {
        expect(option.text.trim(), option.value).not.toBe('')
        expect(option.text, option.value).not.toContain('adminSystem.')
      }
      // The visible field label is gone: the group heading labels the picker, so
      // the select keeps its name through aria-label only.
      const label = select?.getAttribute('aria-label') ?? ''
      expect(label.trim()).not.toBe('')
      expect(label).not.toContain('adminSystem.')
    })

    await step('the redundant hints are gone', () => {
      const text = canvasElement.textContent ?? ''
      // Each of these used to sit under its field and only repeat the label
      // or the control itself; they were removed from both catalogs.
      for (const gone of [
        'Какие видимые отметки',
        'От 50% до 200%',
        'На столько дней создаётся проект',
        'Ctrl+Shift+колесо',
      ]) {
        expect(text, gone).not.toContain(gone)
      }
    })

    await step('the project duration and the calendar unit share one row', () => {
      const row = canvasElement.querySelector<HTMLElement>('.st-field-row')
      expect(row).toBeTruthy()
      const fields = Array.from(row?.querySelectorAll<HTMLElement>('.st-field') ?? [])
      expect(fields.length).toBe(2)
      const tops = fields.map((f) => Math.round(f.getBoundingClientRect().top))
      const lefts = fields.map((f) => Math.round(f.getBoundingClientRect().left))
      expect(tops[0]).toBe(tops[1])
      expect(lefts[1]).toBeGreaterThan(lefts[0])
      // Both controls really live in that row.
      expect(row?.querySelector('input[type="number"]')).toBeTruthy()
      expect(row?.querySelectorAll('input[type="radio"]').length).toBe(2)
    })

    await step('the preview follows the selected style', async () => {
      const select = connectorSelect(canvasElement)
      expect(canvasElement.querySelector('.dsp-preview')).toBeTruthy()

      const pick = async (value: string): Promise<string> => {
        if (select) {
          select.value = value
          select.dispatchEvent(new Event('change'))
        }
        await new Promise((r) => setTimeout(r, 50))
        return canvasElement.querySelector('.dsp-line')?.getAttribute('d') ?? ''
      }

      const rounded = await pick('rounded')
      expect(rounded).toContain('Q')
      expect(rounded).not.toContain('C')

      const sharp = await pick('sharp')
      expect(sharp).not.toBe(rounded)
      expect(sharp).not.toContain('Q')
      expect(sharp).not.toContain('C')

      const curve = await pick('s-curve')
      expect(curve).toContain('C')
      expect(curve).not.toContain('Q')
    })

    await step('the badges preview shows the bar with the enabled badges', async () => {
      viewSettings.badgeProgress = true
      await settle()
      expect(canvasElement.querySelector('.bbp-preview')).toBeTruthy()
      expect(canvasElement.querySelector('.bbp-preview .gantt-bar')).toBeTruthy()
      expect(canvasElement.querySelector('.tb-progress')?.textContent?.trim()).toBe('50%')
    })

    await step('a badge checkbox switches its own badge off and on', async () => {
      const box = checkboxByLabel(canvasElement, 'Процент выполнения операций')
      expect(box).toBeTruthy()
      expect(box?.checked).toBe(true)

      box?.click()
      await settle()
      expect(viewSettings.badgeProgress).toBe(false)
      expect(canvasElement.querySelector('.tb-progress')).toBeNull()
      // The other badges stay put.
      expect(canvasElement.querySelector('.tb-proj')).toBeTruthy()
      expect(canvasElement.querySelector('.tb-owner')).toBeTruthy()
      expect(canvasElement.querySelector('.tb-badge')).toBeTruthy()

      box?.click()
      await settle()
      expect(viewSettings.badgeProgress).toBe(true)
      expect(canvasElement.querySelector('.tb-progress')?.textContent?.trim()).toBe('50%')
    })

    await step('the comments badge switch works too', async () => {
      viewSettings.badgeComments = true
      await settle()
      expect(canvasElement.querySelector('.tb-comments')?.textContent?.trim()).toBe('3')
      const box = checkboxByLabel(canvasElement, 'Комментарии')
      expect(box).toBeTruthy()
      box?.click()
      await settle()
      expect(viewSettings.badgeComments).toBe(false)
      expect(canvasElement.querySelector('.tb-comments')).toBeNull()
      box?.click()
      await settle()
      expect(canvasElement.querySelector('.tb-comments')?.textContent?.trim()).toBe('3')
    })

    await step('both appearance groups live in one card', () => {
      const cards = Array.from(canvasElement.querySelectorAll<HTMLElement>('.st-card'))
      const appearance = cards.find(
        (c) => c.querySelector('.st-card-title')?.textContent?.trim() === 'Внешний вид диаграмм',
      )
      expect(appearance).toBeTruthy()
      expect(appearance?.querySelector('.bbp-preview')).toBeTruthy()
      expect(appearance?.querySelector('.dsp-preview')).toBeTruthy()
      expect(appearance?.querySelectorAll('.st-group-title').length).toBe(2)
      // The connector picker no longer sits in the calendar card.
      const calendar = cards.find(
        (c) => c.querySelector('.st-card-title')?.textContent?.trim() === 'Календарь',
      )
      expect(calendar).toBeTruthy()
      expect(calendar?.querySelector('select')).toBeNull()
    })
  },
}

export const BadgeGroupsMatchTheirBars: Story = {
  play: async ({ canvasElement, step }) => {
    const groups = [
      ['project', 'badgeProjectOwner', 'badgeProjectResponsible'],
      ['process', 'badgeProcessOwner', 'badgeProcessResponsible'],
      ['task', 'badgeTaskOwner', 'badgeTaskResponsible'],
    ] as const
    const previous = { ...viewSettings }
    try {
      for (const [, owner, responsible] of groups) {
        viewSettings[owner] = true
        viewSettings[responsible] = true
      }
      viewSettings.badgeProcessProjectCode = true
      viewSettings.badgeTaskProjectCode = true
      await openDiagramsSection(canvasElement)
      expect(canvasElement.querySelectorAll('.bbp-preview .gantt-bar')).toHaveLength(3)
      for (const [kind] of groups) {
        await step(`${kind} controls affect only the matching preview`, async () => {
          const group = canvasElement.querySelector<HTMLElement>(`[data-badge-group="${kind}"]`)!
          const selector = kind === 'task' ? '.tb-owner' : '.lb-owner'
          const box = group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[kind === 'project' ? 0 : 1]!
          expect(group.querySelector(selector)).toBeTruthy()
          box.click()
          await settle()
          expect(group.querySelector(selector)).toBeNull()
          for (const [other] of groups) {
            if (other === kind) continue
            const otherSelector = other === 'task' ? '.tb-owner' : '.lb-owner'
            expect(canvasElement.querySelector(`[data-badge-group="${other}"] ${otherSelector}`)).toBeTruthy()
          }
          box.click()
          await settle()
          expect(group.querySelector(selector)).toBeTruthy()
        })
      }
      await step('project-code switches are independent for processes and tasks', async () => {
        const process = canvasElement.querySelector<HTMLElement>('[data-badge-group="process"]')!
        const task = canvasElement.querySelector<HTMLElement>('[data-badge-group="task"]')!
        const processBox = process.querySelector<HTMLInputElement>('input')!
        const taskBox = task.querySelector<HTMLInputElement>('input')!
        processBox.click()
        await settle()
        expect(process.querySelector('.lb-code')).toBeNull()
        expect(task.querySelector('.tb-proj')).toBeTruthy()
        taskBox.click()
        await settle()
        expect(task.querySelector('.tb-proj')).toBeNull()
        processBox.click()
        await settle()
        expect(process.querySelector('.lb-code')).toBeTruthy()
        expect(task.querySelector('.tb-proj')).toBeNull()
        taskBox.click()
        await settle()
        expect(task.querySelector('.tb-proj')).toBeTruthy()
      })
    } finally {
      Object.assign(viewSettings, previous)
    }
  },
}
