// Deno-only. Supabase client + JWT verifier for the edge functions.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import type { TokenVerifier } from "./http.ts";

// deno-lint-ignore no-explicit-any
declare const Deno: any;

/** Service-role client for graph persistence (bypasses RLS; server-side only). */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Verify a Supabase-issued JWT and return the caller. A bad or expired token
 * resolves to null, which the handler turns into a 401.
 */
export function makeTokenVerifier(client: SupabaseClient): TokenVerifier {
  return async (token: string) => {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;
    return { userId: data.user.id };
  };
}
