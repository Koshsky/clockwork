import definitions from './business-bindings.json'

export interface BusinessBinding {
  kind: 'read' | 'command'
  operation: string
  request: { route: string; path?: Record<string, string>; query?: Record<string, string>; body?: string; bodyFields?: Record<string, string> }
  page?: boolean
  unwrap?: string
}
export const businessBindings = definitions as readonly BusinessBinding[]
export function businessBinding(operation: string): BusinessBinding {
  const binding = businessBindings.find(binding => binding.operation === operation)
  if (!binding) throw new Error('APPLICATION_OPERATION_UNAVAILABLE')
  return binding
}
export function businessRequest(operation: string, input: unknown) {
  const binding = businessBinding(operation), source = (input ?? {}) as Record<string, unknown>
  const field = (name: string) => name === '$' ? input : source[name]
  const fields = (mapping: Record<string, string> = {}) => Object.fromEntries(Object.entries(mapping).flatMap(([name, key]) => {
    const value = field(key)
    return value == null ? [] : [[name, Array.isArray(value) ? value.join(',') : String(value)]]
  }))
  const body = binding.request.body ? field(binding.request.body) as Record<string, unknown> : binding.request.bodyFields
    ? Object.fromEntries(Object.entries(binding.request.bodyFields).flatMap(([name, key]) => field(key) == null ? [] : [[name, field(key)]])) : undefined
  return { route: binding.request.route, path: fields(binding.request.path), query: fields(binding.request.query), ...(body ? { body } : {}) }
}
