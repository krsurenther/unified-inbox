import type { IconName } from './Icon';

/**
 * Turn a raw message body / media descriptor into a human label for previews and
 * bubbles. Marketplace channels send opaque codes like "[10007]" (a sticker) and
 * placeholders like "[image]"/"[interactive]" that mean nothing to an operator.
 */
export interface MediaLabel {
  icon: IconName;
  label: string;
}

// Known Shopee/TikTok/Lazada system codes → friendly labels. Extend as we learn more.
const CODE_LABELS: Record<string, MediaLabel> = {
  '10007': { icon: 'tag', label: 'Sticker' },
  '10015': { icon: 'image', label: 'Photo' },
  '10006': { icon: 'image', label: 'Photo' },
  '3': { icon: 'image', label: 'Photo' },
};

const PLACEHOLDER_LABELS: Record<string, MediaLabel> = {
  image: { icon: 'image', label: 'Photo' },
  video: { icon: 'image', label: 'Video' },
  voice: { icon: 'phone', label: 'Voice message' },
  audio: { icon: 'phone', label: 'Voice message' },
  sticker: { icon: 'tag', label: 'Sticker' },
  interactive: { icon: 'box', label: 'Card' },
  file: { icon: 'clip', label: 'File' },
  document: { icon: 'clip', label: 'File' },
};

/** A label when the body is *only* a code/placeholder, else null (show the text as-is). */
export function mediaLabel(body: string, mediaKind?: string): MediaLabel | null {
  const t = body.trim();
  const code = /^\[(\d+)\]$/.exec(t);
  if (code && CODE_LABELS[code[1]!]) return CODE_LABELS[code[1]!]!;
  const ph = /^[^\w]*\[([a-z ]+)\][^\w]*$/i.exec(t); // "[image]", "🖼️ [image]"
  if (ph) {
    const key = ph[1]!.trim().toLowerCase();
    if (PLACEHOLDER_LABELS[key]) return PLACEHOLDER_LABELS[key]!;
  }
  if (!t && mediaKind && PLACEHOLDER_LABELS[mediaKind]) return PLACEHOLDER_LABELS[mediaKind]!;
  return null;
}
