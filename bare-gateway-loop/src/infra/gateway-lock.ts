// VERBATIM — origin: openclaw/src/infra/gateway-lock.ts (line ~53)
//
// The real module also owns the on-disk lock file (per base-port + host) that
// gives the gateway an exclusive bind and survives crashes/SIGKILL. Only the
// error class used by listenGatewayHttpServer is reproduced here.
export class GatewayLockError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}
