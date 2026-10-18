---
"resultar": minor
---

Add `Retry.policy` for immutable, reusable retry options shared by ResultAsync and ResultTask. Canonical policies use the same zero-based context, exponential backoff, numeric symmetric jitter, asynchronous predicates, and best-effort retry observers in both models. Task closes each attempt scope before retrying. Existing Task and eager Async options retain their callback signatures and jitter behavior.

ResultTask can interrupt its wait for canonical asynchronous retry hooks after closing the attempt scope. Late hook completion or rejection is consumed without scheduling another attempt; the foreign Promise's underlying work can continue.
