import type { AxiosResponse } from 'axios'
import type { DataFailure } from '@/data/contracts'

// Legacy store error handlers still need cancellation and retry details; these
// transient renderer errors never cross IPC or enter a persistent snapshot.
const origins = new WeakMap<DataFailure, unknown>()
export function rememberFailure(failure: DataFailure, cause: unknown): DataFailure { origins.set(failure, cause); return failure }
export function failureOrigin(failure: DataFailure): unknown { return origins.get(failure) }

const responses = new WeakMap<object, AxiosResponse>()
export function rememberResponse<T extends object>(result: T, response: AxiosResponse): T { responses.set(result, response); return result }
export function responseOrigin(result: object): AxiosResponse | undefined { return responses.get(result) }
