/**
 * Error hierarchy for the booking layer.
 * The agent only ever needs to catch `BookingError`; the subclasses let callers
 * distinguish auth failures and Optima-specific problems when they care to.
 */

export class BookingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BookingError";
  }
}

/** The provider rejected our credentials (e.g. HTTP 401/403 from Optima). */
export class AuthError extends BookingError {
  constructor(
    message = "Authentication against the booking provider failed",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

/** Any non-auth failure originating from the Optima adapter (network, timeout, 5xx, …). */
export class OptimaError extends BookingError {
  readonly status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OptimaError";
    this.status = status;
  }
}

/** Optima returned a 422 validation error. `details` carries the parsed body when available. */
export class OptimaValidationError extends OptimaError {
  readonly details?: unknown;
  constructor(message = "Optima rejected the request (HTTP 422)", details?: unknown) {
    super(message, 422, { cause: details });
    this.name = "OptimaValidationError";
    this.details = details;
  }
}
