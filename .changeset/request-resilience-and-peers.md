---
"resultar": patch
"resultar-request": patch
"resultar-request-typebox": patch
"resultar-request-zod": patch
---

- **resultar**: Corrected `ResultAsyncRetryContext.attempt` JSDoc starting value to 0, streamlined concurrent traversal scheduling to avoid duplicate finish invocations, and added timer cleanup validation on retry aborts.
- **resultar-request**: Guarded response `text()` and `json()` against synchronous throws and promise rejections outside `ResultAsync`, implemented safe serialization for circular references and BigInt values in `RequestError.exception`, mapped `BodyTimeoutError` and `TimeoutError` to status 408, and updated internal dependencies to caret workspace ranges.
- **resultar-request-typebox**: Preserved `code` and `path` in TypeBox validation error items, widened `typebox` peer dependency to `^1.3.4`, and updated internal dependencies to caret workspace ranges.
- **resultar-request-zod**: Widened `zod` peer dependency to `^4.4.3` and updated internal dependencies to caret workspace ranges.
