import { Router, type IRouter } from "express";
import {
  ChatWithCivicAIBody,
  ChatWithCivicAIResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const requestWindows = new Map<string, { startedAt: number; count: number }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;

const civicAISystemPrompt = [
  "You are CivicAI, a practical, nonpartisan guide to civic problem-solving.",
  "Give concise, respectful, general information and suggest ways to verify it with official local sources.",
  "Do not claim to be a government agency, provide live local facts, or guarantee an outcome.",
  "When an answer depends on jurisdiction, ask for only a broad location such as a city or region.",
  "Do not ask for names, exact addresses, account credentials, or other sensitive personal information.",
  "CivicFix does not accept, submit, or store reports. Do not imply that you have reported an issue.",
  "For an immediate threat or emergency, tell the user to contact local emergency services.",
].join(" ");

function isConfigured(): boolean {
  return Boolean(
    process.env.CIVICAI_ENDPOINT?.trim() &&
      process.env.CIVICAI_API_KEY?.trim() &&
      process.env.CIVICAI_MODEL?.trim(),
  );
}

function isSecureEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return false;
    }
    if (parsed.protocol === "https:") return true;

    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return (
      process.env.NODE_ENV !== "production" &&
      parsed.protocol === "http:" &&
      localHosts.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isRateLimited(ipAddress: string): boolean {
  const now = Date.now();
  for (const [ip, window] of requestWindows) {
    if (now - window.startedAt >= WINDOW_MS) requestWindows.delete(ip);
  }

  const current = requestWindows.get(ipAddress);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestWindows.set(ipAddress, { startedAt: now, count: 1 });
    return false;
  }

  current.count += 1;
  return current.count > MAX_REQUESTS_PER_WINDOW;
}

router.post("/civicai/chat", async (req, res): Promise<void> => {
  const parsed = ChatWithCivicAIBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Send a valid conversation to CivicAI." });
    return;
  }

  const conversation = parsed.data.messages;
  if (conversation.at(-1)?.role !== "user") {
    res.status(400).json({ error: "Your latest message must be a question." });
    return;
  }

  if (isRateLimited(req.ip || "unknown")) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Please wait a minute before asking again." });
    return;
  }

  const endpoint = process.env.CIVICAI_ENDPOINT?.trim();
  const apiKey = process.env.CIVICAI_API_KEY?.trim();
  const model = process.env.CIVICAI_MODEL?.trim();
  if (!endpoint || !apiKey || !model) {
    res.status(503).json({
      error: "CivicAI needs an AI-compatible endpoint, model, and rotated API key configured.",
    });
    return;
  }

  if (!isSecureEndpoint(endpoint)) {
    req.log.error("CivicAI endpoint configuration is invalid.");
    res.status(503).json({ error: "CivicAI provider configuration is invalid." });
    return;
  }

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: civicAISystemPrompt },
          ...conversation,
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      req.log.warn(
        { providerStatus: upstream.status },
        "CivicAI provider returned an unsuccessful response.",
      );
      res.status(502).json({
        error: "CivicAI could not get a response right now. Please try again later.",
      });
      return;
    }

    const result: unknown = await upstream.json();
    if (
      typeof result !== "object" ||
      result === null ||
      !("choices" in result) ||
      !Array.isArray(result.choices)
    ) {
      req.log.warn("CivicAI provider returned an unexpected response.");
      res.status(502).json({
        error: "CivicAI received an unexpected provider response.",
      });
      return;
    }

    const firstChoice = result.choices[0];
    const answer =
      typeof firstChoice === "object" &&
      firstChoice !== null &&
      "message" in firstChoice &&
      typeof firstChoice.message === "object" &&
      firstChoice.message !== null &&
      "content" in firstChoice.message &&
      typeof firstChoice.message.content === "string"
        ? firstChoice.message.content.trim()
        : "";

    if (!answer) {
      req.log.warn("CivicAI provider returned an empty response.");
      res.status(502).json({
        error: "CivicAI received an empty response. Please try again.",
      });
      return;
    }

    res.json(ChatWithCivicAIResponse.parse({ answer }));
  } catch {
    req.log.error("CivicAI provider request failed.");
    res.status(502).json({
      error: "CivicAI could not connect to its provider. Please try again later.",
    });
  }
});

export default router;