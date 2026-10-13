/**
 * Public surface of @aivantis/booking-provider.
 *
 * IRON RULE: only the clean contract leaves this package — domain types, the
 * `BookingProvider` interface, the error hierarchy, and the `getProvider` factory.
 * Nothing from `optima/` or `mock/` is re-exported, so the agent can never depend
 * on a specific provider. Switching Mock <-> Optima is a `BOOKING_PROVIDER` change.
 */

import type { BookingProvider } from "./provider";
import type { BookingProviderConfig, ProviderKind } from "./types";
import { BookingError } from "./errors";
import { MockProvider } from "./mock/mock-provider";

export * from "./types";
export * from "./errors";
export type { BookingProvider } from "./provider";

/**
 * Resolve the booking provider for a tenant.
 *
 * @example
 *   // Mock (default — current agent development):
 *   const booking = getProvider();
 *
 *   // Historical private integration example — rejected in this public edition:
 *   const booking = getProvider({
 *     provider: "optima",
 *     optima: { baseUrl, username, password, company },
 *   });
 */
export function getProvider(config: BookingProviderConfig = {}): BookingProvider {
  const kind: ProviderKind =
    config.provider ?? (process.env.BOOKING_PROVIDER as ProviderKind | undefined) ?? "mock";

  switch (kind) {
    case "mock":
      return new MockProvider();
    case "optima":
      if (!config.optima) {
        throw new BookingError(
          'BOOKING_PROVIDER="optima" requires optima credentials (baseUrl, username, password, company).',
        );
      }
      throw new BookingError("Optima is excluded from this public Mock-only snapshot.");
    default:
      throw new BookingError(`Unknown BOOKING_PROVIDER "${kind}". Expected "mock" or "optima".`);
  }
}
