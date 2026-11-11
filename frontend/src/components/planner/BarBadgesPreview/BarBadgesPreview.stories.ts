import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import BarBadgesPreview from './BarBadgesPreview.vue'
import { viewSettings } from '@/settings'

/**
 * The settings preview of the bar badges: the real `TaskBar` over a demo
 * timeline. Both stories drive the very same `viewSettings` flags the settings
 * checkboxes toggle, and restore them afterwards (the module is a singleton, so
 * a leaked value would follow the next story).
 */
const meta: Meta<typeof BarBadgesPreview> = {
  title: 'Components/Planner/BarBadgesPreview',
  component: BarBadgesPreview,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

/** Every switchable badge and the element it renders. */
const FLAGS = {
  badgeTaskProjectCode: '.tb-proj',
  badgeTaskOwner: '.tb-owner',
  badgeTaskResponsible: '.tb-responsible',
  badgeProgress: '.tb-progress',
  badgeResource: '.tb-badge',
  badgeComments: '.tb-comments',
} as const

type BadgeFlag = keyof typeof FLAGS

function snapshot(): Record<BadgeFlag, boolean> {
  return {
    badgeTaskProjectCode: viewSettings.badgeTaskProjectCode,
    badgeTaskOwner: viewSettings.badgeTaskOwner,
    badgeTaskResponsible: viewSettings.badgeTaskResponsible,
    badgeProgress: viewSettings.badgeProgress,
    badgeResource: viewSettings.badgeResource,
    badgeComments: viewSettings.badgeComments,
  }
}

function enableAll(): void {
  for (const flag of Object.keys(FLAGS) as BadgeFlag[]) viewSettings[flag] = true
}

const settle = () => new Promise((r) => setTimeout(r, 50))

export const Default: Story = {
  play: async ({ canvasElement, step }) => {
    const initial = snapshot()
    enableAll()
    try {
      await step('all four switches put their badge on the bar', async () => {
        await settle()
        expect(canvasElement.querySelectorAll('.bbp-preview .gantt-bar').length).toBe(1)
        for (const [flag, selector] of Object.entries(FLAGS)) {
          expect(canvasElement.querySelector(selector), flag).toBeTruthy()
        }
        expect(canvasElement.querySelector('.tb-proj')?.textContent?.trim()).toBe('KO-1001')
        expect(canvasElement.querySelector('.tb-progress')?.textContent?.trim()).toBe('50%')
        expect(canvasElement.querySelectorAll('.tb-badge').length).toBe(2)
        expect(canvasElement.querySelector('.tb-comments')?.textContent?.trim()).toBe('3')
      })

      await step('the demo bar is inert: no tab stop, no slider role', () => {
        const bar = canvasElement.querySelector('.gantt-bar')
        expect(bar?.getAttribute('tabindex')).toBeNull()
        expect(bar?.getAttribute('role')).toBeNull()
      })

      await step('the demo bar is wide enough: no badge is cut off', () => {
        // A badge the bar cannot hold would be clipped by the bar's own edge,
        // which reads as "the setting does nothing" in the settings screen.
        const bar = canvasElement.querySelector<HTMLElement>('.bbp-preview .gantt-bar')
        expect(bar).toBeTruthy()
        const barRight = bar!.getBoundingClientRect().right
        for (const selector of Object.values(FLAGS)) {
          for (const badge of Array.from(canvasElement.querySelectorAll<HTMLElement>(selector))) {
            const right = badge.getBoundingClientRect().right
            expect(right, `${selector} ("${badge.textContent?.trim()}") ends at ${right}px`).toBeLessThanOrEqual(barRight + 0.5)
          }
        }
      })
    } finally {
      Object.assign(viewSettings, initial)
    }
  },
}

/** Each switch removes exactly its own badge — and brings it back. */
export const DrivenBySettings: Story = {
  play: async ({ canvasElement, step }) => {
    const initial = snapshot()
    enableAll()
    try {
      for (const flag of Object.keys(FLAGS) as BadgeFlag[]) {
        const selector = FLAGS[flag]
        await step(`${flag} off → only its badge disappears`, async () => {
          await settle()
          expect(canvasElement.querySelector(selector), flag).toBeTruthy()
          viewSettings[flag] = false
          await settle()
          expect(canvasElement.querySelector(selector), flag).toBeNull()
          for (const [other, otherSelector] of Object.entries(FLAGS)) {
            if (other === flag) continue
            expect(canvasElement.querySelector(otherSelector), other).toBeTruthy()
          }
          viewSettings[flag] = true
          await settle()
          expect(canvasElement.querySelector(selector), flag).toBeTruthy()
        })
      }
    } finally {
      Object.assign(viewSettings, initial)
    }
  },
}
