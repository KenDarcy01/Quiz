// Deletes the signed-in person's account (required by the App Store and Google Play).
// Their profile, child profiles, hosted games and linked devices go with it through the
// database's foreign keys. Called from the app with the user's own session token.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Use POST" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return reply(401, { error: "Not signed in" });

  const { error: delError } = await admin.auth.admin.deleteUser(data.user.id);
  if (delError) return reply(500, { error: delError.message });
  return reply(200, { deleted: true });
});
