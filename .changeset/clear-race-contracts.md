---
"resultar": patch
---

Correct ResultAsync race documentation: race and raceAll return the first Ok,
or the last completed Err when every task fails; raceFirst returns the first
completed Result. Clarify that ResultAsync aborts pending losers without waiting
for cleanup, while ResultTask races and timeouts await owned child cleanup.
Runtime behavior and public signatures are unchanged.
