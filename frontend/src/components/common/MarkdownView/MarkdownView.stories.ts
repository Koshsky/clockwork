import type { Meta, StoryObj } from '@storybook/vue3-vite'
import MarkdownView from './MarkdownView.vue'

const meta: Meta<typeof MarkdownView> = {
  title: 'Components/Common/MarkdownView',
  component: MarkdownView,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    source: 'Просто **жирный** и *курсивный* текст с `кодом`.',
  },
}
export default meta
type Story = StoryObj<typeof meta>

/** Typical hint content: paragraph, list, inline code and a code block. */
export const HintContent: Story = {
  args: {
    source: `Диаграмма задач: строки — задачи и ресурсы, столбцы — периоды.

- Задачи можно перемещать и растягивать — изменения сохраняются сразу.
- Зависимости (fs/ss/ff/sf): fs — следующая после завершения предыдущей.
- Drag не даёт создать цикл или поставить задачу раньше предшественника.

Что означают кнопки:

\`\`\`
Проект → Процесс → Задача → подзадачи
\`\`\`

Правило даёт доступ, если вы — владелец записи.`,
  },
}

/** Heading, ordered list and a table (GFM on by default). */
export const Structured: Story = {
  args: {
    source: `## Кнопки

1. «Свои» (self) — вы владелец записи.
2. «Все» (all) — весь справочник.

| Кнопка | Значение |
| --- | --- |
| self | свои |
| all | все |

> Цитата для акцента.`,
  },
}

/** Raw HTML and unsafe URLs must never reach the DOM (escaped/neutralized). */
export const Sanitized: Story = {
  args: {
    source: `Безопасный текст.

<script>alert('xss')</script>

Плохая ссылка: [клик](javascript:alert(1)) и [картинка](https://example.com/x.png "картинка").

Хорошая ссылка: [пример](https://example.com).`,
  },
}