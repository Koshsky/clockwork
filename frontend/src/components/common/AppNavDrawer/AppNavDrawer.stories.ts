import type { Meta, StoryObj } from '@storybook/vue3-vite'
import type { NavCategory } from '../../../composables/useNavigation'
import AppNavDrawer from './AppNavDrawer.vue'

/** Permission-free test data that mirrors the real NAV_CATEGORIES (labels are i18n keys) */
const testCategories: NavCategory[] = [
  {
    label: 'nav.planner',
    roles: null,
    items: [
      { label: 'nav.projects', to: '/projects', name: 'projects' },
      { label: 'nav.processes', to: '/processes', name: 'processes' },
      { label: 'nav.tasks', to: '/planner', name: 'planner' },
    ],
  },
  {
    label: 'nav.timesheet',
    roles: ['vp', 'admin'],
    items: [
      { label: 'nav.timesheet', to: '/timesheet', name: 'timesheet' },
      { label: 'nav.employees', to: '/employees', name: 'employees' },
      { label: 'nav.resources', to: '/resources', name: 'resources' },
    ],
  },
  {
    label: 'nav.admin',
    roles: ['admin'],
    items: [
      { label: 'nav.users', to: '/users', name: 'users' },
      { label: 'nav.structure', to: '/structure', name: 'structure' },
      { label: 'nav.autoCreate', to: '/auto-create', name: 'auto-create', badge: 'new' },
      { label: 'nav.statuses', to: '/statuses', name: 'statuses' },
      { label: 'nav.permissions', to: '/permissions', name: 'permissions' },
      { label: 'nav.audit', to: '/audit', name: 'audit' },
    ],
  },
  {
    label: 'nav.system',
    roles: null,
    items: [
      { label: 'nav.queue', to: '/system/queue', name: 'system-queue' },
      { label: 'nav.settings', to: '/system/settings', name: 'system-settings' },
    ],
  },
]

const meta: Meta<typeof AppNavDrawer> = {
  title: 'Components/Common/AppNavDrawer',
  component: AppNavDrawer,
  tags: ['autodocs'],
  args: {
    open: true,
    categories: testCategories,
    activeName: 'planner',
    brand: 'MVS ERP',
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

/** The "Система" group collapsed; other sections render as usual */
export const SystemGroupCollapsed: Story = {
  args: {
    activeName: 'system-queue',
  },
}