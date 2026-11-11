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
//   kind 'event'  - an Amazon event page (Black Friday etc.), shown only in its showFrom/showUntil window.
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
  // Link is the Audible Standard homepage Amazon's bounty table lists for the $20 Standard
  // free-trial / monthly bounty (checked 11/11; the old /hz/audible/mlp is the Premium Plus
  // trial homepage, which only redirected here). featuredUntil: Amazon pays $20 per Audible Standard sign-up until 12/15, so the card is in
  // every hour's set until the end of 12/15 Eastern, then returns to the normal rotation.
  { id: 'audible', photos: 3, kind: 'bounty', url: 'https://www.amazon.com/hz/audible/arya/mlp', keep: true,
    featuredUntil: '2026-12-16T05:00:00Z',
    title: 'Audible', hook: 'Like having text read to you? Try audiobooks read by professional narrators.',
    // Amazon's landing page (seen by Nick 11/07): "Get 3 months of Audible Standard ... + $20
    // Audible bonus", offer ends Dec 28, 2026. No dollar figures on our card: prices may only
    // come from Amazon's API. After promoUntil the normal title and hook come back.
    promoUntil: '2026-12-29T05:00:00Z', promoTitle: "Audible's biggest deal of the season",
    promoHook: '3 months of Audible Standard at a steep discount, plus a bonus. Ends Dec 28.',
    // Wording test (Nick 11/07): ten versions of title + description + button, one per UTC hour
    // (see variantFor). A is the control. Every button names Amazon; no dollar figures.
    // testPhoto pins one photo during the test so the photo does not muddy the comparison.
    test: { id: 'audible-cta-2026-11', until: '2026-12-29T05:00:00Z', testPhoto: 1, variants: [
      { id: "A", title: "Audible's biggest deal of the season",
        hook: "3 months of Audible Standard at a steep discount, plus a bonus. Ends Dec 28.", button: "See it on Amazon" },
      { id: "B", title: "Like hearing it read aloud?",
        hook: "Hear whole books read by pro narrators. Audible's holiday deal ends Dec 28.", button: "See the deal on Amazon" },
      { id: "C", title: "Your next book, read to you",
        hook: "3 months of Audible Standard at a steep discount, plus a bonus. Ends Dec 28.", button: "Get the deal on Amazon" },
      { id: "D", title: "Ends Dec 28: Audible's holiday deal",
        hook: "3 months of audiobooks at a steep discount, plus a bonus.", button: "Get it on Amazon" },
      { id: "E", title: "Give your eyes a break",
        hook: "Let a pro narrator read your next book. 3 months of Audible at a steep discount, through Dec 28.", button: "Start listening on Amazon" },
      { id: "F", title: "Turn your commute into reading time",
        hook: "Audible's holiday deal: 3 months at a steep discount, plus a bonus. Ends Dec 28.", button: "See the deal on Amazon" },
      { id: "G", title: "Bestsellers, read to you",
        hook: "Audible Standard's holiday deal: 3 months at a steep discount, plus a bonus. Ends Dec 28.", button: "Browse Audible on Amazon" },
      { id: "H", title: "Listen to more books this winter",
        hook: "3 months of Audible Standard at a steep discount, plus a bonus. Ends Dec 28.", button: "See the deal on Amazon" },
      { id: "I", title: "3 months of Audible, deeply discounted",
        hook: "Plus a bonus. Cancel anytime. Ends Dec 28.", button: "Get the deal on Amazon" },
      { id: "J", title: "Love Read-Aloud? You'll love Audible",
        hook: "Pro narrators, full books, and a holiday deal that ends Dec 28.", button: "See the deal on Amazon" },
    ] } },
  { id: 'kindle-paperwhite', photos: 3, kind: 'search', query: 'Kindle Paperwhite',
    title: 'Kindle Paperwhite', hook: 'Glare-free reading in full sun, and weeks of battery on one charge.' },
  { id: 'airtag', photos: 2, kind: 'asin', asin: 'B0GJTXVN9Z', // Apple AirTag 2nd gen 4-pack, checked 11/09
    title: 'AirTag 4-pack', hook: 'Never hunt for your keys, wallet or luggage again.' },
  { id: 'pocket-printer', photos: 2, kind: 'asin', asin: 'B0CHZ74442', // inkless Bluetooth mini thermal printer, checked 11/09
    title: 'Pocket thermal printer', hook: 'A printer the size of a deck of cards. No ink, ever.' },
  { id: 'bird-feeder-cam', photos: 3, kind: 'asin', asin: 'B0C4Y6D5BD', // solar AI bird-ID feeder cam, checked 11/09
    title: 'Smart bird feeder', hook: 'A bird feeder that sends you a photo of every visitor.' },
  { id: 'sunrise-clock', photos: 2, dropPhotos: [2], // #2 1/948 vs #1 6/1218 (11/11)
    kind: 'asin', asin: 'B081CHLF46', // JALL sunrise alarm clock, checked 11/09
    title: 'Sunrise alarm clock', hook: 'Wake up to a slow fake sunrise instead of a buzzer.' },
  { id: 'wireless-headphones', photos: 2, kind: 'asin', asin: 'B0C3HCD34R', // soundcore Q20i ANC headphones, checked 11/09
    title: 'Wireless headphones', hook: 'Big, soft, wireless headphones for long listens.' },
  { id: 'neck-light', photos: 3, dropPhotos: [3], // #3 2/830 vs #1 6/704, #2 4/744 (11/11)
    kind: 'asin', asin: 'B07WNRN9WQ', // Glocusent bendable neck light, checked 11/07
    title: 'Neck reading light', hook: 'A reading lamp you wear around your neck, hands free.' },
  { id: 'spin-scrubber', photos: 2, dropPhotos: [1], // #1 5/1173 vs #2 10/1098 (11/11)
    kind: 'asin', asin: 'B0B7RSV894', // long-handle spin scrubber, checked 11/09
    title: 'Electric spin scrubber', hook: 'A power tool for the bathtub.' },
  { id: 'mini-projector', photos: 3, kind: 'asin', asin: 'B0F7RR3YC6', // WiFi+Bluetooth mini projector, checked 11/09
    title: 'Mini projector', hook: 'A movie on the wall, from a box the size of a lunchbox.' },
  { id: 'hand-warmer', photos: 2, dropPhotos: [1], // #1 2/1213 vs #2 10/997 (11/11)
    kind: 'asin', asin: 'B0CG65PYBV', // rechargeable hand warmers 2-pack, checked 11/09
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
    title: 'Insulated tumbler', hook: 'The tumbler that keeps ice all day.' },
  // Bounty sign-ups from Nick's rate card (11/07); links are the exact landing pages it lists.
  { id: 'prime-trial', photos: 2, kind: 'bounty', url: 'https://www.amazon.com/prime',
    title: 'Amazon Prime free trial', hook: 'Fast, free delivery on eligible items, plus Prime Video. Try it free.' },
  { id: 'music-unlimited', photos: 2, kind: 'bounty', url: 'https://www.amazon.com/music/unlimited',
    title: 'Amazon Music Unlimited', hook: 'Millions of songs, ad-free. Try it free.' },
  // 11/11: cheaper picks (about $10-25) for the people who use Read-Aloud: students,
  // proofreaders, language learners, readers with dyslexia or low vision, bedtime listeners.
  // Each one is a single listing checked in stock and buyable 11/11 (desktop + phone).
  { id: 'sleep-headband', kind: 'asin', asin: 'B09K4WZGVD', // MUSICOZY Bluetooth sleep headband
    title: 'Sleep headphones headband', hook: 'Thin speakers in a soft headband, made for listening in bed, even on your side.' },
  { id: 'blue-light-glasses', photos: 2, kind: 'asin', asin: 'B07W781XWF', // livho blue light glasses
    title: 'Blue light glasses', hook: 'Glasses with lenses that filter the blue light from screens.' },
  { id: 'earbuds', kind: 'asin', asin: 'B0BTYCRJSS', // soundcore P20i true wireless earbuds
    title: 'Wireless earbuds', hook: 'Small wireless earbuds for listening on a walk, a bus or a train.' },
  { id: 'book-stand', kind: 'asin', asin: 'B07459P7BF', // bamboo book stand with page clips
    title: 'Book stand', hook: 'Holds a book open and upright, so your hands are free.' },
  { id: 'magnifier', kind: 'asin', asin: 'B08XXF1VCS', // JMH lighted handheld magnifier
    title: 'Lighted magnifying glass', hook: 'A big magnifying lens with its own light, for small print.' },
  { id: 'tablet-stand', kind: 'asin', asin: 'B01DBV1OKY', // Lamicall adjustable aluminum stand
    title: 'Tablet stand', hook: 'Props up a tablet or phone at eye level, hands free.' },
  // ---- dated event cards: outside the weekly pool, featured only between showFrom and
  // showUntil (see eventsLive), so each retires by itself when the event ends. Links are
  // Amazon's own event pages (allowed as event links with our own words next to them,
  // Associates Program Policies 2(b), read 11/11). Our words only: no prices, no percentages.
  { id: 'black-friday', kind: 'event', url: 'https://www.amazon.com/blackfriday',
    showFrom: '2026-11-11T05:00:00Z', showUntil: '2026-11-30T08:00:00Z',
    // Until Amazon's Black Friday start (Nov 19, per its own banner 11/11) the card says so.
    promoUntil: '2026-11-19T08:00:00Z', promoTitle: "Amazon's holiday deals",
    promoHook: 'Holiday deals are on now. Black Friday deals start Nov 19.',
    title: 'Black Friday deals on Amazon', hook: "Amazon's Black Friday deals, all on one page." },
  // /cybermonday still showed a 2025 title on 11/11; check it before 11/30 and point this at
  // /blackfriday if Amazon has not updated it.
  { id: 'cyber-monday', kind: 'event', url: 'https://www.amazon.com/cybermonday',
    showFrom: '2026-11-30T08:00:00Z', showUntil: '2026-12-01T08:00:00Z',
    title: 'Cyber Monday deals on Amazon', hook: "Amazon's Cyber Monday deals, all on one page." },
];

// How many picks are active (in the hourly rotation) at once, and how many show per hour.
export const ACTIVE_SIZE = 12;
export const PER_HOUR = 3;

// The UTC hour index (hours since the epoch) for a millisecond timestamp.
export const hourIndex = ms => Math.floor(ms / 3600000);

// Everyone sees the same picks during a UTC hour (so exposure and clicks line up by time,
// like the donation experiment). Consecutive hours walk through the active list three at a
// time, and each UTC day shifts the start by one so the same picks do not always share a row.
// Dated event cards (showFrom/showUntil, e.g. Black Friday): never in the weekly pool; while
// their window is open they are featured, and outside it they are not shown at all, so a
// link to a limited-time event retires by itself when the event ends (Associates policy).
export const isEvent = p => !!p.showFrom;
export const POOL = CATALOG.filter(p => !isEvent(p));
export const eventsLive = ms => CATALOG.filter(p => isEvent(p) && ms >= Date.parse(p.showFrom) && ms < Date.parse(p.showUntil));

export function scheduledPicks(ms, active) {
  const hour = hourIndex(ms);
  // Featured picks (featuredUntil still in the future) and live event cards take the first
  // slots every hour; the rest of the active list rotates through the remaining slots.
  const featured = [...active.filter(p => p.featuredUntil && ms < Date.parse(p.featuredUntil)), ...eventsLive(ms)]
    .slice(0, PER_HOUR);
  const rest = active.filter(p => !featured.includes(p));
  const slots = Math.min(PER_HOUR - featured.length, rest.length);
  const out = [...featured];
  if (!slots) return out;
  const start = (hour * slots + Math.floor(hour / 24)) % rest.length;
  for (let i = 0; i < slots; i++) out.push(rest[(start + i) % rest.length]);
  return out;
}

// Which stock photo (file number, 1-based) a card shows in a given hour. Photos listed in
// dropPhotos are skipped but never renumbered, so every file keeps its own click history.
export function livePhotos(pick) {
  const drop = new Set(pick.dropPhotos || []), out = [];
  for (let k = 1; k <= (pick.photos || 1); k++) if (!drop.has(k)) out.push(k);
  return out.length ? out : [1];
}
export function photoFor(pick, hour, slot) {
  const live = livePhotos(pick);
  return live[(hour + slot) % live.length];
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

// A pick's title and hook right now: its promo wording while the promo runs, else the normal one.
// Daily shift for an n-version rotation, chosen so every hour of the day shows every
// version once every n days (needs (24 + shift) mod n to share no factor with n).
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function dailyShift(n) {
  for (let s = 1; s <= n; s++) if (n === 1 || ((24 + s) % n && gcd((24 + s) % n, n) === 1)) return s;
  return 1;
}

// Wording-test version live in a given hour, or null. One version per UTC hour for everyone,
// drawn from the versions not yet retired (retired = Set of 'pick:version').
export function variantFor(pick, ms, retired = new Set()) {
  const t = pick.test;
  if (!t || !(ms < Date.parse(t.until))) return null;
  const live = t.variants.filter(v => !retired.has(pick.id + ':' + v.id));
  if (!live.length) return null;
  const hour = hourIndex(ms);
  return live[(hour + dailyShift(live.length) * Math.floor(hour / 24)) % live.length];
}

export function wordingFor(pick, ms, retired) {
  const v = variantFor(pick, ms, retired);
  if (v) return { title: v.title, hook: v.hook, button: v.button, variant: v.id };
  const promo = pick.promoUntil && ms < Date.parse(pick.promoUntil);
  return { title: promo ? pick.promoTitle : pick.title, hook: promo ? pick.promoHook : pick.hook };
}

export function pickUrl(pick, tag) {
  const t = encodeURIComponent(tag);
  if (pick.kind === 'asin') return 'https://www.amazon.com/dp/' + pick.asin + '?tag=' + t;
  if (pick.kind === 'search') return 'https://www.amazon.com/s?k=' + encodeURIComponent(pick.query) + '&tag=' + t;
  return pick.url + (pick.url.includes('?') ? '&' : '?') + 'tag=' + t;
}
