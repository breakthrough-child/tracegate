export interface Order {
  order_id: string;
  item: string;
  status: 'processing' | 'shipped' | 'delivered' | 'delayed';
  amount: number;
  eta: string;
}
const items = [
  'desk lamp',
  'headphones',
  'yoga mat',
  'coffee grinder',
  'backpack',
  'keyboard',
  'water bottle',
  'monitor stand',
  'phone case',
  'blender',
];
const statuses: Order['status'][] = ['processing', 'shipped', 'delivered', 'delayed'];
/** 30 deterministic orders: ORD-1001 .. ORD-1030 */
export const ORDERS: Order[] = Array.from({ length: 30 }, (_, i) => ({
  order_id: `ORD-${1001 + i}`,
  item: items[i % items.length],
  status: statuses[i % 4],
  amount: [19, 35, 48, 120, 22, 150, 15, 44, 29, 210][i % 10],
  eta: `2025-0${1 + (i % 9)}-1${i % 9}`,
}));

export interface Doc {
  id: string;
  text: string;
}
export const KB: Doc[] = [
  { id: 'kb-returns', text: 'Items can be returned within 30 days of delivery for a full refund if unused and in original packaging.' },
  { id: 'kb-shipping', text: 'Standard shipping takes 3 to 5 business days. Express shipping takes 1 to 2 business days.' },
  { id: 'kb-warranty', text: 'All electronics carry a one year limited warranty covering manufacturing defects.' },
  { id: 'kb-payment', text: 'We accept credit cards, debit cards and bank transfer. Payment is taken when the order ships.' },
  { id: 'kb-privacy', text: 'We never share personal data with third parties and delete account data on request within 14 days.' },
  { id: 'kb-cancel', text: 'Orders can be cancelled free of charge until they have shipped.' },
  { id: 'kb-gift', text: 'Gift cards never expire and can be used on any product in the store.' },
  { id: 'kb-contact', text: 'Support is available Monday to Friday, 9am to 5pm, by chat or email.' },
];

const stem = (t: string): string => t.replace(/(ing|ed|s)$/, '');
export const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem);
export function searchKb(query: string, k = 3): (Doc & { score: number })[] {
  const q = new Set(tokens(query).filter((t) => t.length > 3));
  return KB.map((d) => ({ ...d, score: tokens(d.text + ' ' + d.id).filter((t) => q.has(t)).length }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}
