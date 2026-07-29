// ------------------------------------------------------------
// Account AI status is the same for every conversation, so cache it per
// account and reuse it across thread switches / list renders instead of
// hitting /api/ai/config repeatedly. Shared by AiThreadBanner (per-thread
// banner) and ConversationList (the CHATBOT bucket predicate) so both
// read the exact same cached value instead of drifting.
//
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next call rather than hiding AI state for
// the whole session.
// ------------------------------------------------------------
export interface AiAccountStatus {
  autoReplyOn: boolean;
}

const statusCache = new Map<string, AiAccountStatus>();

export async function fetchAiAccountStatus(accountId: string): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return cached;
  try {
    const res = await fetch("/api/ai/config", { cache: "no-store" });
    if (!res.ok) return { autoReplyOn: false }; // don't cache a transient failure
    const j = await res.json();
    const status = {
      // AI auto-reply is "live" only when configured, the master switch
      // is on, and the inbound bot is enabled.
      autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
    };
    statusCache.set(accountId, status);
    return status;
  } catch {
    return { autoReplyOn: false }; // don't cache
  }
}
