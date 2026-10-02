import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

const systemPrompt = `You are CivicAI, CivicFix's helpful, concise, practical, community-focused assistant.
Explain how to report civic issues and offer safe, realistic actions communities can take.
Be honest about uncertainty and never claim that you contacted officials, submitted or resolved a report, or know local rules you were not given. Never invent local statistics, reports, partnerships, or government policies. Do not generate SQL or access private reports. For urgent danger, advise contacting the appropriate local emergency service. Keep replies under 180 words.`;

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST to send a message." }, 405);
  }

  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return jsonResponse({ error: "Please sign in to use CivicAI." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: "CivicAI authentication is not configured." }, 503);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData.user) {
    return jsonResponse({ error: "Your session is no longer valid. Please sign in again." }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "The message could not be read." }, 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonResponse({ error: "Send a message to CivicAI." }, 400);
  }

  const body = payload as { message?: unknown; history?: unknown };
  if (typeof body.message !== "string" || !body.message.trim()) {
    return jsonResponse({ error: "Type a message before sending." }, 400);
  }
  if (body.message.length > 1000) {
    return jsonResponse({ error: "Messages must be 1,000 characters or fewer." }, 413);
  }

  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const allowedHistory = history.filter(
    (item): item is { role: "user" | "assistant"; content: string } =>
      !!item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      ((item as { role?: unknown }).role === "user" ||
        (item as { role?: unknown }).role === "assistant") &&
      typeof (item as { content?: unknown }).content === "string" &&
      (item as { content: string }).content.length <= 1000,
  );

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return jsonResponse({
      error: "CivicAI isn't configured yet. Add your AI provider secret to the Supabase Edge Function to enable the assistant.",
      code: "AI_NOT_CONFIGURED",
    }, 503);
  }

  try {
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 320,
        messages: [
          { role: "system", content: systemPrompt },
          ...allowedHistory,
          { role: "user", content: body.message.trim() },
        ],
      }),
    });

    if (!aiResponse.ok) {
      return jsonResponse({ error: "I'm having trouble connecting right now. Please try again." }, 502);
    }

    const result = await aiResponse.json();
    const answer = result?.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      return jsonResponse({ error: "CivicAI couldn't prepare a response. Please try again." }, 502);
    }
    return jsonResponse({ answer: answer.trim() });
  } catch {
    return jsonResponse({ error: "I'm having trouble connecting right now. Please try again." }, 502);
  }
});