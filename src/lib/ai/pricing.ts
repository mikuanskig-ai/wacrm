// ============================================================
// Approximate BYO-key cost estimation for the usage panel (UX audit
// Parte 5, Meses 4-6 — "custo estimado em R$ no painel de uso de IA").
// A small business owner cares about "how much is this costing me",
// not "how many tokens" — but we never bill anyone directly (accounts
// use their own provider key), so this is always an ESTIMATE built
// from public list prices, not a real invoice line. Prices here are
// approximate and drift as providers change them; keep this table
// roughly current, but never present the result as an exact bill.
// ============================================================

interface ModelPrice {
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output (completion) tokens. */
  outputPerMillion: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-5.4-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-5.4": { inputPerMillion: 3, outputPerMillion: 12 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-5": { inputPerMillion: 15, outputPerMillion: 75 },
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "llama-3.3-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "llama-3.1-8b-instant": { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  // OpenRouter proxies dozens of providers under model ids like
  // "anthropic/claude-sonnet-5" — mapped where the underlying model is
  // one we already price above. OpenRouter itself adds a small margin
  // on top of the base provider's price that isn't reflected here.
  "meta-llama/llama-3.3-70b-instruct": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "openai/gpt-5.4-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "anthropic/claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "google/gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

// Not a live FX rate — a periodically-updated approximation is good
// enough for "roughly how much", which is all this feature promises.
const USD_TO_BRL = 5.5;

/** Null when the model isn't in the price table (e.g. a custom OpenRouter id) — callers should hide cost for that row rather than show a wrong number. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  return (
    (promptTokens / 1_000_000) * price.inputPerMillion +
    (completionTokens / 1_000_000) * price.outputPerMillion
  );
}

export function usdToBrl(usd: number): number {
  return usd * USD_TO_BRL;
}

export function isKnownModel(model: string): boolean {
  return model in MODEL_PRICES;
}
