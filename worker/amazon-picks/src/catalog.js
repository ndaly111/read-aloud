// The full pool of picks. ACTIVE_SIZE of them are "active" (shown in the hourly rotation);
// the rest sit on the bench. Once a week the Worker benches active picks nobody clicks and
// promotes the bench picks that have waited longest (see rotatePool in index.js). Add new
// candidates at the END of this list; they join the bench and get their turn in order.
//
// Each pick is one of:
//   kind 'asin'   - a specific product; the Creators API fills in title/image/price when the
//                   account is eligible, otherwise the card shows our own words only.
//   kind 'search' - an Amazon search for a product type (no ASIN to go stale).
//   kind 'bounty' - a program signup (Audible etc.) paid as a flat bounty.
// keep: true     - never benched by the weekly rotation (the Audible bounty is the fastest
//                   route to the 10-sales bar that unlocks product photos).
//
// Rules for the words (Amazon Associates operating agreement):
//   - hook/title are OUR words. Never paste Amazon review text, star ratings or
//     "best seller" claims, and never state a price here - prices come only from the API.
//   - Every claim must be plainly true of the product type.
// photos: N     - how many stock photos exist for the pick (/picks/<id>-1.jpg ... <id>-N.jpg);
//                  the Worker rotates them by the hour and counts clicks per photo. Default 1.
export const CATALOG = [
  { id: 'echo-dot', photos: 3, kind: 'asin', asin: 'B09B8V1LZ3',
    title: 'Echo Dot', hook: 'A little speaker that reads the news, the weather and your audiobooks back to you.' },
  // Link is the landing page listed for the Audible bounty on Nick's rate card (11/07).
  // featuredUntil: Amazon pays $20 per Audible Standard sign-up until 12/15, so the card is in
  // every hour's set until the end of 12/15 Eastern, then returns to the normal rotation.
  { id: 'audible', photos: 3, kind: 'bounty', url: 'https://www.amazon.com/hz/audible/mlp', keep: true,
    featuredUntil: '2026-12-16T05:00:00Z',
    title: 'Audible', hook: 'Like having text read to you? Try audiobooks read by professional narrators.' },
  { id: 'kindle-paperwhite', photos: 3, kind: 'search', query: 'Kindle Paperwhite',
    title: 'Kindle Paperwhite', hook: 'Glare-free reading in full sun, and weeks of battery on one charge.' },
  { id: 'airtag', photos: 2, kind: 'search', query: 'Apple AirTag 4 pack',
    title: 'AirTag 4-pack', hook: 'Never hunt for your keys, wallet or luggage again.' },
  { id: 'pocket-printer', photos: 2, kind: 'search', query: 'mini pocket thermal printer',
    title: 'Pocket thermal printer', hook: 'A printer the size of a deck of cards. No ink, ever.' },
  { id: 'bird-feeder-cam', photos: 3, kind: 'search', query: 'smart bird feeder with camera',
    title: 'Smart bird feeder', hook: 'A bird feeder that sends you a photo of every visitor.' },
  { id: 'sunrise-clock', photos: 2, kind: 'search', query: 'sunrise alarm clock',
    title: 'Sunrise alarm clock', hook: 'Wake up to a slow fake sunrise instead of a buzzer.' },
  { id: 'wireless-headphones', photos: 2, kind: 'search', query: 'wireless over-ear headphones',
    title: 'Wireless headphones', hook: 'Big, soft, wireless headphones for long listens.' },
  { id: 'neck-light', photos: 3, kind: 'asin', asin: 'B07WNRN9WQ', // Glocusent bendable neck light, checked 11/07
    title: 'Neck reading light', hook: 'A reading lamp you wear around your neck, hands free.' },
  { id: 'spin-scrubber', photos: 2, kind: 'search', query: 'electric spin scrubber',
    title: 'Electric spin scrubber', hook: 'A power tool for the bathtub.' },
  { id: 'mini-projector', photos: 3, kind: 'search', query: 'mini projector',
    title: 'Mini projector', hook: 'A movie on the wall, from a box the size of a lunchbox.' },
  { id: 'hand-warmer', photos: 2, kind: 'search', query: 'rechargeable hand warmer',
    title: 'Rechargeable hand warmer', hook: 'A pocket heater for cold-morning walks.' },
  // ---- bench, in the order they will be promoted ----
  { id: 'moon-lamp', kind: 'search', query: 'levitating moon lamp',
    title: 'Levitating moon lamp', hook: 'A little moon that floats above its base.' },
  { id: 'galaxy-projector', kind: 'search', query: 'galaxy projector',
    title: 'Galaxy projector', hook: 'Turn the ceiling into the night sky.' },
  { id: 'heated-blanket', kind: 'search', query: 'electric heated blanket',
    title: 'Heated blanket', hook: 'A blanket that warms the bed before you get in.' },
  { id: 'instant-camera', kind: 'search', query: 'instant film camera',
    title: 'Instant camera', hook: 'A camera that prints the photo into your hand.' },
  { id: 'e-ink-tablet', kind: 'search', query: 'e-ink tablet',
    title: 'E-ink writing tablet', hook: 'A tablet that feels like paper and you can write on.' },
  { id: 'pet-camera', kind: 'search', query: 'pet camera treat dispenser',
    title: 'Pet camera', hook: 'A camera that tosses your dog a treat from your phone.' },
  { id: 'standing-desk', kind: 'search', query: 'standing desk',
    title: 'Standing desk', hook: 'Stand up to work with one lift of the desk.' },
  { id: 'light-therapy', kind: 'search', query: 'light therapy lamp',
    title: 'Light therapy lamp', hook: 'A lamp bright enough to fake a summer morning in November.' },
  { id: 'retro-handheld', kind: 'search', query: 'retro handheld game console',
    title: 'Retro handheld console', hook: 'Hundreds of childhood games in your pocket.' },
  { id: 'robot-vacuum', kind: 'search', query: 'robot vacuum',
    title: 'Robot vacuum', hook: 'A vacuum that cleans the floor while you are out.' },
  { id: 'massage-gun', kind: 'search', query: 'massage gun',
    title: 'Massage gun', hook: 'A percussion massager for sore shoulders.' },
  { id: 'smart-plug', kind: 'search', query: 'smart plug',
    title: 'Smart plug', hook: 'Turn any lamp into a voice-controlled lamp.' },
  { id: 'mini-drone', kind: 'search', query: 'mini camera drone',
    title: 'Mini camera drone', hook: 'A camera drone that folds into a jacket pocket.' },
  { id: 'portable-monitor', kind: 'search', query: 'portable monitor',
    title: 'Portable monitor', hook: 'A second screen that slides into a laptop bag.' },
  { id: 'air-fryer', kind: 'search', query: 'air fryer',
    title: 'Air fryer', hook: 'Crisp fries from a countertop box, hardly any oil.' },
  { id: 'weighted-blanket', kind: 'search', query: 'weighted blanket',
    title: 'Weighted blanket', hook: 'A blanket that feels like a hug.' },
  { id: 'milk-frother', kind: 'search', query: 'milk frother',
    title: 'Milk frother', hook: 'Coffee-shop foam from a stick.' },
  { id: 'tracker-wallet', kind: 'search', query: 'wallet with tracker',
    title: 'Tracker wallet', hook: 'A wallet that tells your phone where it is.' },
  { id: 'smart-bulbs', kind: 'search', query: 'smart light bulbs color',
    title: 'Smart bulbs', hook: 'Bulbs you can turn any color from your phone.' },
  { id: 'doorbell-cam', kind: 'search', query: 'video doorbell',
    title: 'Video doorbell', hook: 'See who is at the door from anywhere.' },
  { id: 'nc-earbuds', kind: 'search', query: 'noise cancelling earbuds',
    title: 'Noise-cancelling earbuds', hook: 'Earbuds that switch the world off.' },
  { id: 'mech-keyboard', kind: 'search', query: 'mechanical keyboard',
    title: 'Mechanical keyboard', hook: 'The typewriter feel, back.' },
  { id: 'heated-vest', kind: 'search', query: 'heated vest',
    title: 'Heated vest', hook: 'A vest with a heater in it.' },
  { id: 'insulated-tumbler', kind: 'search', query: 'insulated tumbler with handle',
    title: 'Insulated tumbler', hook: 'The tumbler that keeps ice all day.' }
  // Bounty sign-ups from Nick's rate card (11/07); links are the exact landing pages it lists.
  { id: 'prime-trial', photos: 2, kind: 'bounty', url: 'https://www.amazon.com/prime',
    title: 'Amazon Prime free trial', hook: 'Fast, free delivery on eligible items, plus Prime Video. Try it free.' },
  { id: 'music-unlimited', photos: 2, kind: 'bounty', url: 'https://www.amazon.com/music/unlimited',
    title: 'Amazon Music Unlimited', hook: 'Millions of songs, ad-free. Try it free.' },
];

// How many picks are active (in the hourly rotation) at once, and how many show per hour.
export const ACTIVE_SIZE = 12;
export const PER_HOUR = 3;

// The UTC hour index (hours since the epoch) for a millisecond timestamp.
export const hourIndex = ms => Math.floor(ms / 3600000);

// Everyone sees the same picks during a UTC hour (so exposure and clicks line up by time,
// like the donation experiment). Consecutive hours walk through the active list three at a
// time, and each UTC day shifts the start by one so the same picks do not always share a row.
export function scheduledPicks(ms, active) {
  const hour = hourIndex(ms);
  // Featured picks (featuredUntil still in the future) take the first slots every hour;
  // the rest of the active list rotates through the remaining slots as before.
  const featured = active.filter(p => p.featuredUntil && ms < Date.parse(p.featuredUntil)).slice(0, PER_HOUR);
  const rest = active.filter(p => !featured.includes(p));
  const slots = Math.min(PER_HOUR - featured.length, rest.length);
  const out = [...featured];
  if (!slots) return out;
  const start = (hour * slots + Math.floor(hour / 24)) % rest.length;
  for (let i = 0; i < slots; i++) out.push(rest[(start + i) % rest.length]);
  return out;
}

// Per-pick Amazon tracking ID, so Associates Central reports clicks, orders and earnings per
// pick. Tracking IDs have to be created by hand in Associates Central (Account Settings >
// Manage Tracking IDs) and a link carrying an ID that does not exist earns nothing, so a
// pick uses its own ID only when that ID is listed in the TRACKING_TAGS var; otherwise it
// falls back to the account's main tag. Derived name: "ra" + id without hyphens, cut to 14
// characters, plus "-20". Run `node scripts/amazon_picks_tags.mjs` to print the full list.
export function trackingTag(pick) {
  return 'ra' + pick.id.replace(/-/g, '').slice(0, 14) + '-20';
}
export function tagFor(pick, env) {
  const created = new Set(String(env.TRACKING_TAGS || '').split(/[\s,]+/).filter(Boolean));
  const own = trackingTag(pick);
  return created.has(own) ? own : env.PARTNER_TAG;
}

export function pickUrl(pick, tag) {
  const t = encodeURIComponent(tag);
  if (pick.kind === 'asin') return 'https://www.amazon.com/dp/' + pick.asin + '?tag=' + t;
  if (pick.kind === 'search') return 'https://www.amazon.com/s?k=' + encodeURIComponent(pick.query) + '&tag=' + t;
  return pick.url + (pick.url.includes('?') ? '&' : '?') + 'tag=' + t;
}
