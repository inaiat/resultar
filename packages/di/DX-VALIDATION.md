# DX validation — 2026-09-05

## Verified locally

- Overrides remove the replaced provider's acquisition errors, deferred cleanup errors, and external requirements. The original module remains unchanged.
- Resolution failures identify the missing service or lifetime violation, the dependency path, and an action to take.
- A generated graph of 50 independent services initially failed with TS2589, approximately 974 MB reported memory and 4.24 seconds of checking. Replacing branching recursive traversal with traversal of the dependency set fixed the failure.
- After the change, generated graphs of 50 / 100 / 200 services compiled with approximately 40 / 52 / 87 MB and 0.026 / 0.067 / 0.240 seconds of checking. A 12-service chain also compiled. These are individual local measurements, not production performance claims or Awilix benchmarks.
- Replis integration ran against SurrealDB 3.2.3 in a temporary memory database. Schema/security checks and concurrent HTTP health requests passed, as did HTTP stream cancellation and scope shutdown. A fresh-database startup failure exposed missing namespace/database provisioning; schema bootstrap now creates them explicitly when requested.

Reproduce compiler measurements with `pnpm --filter resultar-di test:scale`. Replis integration tests require explicitly supplied test database credentials; without them those tests are skipped. Use an isolated database server.

## Remaining external validation

No real WhatsApp account was connected and no messages were sent. Session restoration ran against an empty test database. A dedicated account is needed to verify reconnect, restoration of an existing session, and shutdown during SDK activity.

Usability has not been tested with an independent participant. The following protocol is prepared for that step; it is not a completed study.

## Independent usability protocol

Give the participant only the README and example. Use the same small application requirements for Resultar DI and Awilix; counterbalance which library they try first.

1. Add a request-scoped service using a singleton cache.
2. Supply a tenant value and verify two concurrent requests remain isolated.
3. Replace database initialization with a fake, without supplying real credentials.
4. Diagnose an incompatible contract and a singleton depending on request state.
5. Add a streaming route and verify cleanup after client cancellation.

Record time, documentation lookups, misleading errors, incorrect lifecycle assumptions, and requests for help. Ask the participant to explain singleton ownership and response cleanup afterward. Fix repeated confusion before adding more API alternatives.

The main guide and primary autocomplete now expose one recommended token-based path. Low-level overloads are typed only in the advanced entry point.

## Primary API and compiler diagnostics

The primary entry point now hides named factory overloads and module-level `task`/`resource`
registration throughout fluent composition. Advanced registration remains available through
`resultar-di/advanced` using the same runtime. Type assertions cover the primary surface after
value, singleton, scoped, transient, merge, and override.

`pnpm --filter resultar-di test:dx` checks actual compiler output against the built declarations
for duplicate values/tokens, asynchronous factories, incompatible contracts, missing HTTP
dependencies, and accidental advanced API usage. Duplicate names suggest `override()`;
asynchronous factories suggest `service(name, task)`. These are compiler checks, not a human
usability study or a visual inspection of an editor.

Validation after this refinement passed: 55 DI tests, seven compiler diagnostic cases,
package smoke, type graphs up to 200 services, Hono route and real HTTP smoke checks,
and Replis check/build plus 72 unit tests using the local package link. Database integration
was not rerun for this type-surface change. Package smoke used a temporary npm cache with
lifecycle scripts disabled because the sandbox cannot write the normal npm cache.
