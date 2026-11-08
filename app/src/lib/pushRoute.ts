/**
 * Where a notification payload leads. Pure (no Expo imports) so it can be unit-tested.
 *
 * The server sends `url` (F1); older payloads fall back to their kind: results and reviews live in
 * the feed, settle-up in the ledger, place events on the pact, everything else about an instance on
 * the check-in screen, and a group-only payload on the group home (A3).
 */
export function routeFromData(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (typeof data.url === 'string' && data.url.startsWith('/')) return data.url;
  const kind = typeof data.kind === 'string' ? data.kind : '';
  const groupId = typeof data.group_id === 'string' ? data.group_id : null;
  if (kind === 'place_changed' && typeof data.pact_id === 'string') return `/pacts/${data.pact_id}`;
  if (groupId && (kind === 'result' || kind === 'review_opened' || kind === 'review_closed')) return `/groups/${groupId}/feed`;
  if (groupId && kind === 'settlement') return `/groups/${groupId}/ledger`;
  if (typeof data.instance_id === 'string') return `/checkin/${data.instance_id}`;
  if (groupId) return `/groups/${groupId}`;
  return null;
}
