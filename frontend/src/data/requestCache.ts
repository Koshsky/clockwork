export interface RequestContext {
  scope: string
  revision: number | null
}
interface Entry<T> { value: T; context: RequestContext; at: number }
interface Flight<T> { key: string; context: RequestContext; controller: AbortController; promise: Promise<T>; subscribers: number }

export class ReadCancelled extends Error {
  constructor() { super('Read superseded'); this.name = 'ReadCancelled' }
}

function queryKey(value: unknown): string {
  return JSON.stringify(value, (_, part) => part && typeof part === 'object' && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)
}

// Channels belong to consumers; query keys include every server-side filter.
// A cancelled or previous-account response must never reach a store or cache.
export function createRequestCache(context: () => RequestContext, current: (value: RequestContext) => boolean, now = () => Date.now()) {
  const entries = new Map<string, Entry<unknown>>()
  const flights = new Map<string, Flight<unknown>>()
  const cancel = () => {
    for (const flight of flights.values()) flight.controller.abort()
    flights.clear()
  }
  return {
    async read<T>(channel: string, query: unknown, send: (signal: AbortSignal) => Promise<T>, options: { preferCache?: boolean; signal?: AbortSignal; ttl?: number } = {}): Promise<T> {
      const own = context()
      const key = queryKey([own.scope, channel, query])
      if (options.signal?.aborted) throw new ReadCancelled()
      let flight = flights.get(channel)
      if (flight && (flight.key !== key || !current(flight.context))) { flight.controller.abort(); flights.delete(channel); flight = undefined }
      const cached = entries.get(key)
      if (options.preferCache && cached && current(cached.context) && now() - cached.at < (options.ttl ?? 60000)) return cached.value as T
      if (!flight) {
        const controller = new AbortController()
        const created: Flight<T> = { key, context: own, controller, promise: Promise.resolve(undefined as T), subscribers: 0 }
        let response: Promise<T>
        try { response = send(controller.signal) } catch (error) { response = Promise.reject(error) }
        created.promise = response.then(value => {
          if (controller.signal.aborted || !current(own)) throw new ReadCancelled()
          entries.set(key, { value, context: own, at: now() })
          if (entries.size > 256) entries.delete(entries.keys().next().value!)
          return value
        }).catch(error => {
          if (controller.signal.aborted || !current(own)) throw new ReadCancelled()
          entries.delete(key)
          throw error
        }).finally(() => { if (flights.get(channel) === created) flights.delete(channel) })
        flights.set(channel, created)
        flight = created
      }
      // One leaving view must not cancel a query still used by another consumer.
      const subscribed = flight
      subscribed.subscribers++
      return new Promise<T>((resolve, reject) => {
        let settled = false
        const finish = (result: { value: T } | { error: unknown }) => {
          if (settled) return
          settled = true
          options.signal?.removeEventListener('abort', abort)
          subscribed.controller.signal.removeEventListener('abort', abort)
          subscribed.subscribers--
          if (subscribed.subscribers === 0 && flights.get(channel) === subscribed) {
            flights.delete(channel)
            subscribed.controller.abort()
          }
          if ('error' in result) reject(result.error)
          else resolve(result.value)
        }
        const abort = () => finish({ error: new ReadCancelled() })
        options.signal?.addEventListener('abort', abort, { once: true })
        subscribed.controller.signal.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted || subscribed.controller.signal.aborted) abort()
        subscribed.promise.then(value => finish({ value: value as T }), error => finish({ error }))
      })
    },
    pending(channel: string) { return flights.has(channel) },
    cancel,
    invalidate() { cancel(); entries.clear() },
  }
}
