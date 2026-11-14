import { onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { registerActiveRead } from '@/data/activeReads'
import { platformCapabilities } from '@/platform/context'
import { useRbacStore } from '@/store'
import { pageAllowed } from '@/utils/pageAccess'

export function usePageReadRefresh(refresh: () => Promise<unknown>): void {
  const rbac = useRbacStore()
  const route = useRoute()
  let stop: (() => void) | undefined
  let stopPolicyWatch: (() => void) | undefined
  const run = async () => {
    if (rbac.permsLoaded && !pageAllowed(String(route.name), rbac.can)) return false
    return refresh()
  }
  onMounted(() => {
    if (platformCapabilities.kind !== 'web') return
    stop = registerActiveRead(run)
    stopPolicyWatch = watch(() => rbac.viewRevision, () => { void run().catch(() => {}) })
  })
  onBeforeUnmount(() => { stop?.(); stopPolicyWatch?.() })
}
