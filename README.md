# Aivantis — WhatsApp appointment agent (sanitized snapshot)

Development handoff, **not production-ready**. Start with [the Hebrew DevOps handoff](DEVOPS_HANDOFF_HE.md) and [release notes](PUBLIC_RELEASE.md).

Stack: TypeScript, pnpm 9, Turborepo, Hono, Supabase, Claude API, Twilio WhatsApp, Mock-only BookingProvider.

Optima adapter/specification/generated client are excluded. Optima cannot be enabled through configuration. Historical handoff sections about Optima describe the private project, not included capabilities.

## Local development

```sh
pnpm install --frozen-lockfile
pnpm --filter @aivantis/booking-provider test
pnpm --filter api test
pnpm exec turbo build --force
```

Create `apps/api/.env` from `apps/api/.env.example` using your own development credentials. Keep `BOOKING_PROVIDER=mock`. Leave `OPTIMA_LIVE` and `OPTIMA_WRITE` unset. Review migrations before applying them to a separate development database; do not blindly run rollback or development-policy SQL.

```sh
pnpm --filter api dev
```

The API listens on port 3001 by default. `/health` is a liveness check, not dependency readiness. Mock bookings do not mean offline operation: Claude, Supabase and Twilio can still receive data and incur costs. Unit tests use fixtures/stubs; demos and conversation scenarios can call paid APIs.

Staff labels/codes and tenant UUIDs were replaced consistently with demo identifiers. Clinic documents, history and live-operation scripts were excluded. Fixtures are examples only: never call or message their phone numbers.

No project-wide open-source license is granted by this snapshot. Preserve existing third-party notices; obtain the owner's licensing decision before redistribution beyond the intended handoff. Publishing this repository does not grant access to any provider account or patient data.
