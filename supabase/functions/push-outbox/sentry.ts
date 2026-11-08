/**
 * Optional Sentry for the Edge Function. Nothing is imported unless SENTRY_DSN is set in the
 * function's secrets (`supabase secrets set SENTRY_DSN=... SENTRY_ENVIRONMENT=production`), so a
 * project without Sentry pays no cold-start cost and `deno check` needs no network for it (the
 * specifier is built at run time on purpose). Deno-only: not part of the vitest/tsc surface.
 */

interface SentryLike {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, context?: Record<string, unknown>): unknown;
  flush(timeoutMs?: number): Promise<boolean>;
}

const SENTRY_SPECIFIER = "npm:@sentry/deno@9";

let loaded: Promise<SentryLike | null> | undefined;

function load(): Promise<SentryLike | null> {
  if (loaded) return loaded;
  loaded = (async () => {
    const dsn = Deno.env.get("SENTRY_DSN");
    if (!dsn) return null;
    try {
      const mod = (await import(SENTRY_SPECIFIER)) as SentryLike;
      mod.init({
        dsn,
        environment: Deno.env.get("SENTRY_ENVIRONMENT") ?? "production",
        tracesSampleRate: 0,
        sendDefaultPii: false,
      });
      return mod;
    } catch (e) {
      console.error(JSON.stringify({ fn: "push-outbox", sentry: "init failed", error: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  })();
  return loaded;
}

/** Report and flush (the isolate may be torn down right after the response). No-op without a DSN. */
export async function captureException(error: unknown, extra?: Record<string, unknown>): Promise<void> {
  const sentry = await load();
  if (!sentry) return;
  try {
    sentry.captureException(error, extra ? { extra } : undefined);
    await sentry.flush(2000);
  } catch {
    // never let reporting fail the run
  }
}
