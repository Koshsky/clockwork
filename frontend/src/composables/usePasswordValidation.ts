import { computed, type Ref } from 'vue'
import { t } from '../i18n'

/**
 * A single password validation rule. Extended by adding a rule to passwordRules.
 * The rule text is either a catalog key (`labelKey` — resolved at render time,
 * so the list follows the interface language) or a ready-made string (`label`,
 * for custom rules and stories).
 */
export interface PasswordRule {
  id: string
  /** Catalog key of the rule text (preferred). */
  labelKey?: string
  /** Ready-made rule text (custom rules without a catalog entry). */
  label?: string
  /** Password check; true — rule satisfied */
  test: (value: string) => boolean
}

/** NIST-lean password rules: length 8..64 (code points, so emoji count once),
 *  at least one letter and one digit; all other characters are allowed
 *  (spaces, Cyrillic, emoji, repeats). No upper/lower/special requirements.
 *  Built per call: the labels are catalog keys, and nothing is snapshotted at
 *  module scope (a module-level t() would freeze the language). */
function defaultRules(): PasswordRule[] {
  return [
    {
      id: 'length',
      labelKey: 'ui.password.minLength',
      test: (v) => {
        const n = [...v].length
        return n >= 8 && n <= 64
      },
    },
    { id: 'letter', labelKey: 'ui.password.letter', test: (v) => /\p{L}/u.test(v) },
    { id: 'digit', labelKey: 'ui.password.digit', test: (v) => /\p{N}/u.test(v) },
  ]
}

/** Password rule set (default: length 8-64, a letter and a digit). */
export function passwordRules(custom?: PasswordRule[]): PasswordRule[] {
  return custom && custom.length ? custom : defaultRules()
}

/** Rule text in the active language (a catalog key wins over a literal). */
export function passwordRuleText(rule: PasswordRule): string {
  return rule.labelKey ? t(rule.labelKey) : (rule.label ?? rule.id)
}

/** Validate a password against a rule set. */
export function validatePassword(value: string, rules: PasswordRule[]): boolean {
  return rules.every((r) => r.test(value))
}

/** Password check with a reactive list of satisfied rules. */
export function usePasswordValidation(value: Ref<string>, rules?: Ref<PasswordRule[]> | PasswordRule[]) {
  const list = computed(() => {
    const items = rules === undefined ? defaultRules() : Array.isArray(rules) ? rules : rules.value
    const password = value.value
    return items.map((r) => ({ rule: r, ok: r.test(password) }))
  })

  const valid = computed(() => list.value.every((i) => i.ok))

  return { list, valid }
}
