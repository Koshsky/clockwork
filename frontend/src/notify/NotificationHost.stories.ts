import type { Meta, StoryObj } from '@storybook/vue3-vite'
import NotificationHost from './NotificationHost.vue'
import { dismissNotification, notifications, notifyError, notifyInfo, notifySuccess } from './state'
import { isNavOpen, toggleNav, NAV_WIDTH } from '../composables/useNavDrawer'

const meta: Meta<typeof NotificationHost> = {
  title: 'Notifications/NotificationHost',
  component: NotificationHost,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

/**
 * Interactive story: pushes notifications onto the generic stack (the same
 * queue the axios interceptor uses for failed mutations) and renders the
 * fixed host in the bottom-left corner. The «Меню» button demonstrates how
 * the stack follows the navigation drawer (shifts by NAV_WIDTH). Works in
 * light/dark and all themes (the decorators switch them).
 */
export const Default: Story = {
  render: () => ({
    components: { NotificationHost },
    data() {
      return { isNavOpen, NAV_WIDTH }
    },
    methods: {
      err() {
        notifyError('Не удалось удалить пользователя «Иванов И.»: на него ссылаются записи')
      },
      errLong() {
        notifyError(
          'Удаление невозможно — пользователь указан:\n• задачи: 3\n• комментарии: 1\n• шаблоны автосоздания: 2',
        )
      },
      ok() {
        notifySuccess('Пользователь удалён')
      },
      info() {
        notifyInfo('Сохранено в офлайн-очереди, отправится при восстановлении связи')
      },
      clear() {
        for (const n of [...notifications.value]) dismissNotification(n.id)
      },
      menu() {
        toggleNav()
      },
    },
    template: `
      <div style="padding:24px;font-family:sans-serif;display:flex;flex-direction:column;gap:10px;align-items:flex-start;">
        <p style="color:var(--muted-foreground);font-size: calc(var(--ui-font-scale, 1) * 13px);">
          Демо общего стека уведомлений: низ-слева, полоска-таймер на верхней кромке
          (5 с для ошибок), стек сдвигается вместе с боковым меню.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" @click="err"
                  style="padding:8px 14px;border-radius:8px;border:none;background:var(--destructive);color:var(--destructive-foreground);cursor:pointer;">
            Ошибка удаления
          </button>
          <button type="button" @click="errLong"
                  style="padding:8px 14px;border-radius:8px;border:none;background:var(--destructive);color:var(--destructive-foreground);cursor:pointer;">
            Ошибка 409 (список)
          </button>
          <button type="button" @click="ok"
                  style="padding:8px 14px;border-radius:8px;border:none;background:var(--primary);color:var(--primary-foreground);cursor:pointer;">
            Успех
          </button>
          <button type="button" @click="info"
                  style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;cursor:pointer;">
            Инфо
          </button>
          <button type="button" @click="menu"
                  style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;cursor:pointer;">
            Меню: сдвиг стека
          </button>
          <button type="button" @click="clear"
                  style="padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;cursor:pointer;">
            Очистить
          </button>
        </div>
        <span style="font-size:11.5px;color:var(--muted-foreground);">
          Меню сейчас: {{ isNavOpen ? 'открыто — стек сдвинут на ' + NAV_WIDTH + 'px' : 'закрыто — стек у левого края' }}
        </span>
        <NotificationHost />
      </div>
    `,
  }),
}