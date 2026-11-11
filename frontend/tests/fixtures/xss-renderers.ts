import { createApp, h, ref } from 'vue'
import MarkdownView from '../../src/components/common/MarkdownView/MarkdownView.vue'

const source = ref('')
createApp({ render: () => h(MarkdownView, { source: source.value }) }).mount('#xss-renderer')
Object.assign(window, { setXssMarkdown: (value: string) => { source.value = value } })
