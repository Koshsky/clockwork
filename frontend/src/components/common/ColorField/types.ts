export type ColorFieldSize = 'sm' | 'md'

export interface ColorFieldProps {
  disabled?: boolean
  /** Current color — #RRGGBB or '' (no custom color → standard color) */
  modelValue: string
  /** Optional heading/label of the field (shown in the tooltip and aria) */
  label?: string
  /** Trigger circle and swatch size: sm — inline rows, md — modal forms */
  size?: ColorFieldSize
}