// Prints the tracking ID to create in Associates Central for every pick in the catalog
// (Account Settings > Manage Tracking IDs > Add Tracking ID), one per line. After creating
// them, paste the created names into TRACKING_TAGS in worker/amazon-picks/wrangler.toml and
// redeploy; picks whose ID is listed start linking with it.
import { CATALOG, trackingTag } from '../worker/amazon-picks/src/catalog.js';
const seen = new Set();
for (const p of CATALOG) {
  const t = trackingTag(p);
  if (seen.has(t)) throw new Error('duplicate tracking id ' + t + ' for ' + p.id);
  seen.add(t);
  console.log(t.padEnd(20), p.title);
}
