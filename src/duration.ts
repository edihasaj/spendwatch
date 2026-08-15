// Round up to the next minute, switch to days at 24 hours, and keep at most
// two useful units.
export function compactDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 1) return "now";

  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours > 0) return `${days}d ${hours}h`;
    if (minutes > 0) return `${days}d ${minutes}m`;
    return `${days}d`;
  }
  if (hours > 0) {
    if (minutes > 0) return `${hours}h ${minutes}m`;
    return `${hours}h`;
  }
  return `${totalMinutes}m`;
}
