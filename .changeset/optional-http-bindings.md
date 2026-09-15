---
"resultar-di": patch
"resultar-fastify": minor
"resultar-hono": minor
---

Allow omitting `bindings` in `createFastifyApp`, `createFastifyPlugin` and `createHonoApp`.
Omission selects all registered services, validates their requirements and infers their
readonly request view. Explicit selections and `bindings: []` retain their existing behavior;
Fastify `appBindings` still defaults to an empty selection. Request locals satisfy dependencies
but are not automatically exposed as registered services.
Explicit selections must be literal tuples; ambiguous tuple unions and widened arrays are
rejected so request types cannot promise services absent from the runtime selection.

Selected services are resolved before the handler, preserving lazy application construction,
scope lifetimes, failure propagation and cleanup. This is not property-based lazy resolution:
a failure acquiring any default-selected service prevents the handler from executing.

Use the Fastify and Hono example applications as integration cases in each package's test suite,
covering their real service graph, native routes, overrides and application isolation without
starting a listener. Both examples demonstrate omitted bindings and inferred application types.
