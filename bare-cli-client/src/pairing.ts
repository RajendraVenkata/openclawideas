// Pairing flow: ask the gateway if we're already approved; if not, the gateway
// printed a code on ITS console (never over chat) — the user reads it there and
// types it here, and we submit it to pair.
import type { WsClient } from "./ws-client.js";
import type { Ui } from "./ui.js";

export async function ensurePaired(ws: WsClient, ui: Ui, name: string): Promise<void> {
  const status = (await ws.req("pairing.request", { channel: "cli" })) as {
    approved?: boolean;
    pending?: boolean;
  };
  if (status.approved) {
    ui.printSystem(`already paired as "${name}"`);
    return;
  }

  ui.printSystem("🔒 Pairing required — look at the GATEWAY console for your approval code.");
  for (;;) {
    const code = (await ui.question("Enter approval code: ")).trim();
    if (!code) continue;
    try {
      const result = (await ws.req("pairing.approve", { channel: "cli", code })) as {
        approved?: string;
      };
      ui.printSystem(`✓ paired (approved "${result.approved}")`);
      return;
    } catch {
      ui.printError("invalid code — check the gateway console and try again");
    }
  }
}
