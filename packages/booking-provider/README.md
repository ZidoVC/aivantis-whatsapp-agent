# @aivantis/booking-provider

Provider-agnostic booking abstraction for the Aivantis agent. The agent talks only
to the `BookingProvider` interface; concrete providers live behind it:

```
Agent → getProvider(config) → ┬─ MockProvider   (in-memory, dev today)
                              └─ OptimaProvider (Optima WS Adapter, per-tenant)
```

Switching a tenant between Mock and Optima is a config change only
(`BOOKING_PROVIDER` env, or `business.booking_provider`). Nothing Optima-shaped
leaks past this package — only `types`, the `BookingProvider` interface, the error
classes, and `getProvider` are exported.

## Usage

```ts
import { getProvider } from "@aivantis/booking-provider";

// Mock (default — current agent development):
const booking = getProvider();

// Optima, with per-tenant credentials from the `business` row:
const booking = getProvider({
  provider: "optima",
  optima: { baseUrl, username, password, company }, // baseUrl includes /api2
});

const slots = await booking.getAvailableSlots({ start: "2026-07-01", end: "2026-07-03" });
```

In `apps/api`, use the seam `getBookingForBusiness(business)` (see
`apps/api/src/booking.ts`), which maps a Supabase `business` row to a provider.

### Conventions (clean side)

- dates `YYYY-MM-DD`, times `HH:MM:SS`, durations whole minutes, ids strings,
  gender `"unknown" | "male" | "female"`.
- The Optima wire formats (`DD/MM/YYYY`, gender `0/1/2`, stringly-typed numbers)
  are handled in `optima/mappers.ts` — callers never see them.

## Layout

| File | Role |
|------|------|
| `types.ts`, `provider.ts`, `errors.ts` | the clean, exported contract |
| `index.ts` | `getProvider` factory (the only entry point) |
| `mock/mock-provider.ts` | in-memory provider for agent dev (zero setup) |
| `optima/optima-openapi.json` | source of truth for the generated client |
| `optima/optima-client.gen.ts` | **generated — do not edit** (`pnpm gen:optima`) |
| `optima/optima-fetcher.ts` | Basic Auth + 20s timeout + tolerant JSON parsing |
| `optima/mappers.ts` | date/time/gender translation + tolerant readers |
| `optima/optima-provider.ts` | implements the interface against Optima |
| `optima/optima-schemas.ts` | Zod for *responses*, hardened incrementally |
| `sql/001_business_optima_columns.sql` | per-tenant columns on `business` |

## Client generation note

The client is generated with `--runtime none` (pure TS types), not `--runtime zod`
as in the original build doc: typed-openapi 2.2.7's zod-runtime client does not
typecheck under TypeScript 6 (`z.infer<TEndpoint>` constraint). We don't lose
anything — the OpenAPI spec declares every response body as `{}` (unknown), so
response validation is done by our own Zod in `optima-schemas.ts`, built up against
real responses. Regenerate with `pnpm --filter @aivantis/booking-provider gen:optima`.

## Open items (need the client / Optima)

- Real credentials: base URL (with `/api2`), username, password, company number.
- Whether a staging/test company exists (write ops touch medical data — see build
  doc rule #9; test reads first: `/health → /doctors_sites → /search_patient →
  /available_appointments`).
- Actual response shapes, to tighten `optima-schemas.ts` and the `optima-provider`
  field mappings (each domain object currently keeps the payload under `raw`).
- Meaning of `view`, and `site_id` / `site_code` defaults across branches/rooms.
