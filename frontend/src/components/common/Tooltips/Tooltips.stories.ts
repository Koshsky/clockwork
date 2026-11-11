import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import BarTooltip from './BarTooltip.vue'
import UsageTooltip from './UsageTooltip.vue'
import InfoTooltip from './InfoTooltip.vue'

const meta: Meta = {
  title: 'Components/Common/Tooltips',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj

/** Generic tooltip for a diagram item (task/project/process/milestone) with accents */
export const BarVariants: Story = {
  render: () => ({
    components: { BarTooltip },
    template: `
      <div style="font-family:sans-serif;display:grid;gap:16px;grid-template-columns:repeat(2,240px);align-items:start;">
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Задача</div>
          <BarTooltip title="Монтаж конструкций" :accent="'#34a853'" :rows="['18.07.2026 — 07.08.2026']" :resources="[{label:'Монтажник',quantity:3,color:'#ea4335'},{label:'Инженер',quantity:1,color:'#1a73e8'}]" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Проект</div>
          <BarTooltip title="Склад-Логистика" :accent="'#1a73e8'" :rows="['Приоритет: высокий','Владелец: Иванов','01.08.2026 — 20.09.2026']" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Процесс</div>
          <BarTooltip title="Инсталляция" :accent="'#1a73e8'" :rows="['Владелец: Петров','01.08.2026 — 10.08.2026']" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Веха</div>
          <BarTooltip title="Этап №1" :accent="'#fbbc04'" :rows="['Сдача отчётности','05.09.2026']" /></div>
      </div>
    `,
  }),
}

/** Resource usage tooltip grouped by states */
export const UsageVariants: Story = {
  render: () => ({
    components: { UsageTooltip },
    template: `
      <div style="font-family:sans-serif;display:grid;gap:16px;grid-template-columns:repeat(2,220px);align-items:start;">
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Норма</div><UsageTooltip :used="3" :available="5" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Перегруз</div><UsageTooltip :used="7" :available="5" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Критично</div><UsageTooltip :used="10" :available="5" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Нет данных</div><UsageTooltip :used="2" :available="null" /></div>
      </div>
    `,
  }),
}

/** Simple hints: labels, timesheet states, instructions */
export const InfoVariants: Story = {
  render: () => ({
    components: { InfoTooltip },
    template: `
      <div style="font-family:sans-serif;display:grid;gap:16px;grid-template-columns:repeat(2,220px);align-items:start;">
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Состояние табеля</div>
          <InfoTooltip title="Отпуск" :lines="['20.07.2026 — 02.08.2026']" marker="#1e88e5" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Сотрудник</div>
          <InfoTooltip title="Иванов Иван" :lines="['Инженер ПТО']" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Ресурс</div>
          <InfoTooltip title="Монтажник" :lines="['Всего: 12 человек']" /></div>
        <div><div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#888;margin-bottom:4px;">Инструкция</div>
          <InfoTooltip :lines="['Перетащить для смены приоритета']" /></div>
      </div>
    `,
  }),
}

/** Task tooltip with a comment log (up to 4 entries + "…and N more") */
const commentLog = [
  { author: 'Иванов Иван', date: '01.02.2026, 10:00', text: 'Перенести сроки?' },
  { author: 'Петров Пётр', date: '01.02.2026, 11:30', text: 'Нет, сроки фиксированы.' },
  { author: 'Сидоров Сидор', date: '01.02.2026, 12:05', text: 'Тогда уточните состав работ.' },
  { author: 'Петров Пётр', date: '02.02.2026, 09:15', text: 'Состав согласован вчера.' },
  { author: 'Иванов Иван', date: '03.02.2026, 08:00', text: 'Ок, фиксируем.' },
]

/** Full log within the limit (4 entries) */
export const CommentsLog: Story = {
  render: () => ({
    components: { BarTooltip },
    template: `
      <div style="font-family:sans-serif;width:260px;">
        <BarTooltip
          title="Монтаж конструкций"
          :accent="'#34a853'"
          :rows="['18.07.2026 — 07.08.2026']"
          :comments="commentLog"
        />
      </div>
    `,
    data: () => ({ commentLog }),
  }),
}

/** Log exceeds the limit — collapsed with "…and N more" */
export const CommentsLogCollapsed: Story = {
  tags: ['vitest'],
  render: () => ({
    components: { BarTooltip },
    template: `
      <div style="font-family:sans-serif;width:260px;">
        <BarTooltip title="Задача с обсуждением" :accent="'#34a853'" :comments="ten" />
      </div>
    `,
    data: () => ({
      ten: Array.from({ length: 10 }, (_, i) => ({
        author: `Автор ${i + 1}`,
        text: `Комментарий номер ${i + 1}`,
      })),
    }),
  }),
  play: async () => {
    await new Promise((r) => setTimeout(r, 50))
    const root = document.body
    expect(root.textContent).toContain('Комментарии (10)')
    expect(root.textContent).toContain('Комментарий номер 1')
    expect(root.textContent).toContain('…и ещё 6')
    // The log contains only 4 cards
    const cards = [...document.querySelectorAll('.bt-comment')]
    expect(cards.length).toBe(4)
  },
}
