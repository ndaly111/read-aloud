// The pool of picks the homepage strip rotates through. Edit this file to add, drop or
// reword a pick; redeploy the Worker and the strip follows.
//
// Each pick is one of:
//   kind 'asin'   - a specific product; the Creators API fills in title/image/price when the
//                   account is eligible, otherwise the card shows our own words only.
//   kind 'search' - an Amazon search for a product type (no ASIN to go stale).
//   kind 'bounty' - a program signup (Audible etc.) paid as a flat bounty.
//
// Rules for the words (Amazon Associates operating agreement):
//   - hook/title are OUR words. Never paste Amazon review text, star ratings or
//     "best seller" claims, and never state a price here - prices come only from the API.
//   - Every claim must be plainly true of the product type.
export const PICKS = [
  { id: 'echo-dot', kind: 'asin', asin: 'B09B8V1LZ3',
    title: 'Echo Dot', hook: 'A little speaker that reads the news, the weather and your audiobooks back to you.' },
  { id: 'audible', kind: 'bounty', url: 'https://www.amazon.com/dp/B00NB86OYE',
    title: 'Audible free trial', hook: 'Like having text read to you? Try a professionally narrated audiobook, free for the trial.' },
  { id: 'kindle-paperwhite', kind: 'search', query: 'Kindle Paperwhite',
    title: 'Kindle Paperwhite', hook: 'Glare-free reading in full sun, and weeks of battery on one charge.' },
  { id: 'airtag', kind: 'asin', asin: 'B0933BVK6T',
    title: 'AirTag 4-pack', hook: 'Never hunt for your keys, wallet or luggage again.' },
  { id: 'pocket-printer', kind: 'search', query: 'mini pocket thermal printer',
    title: 'Pocket thermal printer', hook: 'A printer the size of a deck of cards. No ink, ever.' },
  { id: 'bird-feeder-cam', kind: 'search', query: 'smart bird feeder with camera',
    title: 'Smart bird feeder', hook: 'A bird feeder that sends you a photo of every visitor.' },
  { id: 'sunrise-clock', kind: 'search', query: 'sunrise alarm clock',
    title: 'Sunrise alarm clock', hook: 'Wake up to a slow fake sunrise instead of a buzzer.' },
  { id: 'bone-conduction', kind: 'search', query: 'bone conduction headphones',
    title: 'Bone conduction headphones', hook: 'Headphones that leave your ears open to the room.' },
  { id: 'neck-light', kind: 'search', query: 'neck reading light',
    title: 'Neck reading light', hook: 'A reading lamp you wear around your neck, hands free.' },
  { id: 'spin-scrubber', kind: 'search', query: 'electric spin scrubber',
    title: 'Electric spin scrubber', hook: 'A power tool for the bathtub.' },
  { id: 'mini-projector', kind: 'search', query: 'mini projector',
    title: 'Mini projector', hook: 'A movie on the wall, from a box the size of a lunchbox.' },
  { id: 'hand-warmer', kind: 'search', query: 'rechargeable hand warmer',
    title: 'Rechargeable hand warmer', hook: 'A pocket heater for cold-morning walks.' }
];

// How many picks the strip shows at once.
export const PER_HOUR = 3;

// The UTC hour index (hours since the epoch) for a millisecond timestamp.
export const hourIndex = ms => Math.floor(ms / 3600000);

// Everyone sees the same picks during a UTC hour (so exposure and clicks line up by time,
// like the donation experiment). Consecutive hours walk through the pool three at a time,
// and each UTC day shifts the start by one so the same picks do not always share a card row.
export function scheduledPicks(ms) {
  const hour = hourIndex(ms);
  const start = (hour * PER_HOUR + Math.floor(hour / 24)) % PICKS.length;
  const out = [];
  for (let i = 0; i < PER_HOUR; i++) out.push(PICKS[(start + i) % PICKS.length]);
  return out;
}

export function pickUrl(pick, tag) {
  const t = encodeURIComponent(tag);
  if (pick.kind === 'asin') return 'https://www.amazon.com/dp/' + pick.asin + '?tag=' + t;
  if (pick.kind === 'search') return 'https://www.amazon.com/s?k=' + encodeURIComponent(pick.query) + '&tag=' + t;
  return pick.url + (pick.url.includes('?') ? '&' : '?') + 'tag=' + t;
}
