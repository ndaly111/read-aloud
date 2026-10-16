// Time-rotated donation appeal schedule. Everyone sees the same appeal during a UTC hour,
// so a payment can be credited to the appeal that was live when it was made (Buy Me a
// Coffee payments carry no referrer). Hours cycle A, B, C and each UTC day starts one step
// later than the day before: every appeal gets exactly 8 hours a day, each hour of the day
// shows each appeal once every 3 days, and each weekday+hour pair once every 21 days -
// so a 42-day test is exactly balanced on time of day and day of week.
// Shared by the Worker and scripts/donation_rotation_report.mjs - change neither alone.
export const ROTATION_EXPERIMENT_ID = 'support_goal_2026_10t';
const ARMS = ['A', 'B', 'C'];

// The UTC hour index (hours since the epoch) for a millisecond timestamp.
export const hourIndex = ms => Math.floor(ms / 3600000);

export function scheduledVariant(ms) {
  const hour = hourIndex(ms);
  return ARMS[(hour % 24 + Math.floor(hour / 24)) % 3];
}
