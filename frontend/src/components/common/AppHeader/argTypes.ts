import type { ArgTypes } from '@storybook/vue3-vite'

// AppHeader takes no props: the brand lives inside the drawer (AppNavDrawer),
// nav categories are read from Pinia via useNavigation. The argTypes stay
// empty; the story is kept for visual regression of the whole topbar.
export const appHeaderArgTypes: ArgTypes<Record<string, never>> = {}

export default appHeaderArgTypes