// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/conversation-store.ts (+ -fs / -memory).
// Stores a ConversationReference per conversation id so the bot can send
// *proactive* replies later (outbound uses adapter.continueConversation(ref)).
// We provide the in-memory variant (real: createMSTeamsConversationStoreMemory).
// ──────────────────────────────────────────────────────────────────────────

/** Minimal ConversationReference shape for proactive messaging. */
export type StoredConversationReference = {
  conversationId: string;
  serviceUrl?: string;
  channelId?: string;
  user?: { id?: string; name?: string };
  bot?: { id?: string; name?: string };
};

export type MSTeamsConversationStore = {
  upsert: (conversationId: string, reference: StoredConversationReference) => Promise<void>;
  get: (conversationId: string) => Promise<StoredConversationReference | null>;
};

export function createMSTeamsConversationStoreMemory(): MSTeamsConversationStore {
  const map = new Map<string, StoredConversationReference>();
  return {
    upsert: async (conversationId, reference) => {
      map.set(conversationId, reference);
    },
    get: async (conversationId) => map.get(conversationId) ?? null,
  };
}
