import type { ArgTypes } from '@storybook/vue3-vite'
import { LINK_STYLES } from '../linkStyle'
import type { DependencyStylePreviewProps } from './types'

export const dependencyStylePreviewArgTypes: ArgTypes<DependencyStylePreviewProps> = {
  connector: {
    name: 'Стиль линий связей',
    description: 'Форма линий зависимостей (та же настройка, что и в разделе «Диаграммы»)',
    control: 'inline-radio',
    options: [...LINK_STYLES],
    table: { defaultValue: { summary: 'rounded' }, category: 'Appearance' },
  },
}

export default dependencyStylePreviewArgTypes
