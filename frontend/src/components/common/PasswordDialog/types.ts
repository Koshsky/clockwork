export interface PasswordDialogProps {
  /** Dialog visibility */
  open: boolean
  /** Password to display and copy (when present) */
  password: string
  /** Heading, e.g. "User created" or "New password" */
  caption: string
  /** Notice shown instead of the password when the API does not expose one */
  notice?: string
}