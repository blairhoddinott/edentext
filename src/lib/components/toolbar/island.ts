import type { RibbonCommand, Tab } from '../ribbon/commands';

// The island's Tools row shows one category at a time; they carry the ribbon's fixed tab
// names, so the command search says the same "where it lives" under both chromes.
export const CATEGORIES = ['home', 'insert', 'layout', 'references', 'review', 'view'] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(v: unknown): v is Category {
  return (CATEGORIES as readonly unknown[]).includes(v);
}

// Commands the island keeps somewhere other than the ribbon does: the category that
// holds them (null: a floating toolbar) and the control that opens their menu. The
// rest follow the ribbon's tab.
export const ISLAND_PLACE: Record<string, { tab: Category | null; via?: string }> = {
  indentLeft: { tab: 'layout', via: 'paragraphFields' },
  indentRight: { tab: 'layout', via: 'paragraphFields' },
  spaceBefore: { tab: 'layout', via: 'paragraphFields' },
  spaceAfter: { tab: 'layout', via: 'paragraphFields' },
  differentFirstPage: { tab: 'insert', via: 'hfOptions' },
  differentOddEven: { tab: 'insert', via: 'hfOptions' },
  hfTabs: { tab: 'insert', via: 'hfOptions' },
  acceptAll: { tab: 'review', via: 'acceptMenu' },
  rejectAll: { tab: 'review', via: 'rejectMenu' },
  ...Object.fromEntries(['forward', 'backward', 'front', 'back'].map((o) => [`order-${o}`, { tab: null, via: 'orderMenu' }])),
  altText: { tab: null, via: 'altTextMenu' },
};

// The ribbon's Remove menu: the floating table toolbar shows its three entries as buttons.
export const RIBBON_ONLY = new Set(['tableDelete']);

/** The control that opens a command's menu in the island, if it sits in one: a style
 *  in the first row's gallery, an alignment in its menu. */
export function islandVia(cmd: RibbonCommand): string | undefined {
  if (cmd.id in ISLAND_PLACE) return ISLAND_PLACE[cmd.id].via;
  if (cmd.id.startsWith('style-')) return 'styleGallery';
  if (cmd.id.startsWith('align-')) return 'alignMenu';
  if (cmd.id.startsWith('tableDelete-')) return undefined;
  return cmd.via;
}

/** The category a ribbon tab's command lands in; null for a contextual tab, whose
 *  controls ride the floating toolbars instead. */
export function categoryOf(tab: Tab): Category | null {
  return isCategory(tab) ? tab : null;
}

// The island clips its overflow sideways, so a panel near the window's edge would be cut
// off: it slides back inside, keeping 8px to the edge.
export function keepInView(node: HTMLElement) {
  function place() {
    node.style.translate = '';
    const r = node.getBoundingClientRect();
    const over = r.right - (window.innerWidth - 8);
    const shift = over > 0 ? -Math.min(over, Math.max(0, r.left - 8)) : Math.max(0, 8 - r.left);
    if (shift) node.style.translate = `${shift}px 0`;
  }
  place();
  window.addEventListener('resize', place);
  return { destroy() { window.removeEventListener('resize', place); } };
}
