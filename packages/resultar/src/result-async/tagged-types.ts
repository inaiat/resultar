import type { Result } from '../result/result.js'
import type { CatchReasonHandlers, CatchTagHandlers } from '../tagged/tagged-types.js'
import type { ResultAsync } from './result-async.js'

export type ResultAsyncCatchTagHandlers<E, Handlers> = CatchTagHandlers<
  E,
  Handlers,
  Result<unknown, unknown> | ResultAsync<unknown, unknown>
>

export type ResultAsyncCatchReasonHandlers<
  E,
  ErrorTag extends string,
  Handlers,
> = CatchReasonHandlers<
  E,
  ErrorTag,
  Handlers,
  Result<unknown, unknown> | ResultAsync<unknown, unknown>
>
