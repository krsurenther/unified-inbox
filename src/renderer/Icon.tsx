// Inline line-icon set for UI chrome. Emoji stay in chat content only.
// Each entry is the inner markup of a 16×16 stroke icon.
import type { ReactElement } from 'react';

export type IconName =
  | 'search' | 'inbox' | 'list' | 'check' | 'phone' | 'bag' | 'globe' | 'gear'
  | 'chevron-left' | 'chevron-down' | 'sparkle' | 'send' | 'refresh' | 'user'
  | 'user-plus' | 'clip' | 'tag' | 'image' | 'box' | 'mute' | 'lock' | 'info' | 'x';

const PATHS: Record<IconName, ReactElement> = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  inbox: <><path d="M2 3.5h12v9H2z" /><path d="M2 9h3.2l1.3 2h3l1.3-2H14" /></>,
  list: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />,
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  phone: <path d="M3.5 2.5h2.6l1.2 3.2-1.7 1.3a9 9 0 0 0 3.4 3.4l1.3-1.7 3.2 1.2v2.6c0 .6-.5 1-1 1C7.4 13.3 2.7 8.6 2.5 3.5c0-.5.4-1 1-1z" />,
  bag: <><path d="M3.5 5.5h9l-.7 8h-7.6z" /><path d="M5.8 5.5V4.4a2.2 2.2 0 0 1 4.4 0v1.1" /></>,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c-3.5 3.5-3.5 7.5 0 11M8 2.5c3.5 3.5 3.5 7.5 0 11" /></>,
  gear: <><circle cx="8" cy="8" r="2.2" /><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4" /></>,
  'chevron-left': <path d="M9.5 3.5 5 8l4.5 4.5" />,
  'chevron-down': <path d="M4 6.5 8 10.5 12 6.5" />,
  sparkle: <path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6z" fill="currentColor" stroke="none" />,
  send: <><path d="M2 8 14 2.5 10.5 14 8.2 9.3z" /><path d="M8.2 9.3 14 2.5" /></>,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.8h-2.8" />,
  user: <><circle cx="8" cy="5.4" r="2.6" /><path d="M2.8 13.5a5.3 5.3 0 0 1 10.4 0" /></>,
  'user-plus': <><circle cx="6.5" cy="5.4" r="2.4" /><path d="M2 13a4.8 4.8 0 0 1 9 0M12.5 5.5v4M10.5 7.5h4" /></>,
  clip: <path d="M11.5 6.5 7 11a2.3 2.3 0 0 1-3.3-3.3l5-5a1.6 1.6 0 0 1 2.3 2.3L6.4 9.6" />,
  tag: <><path d="M2.5 7.5v-5h5l6 6-5 5z" /><circle cx="5.4" cy="5.4" r=".9" fill="currentColor" stroke="none" /></>,
  image: <><path d="M2.5 3h11v10h-11z" /><circle cx="5.6" cy="6" r="1.1" /><path d="M3.5 11.5 7 8l3 3 1.5-1.5 2 2" /></>,
  box: <><path d="M8 2 14 5v6L8 14 2 11V5z" /><path d="M2 5l6 3 6-3M8 8v6" /></>,
  mute: <><path d="M8 3a3 3 0 0 1 3 3v2.5l1.5 2H3.5L5 8.5V6a3 3 0 0 1 3-3zM6.7 12.5a1.4 1.4 0 0 0 2.6 0" /><path d="M2.5 2.5l11 11" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></>,
  info: <><circle cx="8" cy="8" r="5.5" /><path d="M8 7.2v3.4M8 5.2v.1" /></>,
  x: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
};

export function Icon({ name, size = 15, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
