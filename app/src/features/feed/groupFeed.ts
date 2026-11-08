/**
 * Display grouping for the feed: results → days → instances, plus the plain-words money summary
 * for each instance. Only arithmetic the database already did (pool = pledge × missed + carry) is
 * repeated here, for the sentence; the per-winner split is the server's rule and is never
 * recomputed on the client.
 */
import type { FeedItem } from '../../api/queries';
import type { PactInstanceRow, PactRow, ProfileRow, ResultStatus } from '../../api/types';
import { formatCents } from '../../lib/money';
import { formatDateInZone, formatTimeInZone } from '../../lib/time';

export interface InstanceGroup {
  key: string;
  instance: PactInstanceRow;
  pact: PactRow;
  /** you first, then by name */
  items: FeedItem[];
  counts: Record<ResultStatus, number>;
  /** pledge × missed + carry-in, in cents; 0 when nothing moved */
  poolCents: number;
  carryInCents: number;
}

export interface DaySection {
  /** the pact-local date, 'YYYY-MM-DD' */
  key: string;
  title: string;
  data: InstanceGroup[];
}

export interface Namer {
  userId: string;
  profiles: Map<string, ProfileRow>;
}

const EMPTY_COUNTS = (): Record<ResultStatus, number> => ({
  pending: 0,
  success: 0,
  failed: 0,
  unverified: 0,
  frozen: 0,
  void: 0,
  excluded: 0,
});

export function nameOf(n: Namer, id: string, capital = true): string {
  if (id === n.userId) return capital ? 'You' : 'you';
  return n.profiles.get(id)?.display_name ?? 'Someone';
}

/** First name for short lists ("Maya, Priya and you"). */
export function shortName(n: Namer, id: string): string {
  if (id === n.userId) return 'you';
  const full = n.profiles.get(id)?.display_name ?? 'Someone';
  return full.split(/\s+/)[0] ?? full;
}

export function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Groups feed items by local date (newest first), then by instance (latest deadline first). */
export function groupFeedByDay(items: readonly FeedItem[], n: Namer): DaySection[] {
  const byInstance = new Map<string, InstanceGroup>();
  for (const item of items) {
    const key = item.instance.id;
    let g = byInstance.get(key);
    if (!g) {
      g = {
        key,
        instance: item.instance,
        pact: item.pact,
        items: [],
        counts: EMPTY_COUNTS(),
        poolCents: 0,
        carryInCents: item.instance.carry_in_cents ?? 0,
      };
      byInstance.set(key, g);
    }
    g.items.push(item);
    g.counts[item.result.status] += 1;
  }
  const days = new Map<string, DaySection>();
  for (const g of byInstance.values()) {
    g.items.sort((a, b) => {
      if (a.result.user_id === n.userId) return -1;
      if (b.result.user_id === n.userId) return 1;
      return nameOf(n, a.result.user_id).localeCompare(nameOf(n, b.result.user_id));
    });
    const missed = g.counts.failed;
    const moved = g.instance.status !== 'voided' && (missed > 0 || g.carryInCents > 0);
    g.poolCents = moved ? g.pact.stake_cents * missed + g.carryInCents : 0;
    const dayKey = g.instance.local_date;
    let day = days.get(dayKey);
    if (!day) {
      day = { key: dayKey, title: formatDateInZone(g.instance.deadline_at, g.pact.tz), data: [] };
      days.set(dayKey, day);
    }
    day.data.push(g);
  }
  const out = [...days.values()];
  for (const d of out) d.data.sort((a, b) => Date.parse(b.instance.deadline_at) - Date.parse(a.instance.deadline_at));
  return out.sort((a, b) => b.key.localeCompare(a.key));
}

/** "9:00 AM · $5.00 pledge" */
export function instanceSubtitle(g: InstanceGroup): string {
  return `${formatTimeInZone(g.instance.deadline_at, g.pact.tz)} · ${formatCents(g.pact.stake_cents)} pledge`;
}

function namesWith(g: InstanceGroup, n: Namer, status: ResultStatus): string[] {
  return g.items.filter((i) => i.result.status === status).map((i) => shortName(n, i.result.user_id));
}

/**
 * "3 showed up · Diego missed · Pool $5.00 to Maya, Priya and you." One sentence per instance,
 * in pledge / pool words. States that move no money say so.
 */
export function instanceSummary(g: InstanceGroup, n: Namer): string {
  if (g.instance.status === 'voided' || (g.counts.void > 0 && g.counts.success + g.counts.failed === 0)) {
    return "Didn't count: fewer than two people were in it. No money moved.";
  }
  const parts: string[] = [];
  if (g.counts.success > 0) parts.push(`${g.counts.success} showed up`);
  const missed = namesWith(g, n, 'failed');
  if (missed.length) parts.push(`${capitalize(joinNames(missed))} missed`);
  const unverified = namesWith(g, n, 'unverified');
  if (unverified.length) parts.push(`${capitalize(joinNames(unverified))} unverified`);
  const frozen = namesWith(g, n, 'frozen');
  if (frozen.length) parts.push(`${capitalize(joinNames(frozen))} frozen`);
  const excluded = namesWith(g, n, 'excluded');
  if (excluded.length) parts.push(`${capitalize(joinNames(excluded))} excluded`);

  let money: string;
  if (g.poolCents === 0) {
    const everyone = g.counts.success > 0 && g.counts.success === g.items.length;
    money = everyone ? 'Everyone showed up. No money moved.' : 'No money moved.';
  } else if (g.counts.success > 0) {
    const winners = g.items.filter((i) => i.result.status === 'success').map((i) => shortName(n, i.result.user_id));
    money = `Pool ${formatCents(g.poolCents)} to ${joinNames(winners)}.`;
  } else {
    money = `Nobody showed up, so the ${formatCents(g.poolCents)} pool carries over to the next day someone does.`;
  }
  return parts.length ? `${parts.join(' · ')}. ${money}` : money;
}

/** Shown only when the pool included money carried in from earlier days. */
export function carryNote(g: InstanceGroup): string | null {
  if (g.carryInCents <= 0) return null;
  return `Includes ${formatCents(g.carryInCents)} carried over from days nobody made it.`;
}

/** Row subtitle for one person's result: what it meant for their pledge. */
export function personDetail(item: FeedItem, g: InstanceGroup): string | undefined {
  switch (item.result.status) {
    case 'failed':
      return `Forfeited ${formatCents(g.pact.stake_cents)} to the pool`;
    case 'success': {
      const at = item.result.first_success_at ? `Counted at ${formatTimeInZone(item.result.first_success_at, g.pact.tz)}` : null;
      const share = g.poolCents > 0 ? 'shares the pool' : null;
      const text = [at, share].filter(Boolean).join(' · ');
      return text ? capitalize(text) : undefined;
    }
    case 'unverified':
    case 'frozen':
    case 'void':
    case 'excluded':
      return 'No money moved';
    default:
      return undefined;
  }
}

const capitalize = (s: string): string => (s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Excluded this month: Diego 1, Priya 1." or null when nobody was. */
export function excludedFootnote(excluded: Map<string, number>, n: Namer): string | null {
  if (excluded.size === 0) return null;
  const parts = [...excluded.entries()]
    .sort((a, b) => b[1] - a[1] || nameOf(n, a[0]).localeCompare(nameOf(n, b[0])))
    .map(([id, count]) => `${nameOf(n, id)} ${count}`);
  return `Excluded this month: ${parts.join(', ')}. An appeal nobody votes on excludes the day for that person.`;
}
