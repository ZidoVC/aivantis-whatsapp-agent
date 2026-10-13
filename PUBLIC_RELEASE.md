# Public snapshot release record

CURRENT EDITION: Mock-only. Optima adapter, specification, generated client, schemas/mappers, related package tests and supplier-specific SQL are excluded. Compatibility types and application-level safety guards remain; no live Optima provider can be created. Descriptions of Optima below describe the earlier candidate only and are superseded by this notice. No project-wide open-source license has been granted.

Prepared 2026-10-13 from local baseline `a48b2a7` plus the DevOps handoff. This is an independent source snapshot, not a fork containing the private repository's Git history.

## Included

- API source and unit tests.
- BookingProvider contract, Mock implementation and retained unit tests (Mock-only).
- Package manifests, frozen lockfile, workspace/build configuration.
- SQL migrations and preflight/rollback helpers, for review only.
- Demo/chat/scenario scripts and blank environment example.
- Hebrew DevOps handoff and this README.

## Excluded

- `.git`, real `.env`, dependencies, build output, logs and local tooling.
- Private project-context/status documents, client Word document and knowledge graph.
- Live-test transcripts, supplier gap reports, deletion/probe/write-cycle scripts.
- Copied third-party skills and unrelated/untracked `src/`.

## Sanitization

Client/staff labels, corresponding mock codes, example tenant UUIDs and known live-test card IDs were mechanically replaced consistently in copied text only. The source checkout was not edited. The mock roster and treatment catalog remain illustrative configuration, not real clinic operating instructions. Tests retain example phone/identity formats so redaction and matching can be tested; they must not be contacted.

Optima implementation, specification and generated client are excluded. No project-wide open-source license has been granted.

## Validation and release gates

Fresh validation: `pnpm exec turbo build --force` exited 0; all 4 tasks passed without cache, with 170 API tests and 20 booking-provider tests (190 total). No live-provider/scenario or deployment test was run. Historical totals in the handoff describe the private baseline, not this Mock-only edition.

Before publication: review final file list/diff, scan secret values and client identifiers, decide licensing, verify new repository destination and privacy of the old repository. Do not copy the original `.git` or push from the original checkout.

Recommended new repository name: `aivantis-whatsapp-agent`. No remote repository has been created or uploaded yet.
