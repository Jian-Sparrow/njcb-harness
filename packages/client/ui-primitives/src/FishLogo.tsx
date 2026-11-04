import { logoUrl } from './logo-url.ts'
import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH} (width and height in user units). */
export const FISH_LOGO_VIEWBOX = { width: 24, height: 24 }

/** The fish silhouette path data, exported for consumers that compose their own svg (entrance effects, masks) around the same geometry. */
export const FISH_LOGO_PATH = 'M3 5Q3 4 4 4H7.3L15.6 10.4V5Q15.6 4 16.6 4H20Q21 4 21 5V16.6C13 16.1 11 10.8 3 9ZM3 10.4C5 14 13 14.7 16 16.6Q18.4 17.7 20.6 17.9Q21 18 21 19V20Q21 21 20 21H15.4L8.1 15.3V20Q8.1 21 7.1 21H4Q3 21 3 20Z'

/**
 * Render the fish logo.
 * @param props.size - width in px (default 24; height keeps the 23.16:17.04 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <image href={logoUrl} width={24} height={24} />
    </svg>
  )
}
