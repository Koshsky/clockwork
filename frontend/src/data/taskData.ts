import type { InjectionKey } from 'vue'
import type { TaskDataPort } from './contracts'

export const taskDataKey: InjectionKey<TaskDataPort> = Symbol('task-data')
