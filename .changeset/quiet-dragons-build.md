---
---

Move example dependency builds from the automatic prepare lifecycle to explicit build:deps commands. Keep smoke tests and request examples building their dependencies before execution, while preventing parallel installation hooks from cleaning shared package outputs during agent-guide compilation. Build the native checker explicitly for all five examples so standalone commands also work after a clean installation.
