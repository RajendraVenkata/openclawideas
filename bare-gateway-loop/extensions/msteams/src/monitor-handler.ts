// ──────────────────────────────────────────────────────────────────────────
// Real origin: extensions/msteams/src/monitor-handler.ts → MSTeamsActivityHandler,
// registerMSTeamsHandlers, buildActivityHandler. This is where an inbound Bot
// Framework **Activity** is interpreted: it dispatches by `activity.type`
// (message / conversationUpdate / messageReaction) and, for messages, extracts
// the text + sender + conversation, stores a conversation reference, and routes
// it onward (real: into the agent; here: via the channel `onInbound`).
// ──────────────────────────────────────────────────────────────────────────

import type { InboundHandler } from "openclaw/plugin-sdk/channel-core.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";

// The subset of a Bot Framework Activity the read path looks at.
export type MSTeamsActivity = {
  type?: string;
  text?: string;
  replyToId?: string;
  timestamp?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: {
    id?: string;
    conversationType?: string;
    isGroup?: boolean;
    tenantId?: string;
  };
  recipient?: { id?: string; name?: string };
  channelId?: string;
  serviceUrl?: string;
};

export type ActivityContext = { activity: MSTeamsActivity };
type ActivityCallback = (context: ActivityContext, next: () => Promise<void>) => Promise<void>;

export type MSTeamsActivityHandler = {
  onMessage: (cb: ActivityCallback) => MSTeamsActivityHandler;
  onMembersAdded: (cb: ActivityCallback) => MSTeamsActivityHandler;
  onReactionsAdded: (cb: ActivityCallback) => MSTeamsActivityHandler;
  onReactionsRemoved: (cb: ActivityCallback) => MSTeamsActivityHandler;
  run?: (context: ActivityContext) => Promise<void>;
};

export type MSTeamsMessageHandlerDeps = {
  onInbound: InboundHandler;
  conversationStore: MSTeamsConversationStore;
  appId: string;
  log?: (msg: string) => void;
};

// Real: an ActivityHandler-compatible object. Stores callbacks per activity type
// and dispatches them in `run(context)` based on `context.activity.type`.
export function buildActivityHandler(): MSTeamsActivityHandler {
  const callbacks: Record<string, ActivityCallback[]> = {};
  const register = (key: string, cb: ActivityCallback): void => {
    (callbacks[key] ??= []).push(cb);
  };

  const handler: MSTeamsActivityHandler = {
    onMessage(cb) {
      register("message", cb);
      return handler;
    },
    onMembersAdded(cb) {
      register("membersAdded", cb);
      return handler;
    },
    onReactionsAdded(cb) {
      register("reactionsAdded", cb);
      return handler;
    },
    onReactionsRemoved(cb) {
      register("reactionsRemoved", cb);
      return handler;
    },
    run: async (context) => {
      const type = context.activity.type;
      const key =
        type === "message"
          ? "message"
          : type === "conversationUpdate"
            ? "membersAdded"
            : type === "messageReaction"
              ? "reactionsAdded"
              : type ?? "";
      const chain = callbacks[key] ?? [];
      let index = 0;
      const next = async (): Promise<void> => {
        const cb = chain[index++];
        if (cb) {
          await cb(context, next);
        }
      };
      await next();
    },
  };
  return handler;
}

// Registers the concrete activity handlers (the real one also handles invokes,
// SSO, polls, reactions). We keep the message + membersAdded + reaction shells.
export function registerMSTeamsHandlers(
  handler: MSTeamsActivityHandler,
  deps: MSTeamsMessageHandlerDeps,
): void {
  handler.onMessage(async (context, next) => {
    const activity = context.activity;
    const text = activity.text?.trim() ?? "";
    const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
    const senderName = activity.from?.name;
    const conversationId = activity.conversation?.id ?? "unknown";
    const convType = activity.conversation?.conversationType?.toLowerCase();
    const isDirectMessage =
      convType === "personal" || (!convType && !activity.conversation?.isGroup);

    // Store the conversation reference so outbound can send proactively later.
    await deps.conversationStore.upsert(conversationId, {
      conversationId,
      serviceUrl: activity.serviceUrl,
      channelId: activity.channelId,
      user: { id: activity.from?.id, name: senderName },
      bot: { id: activity.recipient?.id, name: activity.recipient?.name },
    });

    deps.log?.(
      `inbound message conv=${conversationId} from=${senderId} direct=${isDirectMessage}`,
    );

    if (text) {
      await deps.onInbound({
        channel: "msteams",
        from: senderName ?? senderId,
        body: text,
        timestamp: Date.now(),
      });
    }
    await next();
  });

  handler.onMembersAdded(async (_context, next) => {
    // REAL: greet newly-added members / the bot's first install.
    await next();
  });

  handler.onReactionsAdded(async (_context, next) => {
    // REAL: map Teams reactions to ack reactions.
    await next();
  });
}
