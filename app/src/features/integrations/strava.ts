/**
 * Strava client helper (lane C; spec "Strava", DEPLOY.md §14). The Edge Function
 * `supabase/functions/strava-sync` owns the OAuth dance: the app asks it for a signed state
 * (`POST /state`), opens its `/connect` hop (which 302s to Strava), and Strava's `/callback`
 * finishes by redirecting the browser back here: `finalcall://settings?strava=connected` on iOS, or
 * the page that started the connect on the web (`https://<origin>/<base>/settings?strava=…`, CC-7).
 *
 * The top half is pure (URL building and parsing, copy, row mapping) and is what
 * `strava.test.ts` covers under Node. The bottom half touches React Native, expo-router's
 * Linking and supabase-js, all imported lazily so this module stays importable without them.
 * Demo mode keeps the connection in memory.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { DEMO } from '../../api/demo/settings';

// ---------- pure ----------

export type StravaReturn = { status: 'connected' } | { status: 'error'; reason: string | null };

export type StravaConnection = { status: 'disconnected' } | { status: 'connected'; athleteId: string; connectedAt: string };

/** `<project url>/functions/v1`, tolerating a trailing slash on the project URL. */
export function functionsBaseFrom(projectUrl: string): string {
  return `${projectUrl.replace(/\/+$/, '')}/functions/v1`;
}

/** The function's `/connect` hop with the signed state; it answers with a 302 to Strava's authorize page. */
export function stravaConnectUrl(functionsBase: string, state: string): string {
  return `${functionsBase.replace(/\/+$/, '')}/strava-sync/connect?state=${encodeURIComponent(state)}`;
}

/**
 * Reads the `strava=connected` / `strava=error&reason=…` the callback appends to the return URL.
 * Accepts the app-scheme URL, a web URL, a bare query (`?strava=…`) or just the query string.
 * Null when the URL says nothing (valid) about Strava.
 */
export function parseStravaReturn(url: string | null | undefined): StravaReturn | null {
  if (!url) return null;
  const q = url.indexOf('?');
  let query = q >= 0 ? url.slice(q + 1) : url;
  const hash = query.indexOf('#');
  if (hash >= 0) query = query.slice(0, hash);
  if (!query.includes('=')) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    return null;
  }
  const status = params.get('strava');
  if (status === 'connected') return { status: 'connected' };
  if (status === 'error') {
    const reason = params.get('reason');
    return { status: 'error', reason: reason && reason.trim() !== '' ? reason : null };
  }
  return null;
}

/** The toast after the browser comes back. Plain words, no bet / stake / pot. */
export function stravaReturnMessage(ret: StravaReturn): string {
  if (ret.status === 'connected') return 'Strava connected. New activities count from now on, and the last 30 days are on their way.';
  switch (ret.reason) {
    case 'access_denied':
      return 'Strava connection cancelled.';
    case 'scope':
      return 'Strava needs permission to read your activities. Try again and allow it.';
    case 'exchange':
    case 'no_code':
      return "Couldn't finish connecting Strava. Try again.";
    case 'server':
      return 'Something went wrong on our side connecting Strava. Try again in a minute.';
    default:
      return "Couldn't connect Strava. Try again.";
  }
}

/** Folds the caller's `my_integrations` rows into one Strava connection. */
export function connectionFrom(rows: readonly { provider: string; athlete_id: string; connected_at: string }[] | null | undefined): StravaConnection {
  const row = rows?.find((r) => r.provider === 'strava');
  if (!row) return { status: 'disconnected' };
  return { status: 'connected', athleteId: row.athlete_id, connectedAt: row.connected_at };
}

/** Body of `POST /state`: the signed-in user, plus the web return URL when there is one. */
export function stateRequestBody(userId: string, redirect?: string | null): { user_id: string; redirect?: string } {
  return redirect ? { user_id: userId, redirect } : { user_id: userId };
}

/** The web return URL is the page itself without its query or hash: origin + path. */
export function webReturnUrlFrom(location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}`;
}

// ---------- runtime ----------

export const STRAVA_QUERY_KEY = ['integrations', 'strava'] as const;

export type StravaStatus = 'loading' | 'disconnected' | 'connected' | 'error';

export interface StravaStatusResult {
  status: StravaStatus;
  athleteId?: string;
  connectedAt?: string;
  error?: unknown;
  refetch: () => Promise<unknown>;
  /** drop the cached connection (after a return from Strava or a disconnect) */
  invalidate: () => Promise<void>;
}

/** Demo mode: the connection lives here and nowhere else. */
let demoConnection: StravaConnection = { status: 'disconnected' };

const DEMO_ATHLETE_ID = '4242';

async function fetchConnection(): Promise<StravaConnection> {
  if (DEMO) return demoConnection;
  const { supabase } = await import('../../api/supabase');
  const { data, error } = await supabase.from('my_integrations').select('provider, athlete_id, connected_at');
  if (error) throw new Error(error.message);
  return connectionFrom(data);
}

/** The signed-in account's Strava connection, cached under `['integrations', 'strava']`. */
export function useStravaStatus(): StravaStatusResult {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: STRAVA_QUERY_KEY, queryFn: fetchConnection, staleTime: 60_000 });
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: STRAVA_QUERY_KEY }), [qc]);
  const refetch = useCallback(() => q.refetch(), [q]);
  if (q.isPending) return { status: 'loading', refetch, invalidate };
  if (q.isError) return { status: 'error', error: q.error, refetch, invalidate };
  const c = q.data;
  if (c.status === 'connected') return { status: 'connected', athleteId: c.athleteId, connectedAt: c.connectedAt, refetch, invalidate };
  return { status: 'disconnected', refetch, invalidate };
}

/** The base path the web build is served under (`experiments.baseUrl`, inlined by Expo; '' natively). */
function webBasePath(): string {
  const base = process.env.EXPO_BASE_URL ?? '';
  return base.replace(/\/+$/, '');
}

/**
 * Opens Strava to connect this account: asks the function for a signed state, then opens its
 * `/connect` hop (in the browser on iOS, by navigating on the web). The callback brings the person
 * back to Settings with `?strava=…`, which `parseStravaReturn` reads. Demo mode just connects.
 */
export async function startStravaConnect(userId: string): Promise<void> {
  if (DEMO) {
    demoConnection = { status: 'connected', athleteId: DEMO_ATHLETE_ID, connectedAt: new Date().toISOString() };
    return;
  }
  const { Platform } = await import('react-native');
  const { supabase } = await import('../../api/supabase');
  const isWeb = Platform.OS === 'web';
  const redirect =
    isWeb && typeof window !== 'undefined' && window.location
      ? webReturnUrlFrom({ origin: window.location.origin, pathname: `${webBasePath()}/settings` })
      : null;
  const { data, error } = await supabase.functions.invoke<{ state?: string; connect_url?: string; error?: string }>('strava-sync/state', {
    body: stateRequestBody(userId, redirect),
  });
  if (error) throw new Error(error.message || "Couldn't reach Strava. Try again.");
  if (data?.error) throw new Error(data.error);
  const projectUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const url = data?.state && projectUrl ? stravaConnectUrl(functionsBaseFrom(projectUrl), data.state) : data?.connect_url;
  if (!url) throw new Error("Couldn't start the Strava connection. Try again.");
  if (isWeb && typeof window !== 'undefined') {
    window.location.assign(url);
    return;
  }
  const { Linking } = await import('react-native');
  await Linking.openURL(url);
}

/** Forgets the connection (`disconnect_integration`). Activities already counted stay. */
export async function disconnectStrava(): Promise<void> {
  if (DEMO) {
    demoConnection = { status: 'disconnected' };
    return;
  }
  const { supabase } = await import('../../api/supabase');
  const { error } = await supabase.rpc('disconnect_integration', { p_provider: 'strava' });
  if (error) throw new Error(error.message);
}
