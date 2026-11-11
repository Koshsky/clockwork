export interface ScaleBadgeProps {
  /** Current table scale (zoom on .tg-content, 0.5–2) */
  scale: number
  /** Scale-change counter: each increment shows the badge for a while */
  bump: number
}
