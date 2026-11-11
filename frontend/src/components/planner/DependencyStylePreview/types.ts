import type { LinkStyle } from '../linkStyle'

export interface DependencyStylePreviewProps {
  /** Style to draw; the settings screen passes the live `viewSettings.connector`. */
  connector?: LinkStyle
}
