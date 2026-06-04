// Real origin: openclaw/src/pairing/pairing-store.types.ts (+ allow-from-store-file.ts)
// Two persisted shapes per channel: pending pairing requests, and the approved
// allow-from list.

export type PairingChannel = string;

export type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

export type PairingStore = {
  version: 1;
  requests: PairingRequest[];
};

export type AllowFromStore = {
  version: 1;
  allowFrom: string[];
};
