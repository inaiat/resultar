---
"resultar-check": patch
---

Recognize createTaggedError(...).withProps<Props>() class bases in the
tagged-error-name-match and no-tagged-error-constructor-override rules.
Preserve the existing checks for factory options without treating unrelated
withProps methods or unsupported transformations as Resultar tagged errors.
