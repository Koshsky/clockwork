import type ru from '../ru/header'
import type { Translation } from '../types'

export default {
  profile: 'Profile',
  themeToggle: 'Switch theme (currently {theme})',
  themeAria: 'Switch theme',
  themeLight: 'light',
  themeDark: 'dark',
  changelog: 'Changelog',
  languageToggle: 'Switch language (currently {language})',
  languageAria: 'Switch language',
  langRu: 'Russian',
  langEn: 'English',
  logout: 'Sign out',
  menuShortcut: 'Menu (Ctrl+B)',
  menuOpen: 'Open menu',
  menuClose: 'Close menu',
} satisfies Translation<typeof ru>
