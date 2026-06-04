// Real origin: openclaw/src/pairing/pairing-messages.ts → buildPairingReply.
// The message an unknown sender receives when a pairing code is issued.

export function buildPairingReply(params: {
  channel: string;
  idLine: string;
  code: string;
}): string {
  return [
    `🔒 Pairing required on ${params.channel}.`,
    params.idLine,
    `Your code: ${params.code}`,
    `An operator must approve you before I can respond.`,
  ].join("\n");
}
