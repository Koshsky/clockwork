export interface ModalFieldOption {
  value: number | string
  label: string
}

export interface ModalField {
  /** Field key — name in the payload when saving (save(values)) */
  key: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'number' | 'date' | 'color' | 'display'
  /** Initial value (applied when opened) */
  value?: number | string
  /** Options for type: 'select' */
  options?: ModalFieldOption[]
  required?: boolean
  placeholder?: string
  /** Render the input read-only (display of a computed value). */
  readonly?: boolean
  /** For type 'display': a getter recomputing the shown text from the form's
   *  current values (reactive — e.g. a duration derived from edited dates). */
  displayValue?: (values: Record<string, string | number>) => string
}

export interface ModalFormProps {
  /** Modal visibility */
  open: boolean
  /** Dialog title */
  title: string
  /** Description of form fields; not needed if the default slot is used */
  fields?: ModalField[]
  /** Confirmation button text; defaults to "Save" */
  submitLabel?: string
  /** Saving in progress: the button is disabled and a spinner is shown */
  busy?: boolean
  /** Local validation error shown inside the modal (client-side only —
   *  server mutation errors go to the toast stack, never here) */
  error?: string | null
  /** Modal max width; default 420px (CSS), e.g. '960px' for wide editors */
  maxWidth?: string
  dialogClass?: string
  closeDisabled?: boolean
}
