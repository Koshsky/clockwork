export interface ConfirmDialogProps {
  /** Dialog visibility */
  open: boolean
  /** Dialog title */
  title?: string
  /** Confirmation text (what exactly is being deleted) */
  message: string
  /** Confirmation button text; defaults to "Delete" */
  confirmLabel?: string
  /** Dangerous action: confirmation button is red; defaults to true */
  danger?: boolean
}
