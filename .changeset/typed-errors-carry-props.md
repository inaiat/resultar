---
"resultar": minor
---

Add `createTaggedError(...).withProps<Props>()` for precise template fields and structured error metadata while preserving existing inference defaults. Each specialization creates a distinct constructor so nominal guards cannot confuse incompatible metadata views.

Specialized constructors preserve readonly string metadata from getters, inherited properties, and non-enumerable fields. The original factory keeps its existing own-enumerable copy behavior. Error fields and helpers are protected; cause remains in the existing constructor channel, preserving any cause type declared by a custom base.
