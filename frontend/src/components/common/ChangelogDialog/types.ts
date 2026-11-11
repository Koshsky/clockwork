export interface ChangelogDialogProps {
  /** Whether the dialog is visible */
  open: boolean
}

export interface ChangelogDialogEmits {
  /** Requested to close the dialog (✕ / Esc / backdrop click) */
  close: []
}