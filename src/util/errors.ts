export class TransplantError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TransplantError";
  }
}
