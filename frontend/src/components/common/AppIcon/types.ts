/**
 * Icon name -> SVG path data.
 *
 * All icons share a 24x24 viewBox, stroke rendering (fill none) with
 * stroke-width 1.8 in Material Outlined / Feather style. Every shape is
 * expressed as plain <path> elements so the component can render paths only.
 * The color always follows the parent's `currentColor`.
 */
export const APP_ICONS = {
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  'chevron-down': ['m6 9 6 6 6-6'],  sun: [
    'M12 2v2',
    'M12 20v2',
    'M4.93 4.93l1.41 1.41',
    'M17.66 17.66l1.41 1.41',
    'M2 12h2',
    'M20 12h2',
    'M4.93 19.07l1.41-1.41',
    'M17.66 6.34l1.41-1.41',
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  ],
  moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'],
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
  refresh: ['M3 12a9 9 0 1 0 2.6-6.4L3 8', 'M3 3v5h5'],
  kanban: ['M2 5h20', 'M6 5v14', 'M12 5v9', 'M18 5v17'],
  flow: [
    'M8.6 6a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z',
    'M20.6 6a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z',
    'M14.6 18a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z',
    'M6 8.6v2.4a3 3 0 0 0 3 3h3',
  ],
  checklist: ['M3.5 3.5h17v17h-17z', 'm5.5 7.5 2 2 3.5-3.5'],
  calendar: ['M3 4.5h18v16.5H3z', 'M16 2.5v4', 'M8 2.5v4', 'M3 10h18'],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  cpu: [
    'M7 7h10v10H7z',
    'M10.5 10.5h3v3h-3z',
    'M9.5 2v3',
    'M14.5 2v3',
    'M9.5 19v3',
    'M14.5 19v3',
    'M2 9.5h3',
    'M2 14.5h3',
    'M19 9.5h3',
    'M19 14.5h3',
  ],
  shield: ['M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z'],
  org: ['M3.5 3h5v5h-5z', 'M15.5 3h5v5h-5z', 'M9 16h6v5H9z', 'M6 8v4.5', 'M18 8v4.5', 'M12 12v4'],
  sparkles: [
    'm12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z',
    'm19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z',
  ],
  tag: [
    'M20.6 13.4 12 4.8H4.5v7.5l8.6 8.6a2 2 0 0 0 2.8 0l4.7-4.7a2 2 0 0 0 0-2.8Z',
    'M8.5 6.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  ],
  key: ['M7.5 15.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z', 'm11.5 11.5 8.5-8.5', 'M17 5l3 3'],
  scroll: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v5h5', 'M9 13h6', 'M9 17h6'],
  languages: ['m5 8 6 6', 'm4 14 6-6 2-3', 'M2 5h12', 'M7 2h1', 'm22 22-5-10-5 10', 'M14 18h6'],
  'user-circle': [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M12 8a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
    'M4.5 20.5a7.5 7.5 0 0 1 15 0',
  ],
  list: ['M3 6h2', 'M3 12h2', 'M3 18h2', 'M8 6h13', 'M8 12h13', 'M8 18h13'],
  clock: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
    'M12 7v5l3 3',
  ],
} as const

/** Available icon names */
export type AppIconName = keyof typeof APP_ICONS

export interface AppIconProps {
  /** Icon to render */
  name: AppIconName
  /** Icon size in px; defaults to 18 */
  size?: number
}