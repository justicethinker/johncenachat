/** Error type thrown by protocol helpers. Carries a stable machine-readable code. */
export class ProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ProtocolError";
    this.code = code;
  }
}
