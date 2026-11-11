import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import DependencyStylePreview from './DependencyStylePreview.vue'
import dependencyStylePreviewArgTypes from './argTypes'
import { LINK_STYLES } from '../linkStyle'
import { linkStyleLabel } from '../linkStyleLabels'

/**
 * The settings preview: a fixed mini-diagram (three bars, two links) drawn in
 * the chosen connector style. `AllStyles` shows every shape the picker offers.
 */
const meta: Meta<typeof DependencyStylePreview> = {
  title: 'Components/Planner/DependencyStylePreview',
  component: DependencyStylePreview,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  argTypes: dependencyStylePreviewArgTypes,
  args: { connector: 'rounded' },
}
export default meta
type Story = StoryObj<typeof meta>

/** Path data of the connectors of a (sub)tree. */
function linePaths(root: Element): string[] {
  return Array.from(root.querySelectorAll<SVGPathElement>('.dsp-line')).map(
    (p) => p.getAttribute('d') ?? '',
  )
}

export const Default: Story = {
  play: async ({ canvasElement, step }) => {
    await step('three bars, two links, two ticks', async () => {
      await new Promise((r) => setTimeout(r, 50))
      expect(canvasElement.querySelectorAll('.dsp-bar').length).toBe(3)
      expect(canvasElement.querySelectorAll('.dsp-line').length).toBe(2)
      expect(canvasElement.querySelectorAll('.dsp-tick').length).toBe(2)
      expect(canvasElement.querySelector('.dsp-preview')?.getAttribute('aria-label')).toContain(
        'Предпросмотр',
      )
    })

    await step('the default style is the rounded route', () => {
      for (const d of linePaths(canvasElement)) {
        expect(d).toContain('Q')
        expect(d).not.toContain('C')
      }
    })
  },
}

export const Sharp: Story = {
  args: { connector: 'sharp' },
  play: async ({ canvasElement, step }) => {
    await step('square corners: no curve commands at all', async () => {
      await new Promise((r) => setTimeout(r, 50))
      for (const d of linePaths(canvasElement)) {
        expect(d).not.toContain('Q')
        expect(d).not.toContain('C')
      }
    })
  },
}

export const SCurve: Story = {
  args: { connector: 's-curve' },
  play: async ({ canvasElement, step }) => {
    await step('one cubic Bézier per link', async () => {
      await new Promise((r) => setTimeout(r, 50))
      for (const d of linePaths(canvasElement)) {
        expect((d.match(/C/g) ?? []).length).toBe(1)
        expect(d).not.toContain('Q')
      }
    })
  },
}

/** Every shape the settings picker offers, in the widget the user sees there. */
export const AllStyles: Story = {
  render: () => ({
    components: { DependencyStylePreview },
    data: () => ({
      panels: LINK_STYLES.map((style) => ({ style, label: linkStyleLabel(style) })),
    }),
    template: `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;">
        <section v-for="p in panels" :key="p.style" :data-style="p.style">
          <div style="font-size:12px;font-weight:600;color:var(--ui-text);margin-bottom:6px;">{{ p.label }}</div>
          <DependencyStylePreview :connector="p.style" />
        </section>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    await step('all six shapes draw the same scene', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const sections = Array.from(canvasElement.querySelectorAll('[data-style]'))
      expect(sections.length).toBe(LINK_STYLES.length)
      for (const section of sections) {
        expect(section.querySelectorAll('.dsp-bar').length).toBe(3)
        expect(section.querySelectorAll('.dsp-line').length).toBe(2)
      }
    })
  },
}
