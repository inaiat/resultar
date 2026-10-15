---
"resultar": minor
---

Yield the ResultTask interpreter cooperatively after an operation budget, allowing timers and other event-loop work to proceed during long task chains and generators. Add an injectable TaskScheduler and yieldEvery run option; child fibers have independent budgets, and callers can use Infinity to disable automatic yields.

A failed dispatcher records a defect and switches its fiber to Scheduler.live so owned cleanup still runs, including after a dispatcher failure during cleanup. Release failures remain preserved as sequential causes.
