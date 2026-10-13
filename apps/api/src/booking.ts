/**
 * Integration seam between a tenant's `business` row and the booking layer.
 *
 * The agent (once it gains tools) should call `getBookingForBusiness(business)` and
 * talk only to the returned `BookingProvider` — never a concrete provider. Switching
 * a tenant between Mock and Optima is purely data on the row (or the BOOKING_PROVIDER
 * env default); no code changes, and adding the next clinic is just another row.
 */

import {
  getProvider,
  type BookingProvider,
  type ProviderKind,
} from "@aivantis/booking-provider";

/** The per-tenant booking fields stored on the Supabase `business` row. */
export interface BusinessBookingFields {
  booking_provider?: string | null;
  optima_base_url?: string | null;
  optima_username?: string | null;
  optima_password?: string | null;
  optima_company?: string | null;
}

/** Build the BookingProvider for a given business. */
export function getBookingForBusiness(business: BusinessBookingFields): BookingProvider {
  const kind = (business.booking_provider ??
    process.env.BOOKING_PROVIDER ??
    "mock") as ProviderKind;

  if (kind === "optima") {
    return getProvider({
      provider: "optima",
      optima: {
        baseUrl: required(business.optima_base_url, "optima_base_url"),
        username: required(business.optima_username, "optima_username"),
        password: required(business.optima_password, "optima_password"),
        company: business.optima_company ?? "",
      },
    });
  }

  // Default: the in-memory Mock provider that agent development runs against today.
  return getProvider({ provider: "mock" });
}

function required(value: string | null | undefined, field: string): string {
  if (!value) {
    throw new Error(`business.${field} is required when booking_provider="optima".`);
  }
  return value;
}
