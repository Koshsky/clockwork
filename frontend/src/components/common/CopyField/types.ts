export interface CopyFieldProps {
  /** Value to display and copy */
  value: string
  /** Label above the field */
  label?: string
  /** Monospace font (for passwords/logins) */
  monospace?: boolean
  /** Copy button label/aria */
  copyLabel?: string
}
