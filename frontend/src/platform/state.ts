import { ref } from 'vue'

export const localDataAvailability = ref<'unknown' | 'available' | 'unavailable'>('unknown')
export const legacyQueueAvailability = ref<'unknown' | 'empty' | 'pending' | 'unavailable'>('unknown')
export const backendReachability = ref<'unknown' | 'reachable' | 'unreachable'>('unknown')
