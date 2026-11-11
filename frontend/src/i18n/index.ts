import { createI18n } from 'vue-i18n'
import { computed, watch } from 'vue'
import { uiLanguage } from '../settings'
import ru from './locales/ru'
import en from './locales/en'

/** Supported interface languages (the catalog directories in locales/). */
export type AppLocale = 'ru' | 'en'

/**
 * App-wide localization (RU/EN). The Russian catalog is the source of truth
 * and the fallback: keys without a translation render the Russian text, so
 * untranslated parts of the app keep working. The locale follows the
 * interface-language setting (see settings.ts: uiLanguage).
 */
export const i18n = createI18n({
  legacy: false,
  locale: uiLanguage.value === 'auto' ? detectBrowserLanguage() : uiLanguage.value,
  fallbackLocale: 'ru',
  messages: { ru, en },
})

/** Best-effort browser detection for the "auto" mode (en → English, else Russian). */
export function detectBrowserLanguage(): AppLocale {
  try {
    return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'ru'
  } catch {
    return 'ru'
  }
}

/**
 * Reactive locale, narrowed to the supported set. Use it inside computed /
 * watchEffect and in module-level label maps that must re-evaluate on a
 * language switch; plain `t()` calls in templates already track the locale.
 */
export const appLocale = computed<AppLocale>(() => (i18n.global.locale.value === 'en' ? 'en' : 'ru'))

/** The locale the UI is rendered in right now (non-reactive snapshot). */
export function currentLocale(): AppLocale {
  return appLocale.value
}

/** Global translator: `t('header.profile')` etc. (composition-mode global). */
export const t = i18n.global.t

/**
 * Switches the active locale (used by the settings watcher and by the tests)
 * and keeps the document metadata in sync: the html lang attribute for
 * accessibility and the window title (the static <title> in index.html is only
 * the pre-paint fallback).
 */
export function setAppLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  try {
    document.documentElement.lang = locale
    document.title = t('app.title')
  } catch {
    // non-browser environment (tests)
  }
}

watch(uiLanguage, (v) => setAppLocale(v === 'auto' ? detectBrowserLanguage() : v), { immediate: true })
