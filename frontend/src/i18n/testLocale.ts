/**
 * Pins the unit-test locale to Russian — the product default and the language
 * the catalogs are authored in. Node ships a `navigator.language` of "en-US",
 * so the "auto" interface-language setting would otherwise switch the whole
 * unit suite to English and break assertions written against the Russian
 * source of truth. Tests that exercise the switch call setAppLocale directly.
 */
import { setAppLocale } from './index'

setAppLocale('ru')
