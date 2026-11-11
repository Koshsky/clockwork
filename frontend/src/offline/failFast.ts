import { AxiosError, type AxiosPromise, type InternalAxiosRequestConfig } from 'axios'

/**
 * Fail-fast Axios adapter for offline mode (Electron): does not send the
 * request to the network and does not wait for a response/timeout — rejects
 * immediately with a synthetic network error carrying the real config
 * (method/URL/body). The error then flows through the existing response
 * interceptor branches (src/http.ts): mutations go straight into the outbox
 * queue, GETs are served from the offline cache.
 *
 * Injected ONLY into apiConfig() (src/store/index.ts), which the generated
 * API clients use. Service requests — outbox flush (flushOutbox via raw
 * axios) and the health probe (fetch) — never see this adapter and hit the
 * network as usual: otherwise, with the isOffline flag stuck and the network
 * back up, the whole queue would fail with meaningless Network Errors.
 */
export function offlineFailFastAdapter(config: InternalAxiosRequestConfig): AxiosPromise {
  return Promise.reject(new AxiosError('Network Error', 'ERR_NETWORK', config))
}