import type { ArgTypes } from '@storybook/vue3-vite'
import { LINK_STYLES } from '@/components/planner/linkStyle'
import type { TaskDependencyLinksProps } from './types'

export const taskDependencyLinksArgTypes: ArgTypes<TaskDependencyLinksProps> = {
  timeline: { control: false, table: { disable: true, category: 'Data' } },
  tasks: { control: false, table: { disable: true, category: 'Data' } },
  dependencies: { control: false, table: { disable: true, category: 'Data' } },
  connector: {
    name: 'Стиль линий связей',
    description:
      'Одна из шести форм линии (в приложении выбирается в настройках, раздел «Диаграммы»); точки привязки и засечка на ограничиваемой дате одинаковы во всех формах',
    control: 'select',
    options: [...LINK_STYLES],
    table: { defaultValue: { summary: 'rounded' }, category: 'Appearance' },
  },
}

export default taskDependencyLinksArgTypes
