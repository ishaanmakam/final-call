import { createClient } from "npm:@supabase/supabase-js@2";
import {
  bearerMatches,
  type DeadToken,
  type OutboxRow,
  processOutbox,
  type PushTokenRow,
  type RowError,
  sendExpoBatch,
} from "./outbox.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const EXPO_ACCESS_TOKEN = Deno.env.get("EXPO_ACCESS_TOKEN") ?? undefined;

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function groupByError(rows: RowError[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of rows) out.set(r.error, [...(out.get(r.error) ?? []), r.id]);
  return out;
}

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!SERVICE_ROLE_KEY || !bearerMatches(req.headers.get("authorization"), SERVICE_ROLE_KEY)) {
    return json(401, { error: "unauthorized" });
  }

  try {
    const summary = await processOutbox({
      claim: async (limit) => {
        const { data, error } = await db.rpc("claim_outbox", { p_limit: limit });
        check(error, "claim_outbox");
        return (data ?? []) as OutboxRow[];
      },
      tokensFor: async (userIds) => {
        const { data, error } = await db.from("push_tokens").select("user_id, token").in("user_id", userIds);
        check(error, "push_tokens select");
        return (data ?? []) as PushTokenRow[];
      },
      send: (messages) => sendExpoBatch(fetch, messages, { accessToken: EXPO_ACCESS_TOKEN, timeoutMs: 20_000 }),
      markSent: async (ids) => {
        const { error } = await db
          .from("notification_outbox")
          .update({ sent_at: new Date().toISOString(), last_error: null, claimed_until: null })
          .in("id", ids);
        check(error, "mark sent");
      },
      markFailed: async (failures) => {
        for (const [message, ids] of groupByError(failures)) {
          const { error } = await db
            .from("notification_outbox")
            .update({ last_error: message, claimed_until: null })
            .in("id", ids);
          check(error, "mark failed");
        }
      },
      markDropped: async (drops) => {
        for (const [message, ids] of groupByError(drops)) {
          const { error } = await db
            .from("notification_outbox")
            .update({ last_error: message, attempts: 5, claimed_until: null })
            .in("id", ids);
          check(error, "mark dropped");
        }
      },
      deleteTokens: async (tokens: DeadToken[]) => {
        for (const t of tokens) {
          const { error } = await db.from("push_tokens").delete().eq("user_id", t.userId).eq("token", t.token);
          check(error, "delete push token");
        }
      },
    });
    console.log(JSON.stringify({ fn: "push-outbox", ...summary }));
    return json(200, summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ fn: "push-outbox", error: message }));
    return json(500, { error: message });
  }
});
