export type CheckinVerdict = "in_fence" | "out_of_fence" | "unjudgeable" | "rejected_simulated";
export type ResultStatus = "pending" | "success" | "failed" | "unverified" | "frozen" | "void" | "excluded";

export const MAX_ACCURACY_M = 200;
const EARTH_RADIUS_M = 6371008.8;

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number | null;
  isSimulated: boolean;
}

export interface Place {
  lat: number;
  lng: number;
  radiusM: number;
}

export function checkinVerdict(fix: Fix, place: Place): { verdict: CheckinVerdict; distanceM: number } {
  const distanceM = distanceMeters(fix.lat, fix.lng, place.lat, place.lng);
  if (fix.isSimulated) return { verdict: "rejected_simulated", distanceM };
  const acc = fix.accuracyM;
  if (acc === null || !Number.isFinite(acc) || acc < 0 || acc > MAX_ACCURACY_M) {
    return { verdict: "unjudgeable", distanceM };
  }
  return { verdict: distanceM - acc <= place.radiusM ? "in_fence" : "out_of_fence", distanceM };
}

export interface CheckinRecord {
  userId: string;
  verdict: CheckinVerdict;
  serverReceivedAt: string;
  clientCapturedAt: string;
}

export interface ParticipantResult {
  userId: string;
  status: ResultStatus;
  firstSuccessAt: string | null;
}

const ms = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid instant: ${iso}`);
  return t;
};

export function computeResults(input: {
  deadlineAt: string;
  participants: { userId: string; frozen: boolean }[];
  checkins: CheckinRecord[];
}): { voided: boolean; results: ParticipantResult[] } {
  const deadline = ms(input.deadlineAt);
  const participants = [...input.participants].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const results: ParticipantResult[] = participants.map(({ userId, frozen }) => {
    if (frozen) return { userId, status: "frozen", firstSuccessAt: null };
    const mine = input.checkins.filter((c) => c.userId === userId);
    const successes = mine
      .filter((c) => c.verdict === "in_fence" && ms(c.serverReceivedAt) <= deadline)
      .sort((a, b) => ms(a.serverReceivedAt) - ms(b.serverReceivedAt));
    const first = successes[0];
    if (first) return { userId, status: "success", firstSuccessAt: first.serverReceivedAt };
    const unverified = mine.some(
      (c) =>
        c.verdict === "unjudgeable" || (ms(c.serverReceivedAt) > deadline && ms(c.clientCapturedAt) <= deadline),
    );
    return { userId, status: unverified ? "unverified" : "failed", firstSuccessAt: null };
  });
  const active = results.filter((r) => r.status === "success" || r.status === "failed").length;
  if (active < 2) {
    return {
      voided: true,
      results: results.map((r) => (r.status === "frozen" ? r : { userId: r.userId, status: "void", firstSuccessAt: null })),
    };
  }
  return { voided: false, results };
}

export function computeInstancePayout(input: {
  stakeCents: number;
  carryInCents: number;
  results: ParticipantResult[];
}): { memberDeltas: Record<string, number>; carryDelta: number } {
  const { stakeCents, carryInCents } = input;
  if (!Number.isSafeInteger(stakeCents) || stakeCents <= 0) throw new Error(`invalid stake: ${stakeCents}`);
  if (!Number.isSafeInteger(carryInCents) || carryInCents < 0) throw new Error(`invalid carry: ${carryInCents}`);

  const winners = input.results
    .filter((r) => r.status === "success")
    .sort((a, b) => {
      const ta = a.firstSuccessAt ? ms(a.firstSuccessAt) : Infinity;
      const tb = b.firstSuccessAt ? ms(b.firstSuccessAt) : Infinity;
      if (ta !== tb) return ta - tb;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });
  const losers = input.results.filter((r) => r.status === "failed");
  const memberDeltas: Record<string, number> = {};
  if (winners.length + losers.length < 2) return { memberDeltas, carryDelta: 0 };

  for (const l of losers) memberDeltas[l.userId] = -stakeCents;
  if (winners.length === 0) return { memberDeltas, carryDelta: stakeCents * losers.length };

  const pot = stakeCents * losers.length + carryInCents;
  const share = Math.floor(pot / winners.length);
  const leftover = pot % winners.length;
  winners.forEach((w, i) => {
    const amount = share + (i < leftover ? 1 : 0);
    if (amount !== 0) memberDeltas[w.userId] = amount;
  });
  return { memberDeltas, carryDelta: carryInCents === 0 ? 0 : -carryInCents };
}

export interface Obligation {
  from: string;
  to: string;
  amountCents: number;
}

export function simplifyDebts(balances: Record<string, number>): {
  obligations: Obligation[];
  ridingInCarryCents: number;
} {
  const entries = Object.entries(balances);
  for (const [u, v] of entries) if (!Number.isSafeInteger(v)) throw new Error(`invalid balance for ${u}`);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (total > 0) throw new Error(`balances sum to a positive total (${total}); money cannot appear from nowhere`);

  const byAmountThenId = (a: [string, number], b: [string, number]) =>
    b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const creditors = entries.filter(([, v]) => v > 0).map(([u, v]): [string, number] => [u, v]);
  const debtors = entries.filter(([, v]) => v < 0).map(([u, v]): [string, number] => [u, -v]);
  const obligations: Obligation[] = [];

  while (creditors.length > 0) {
    creditors.sort(byAmountThenId);
    debtors.sort(byAmountThenId);
    const c = creditors[0]!;
    const d = debtors[0]!;
    const amount = Math.min(c[1], d[1]);
    obligations.push({ from: d[0], to: c[0], amountCents: amount });
    c[1] -= amount;
    d[1] -= amount;
    if (c[1] === 0) creditors.shift();
    if (d[1] === 0) debtors.shift();
  }
  return { obligations, ridingInCarryCents: total === 0 ? 0 : -total };
}
