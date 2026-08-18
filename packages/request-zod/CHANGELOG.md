# resultar-request-zod

## 0.1.2

### Patch Changes

- 93b11c1: Document the JSR entrypoints and exported symbols used by Resultar and its request packages.
- b913a80: - **resultar**: Corrected `ResultAsyncRetryContext.attempt` JSDoc starting value to 0, streamlined concurrent traversal scheduling to avoid duplicate finish invocations, and added timer cleanup validation on retry aborts.
  - **resultar-request**: Guarded response `text()` and `json()` against synchronous throws and promise rejections outside `ResultAsync`, implemented safe serialization for circular references and BigInt values in `RequestError.exception`, mapped `BodyTimeoutError` and `TimeoutError` to status 408, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-typebox**: Preserved `code` and `path` in TypeBox validation error items, widened `typebox` peer dependency to `^1.3.4`, and updated internal dependencies to caret workspace ranges.
  - **resultar-request-zod**: Widened `zod` peer dependency to `^4.4.3` and updated internal dependencies to caret workspace ranges.
- Updated dependencies [93b11c1]
- Updated dependencies [b913a80]
  - resultar@3.5.2
  - resultar-request@0.1.2

## 0.1.1

### Patch Changes

- 8ab30ff: Clarify the recommended validation workflow, request examples, runtime requirements, and published
  documentation links across the checker and request packages.
- Updated dependencies [8ab30ff]
- Updated dependencies [8ab30ff]
  - resultar@3.5.1
  - resultar-request@0.1.1

## 0.1.0

### Minor Changes

- f7f8fbd: Add fetch-first JSON request helpers with validator-neutral core support plus TypeBox and Zod adapters.

### Patch Changes

- Updated dependencies
- Updated dependencies [f7f8fbd]
- Updated dependencies [dfbfcb3]
  - resultar@3.5.0
  - resultar-request@0.1.0
