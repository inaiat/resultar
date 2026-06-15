import {
  createTaggedError,
  err,
  ok,
  okAsync,
  safeTry,
  tryResult,
  type Result,
  type ResultAsync,
} from 'resultar'

interface User {
  readonly id: string
}

class SaveUserError extends Error {
  readonly code = 'SaveUserError'
}

class ParseUserError extends Error {
  readonly code = 'ParseUserError'
}

export class MismatchedTaggedError extends createTaggedError({
  name: 'DifferentTaggedError',
  message: 'This tag name should match the class name',
}) {}

export class TaggedErrorWithConstructor extends createTaggedError({
  name: 'TaggedErrorWithConstructor',
  message: 'The generated constructor should not be overridden',
}) {
  constructor() {
    super()
  }
}

const saveUser = (id: string): Result<User, SaveUserError> => {
  if (id === '') {
    return err(new SaveUserError('Missing user id'))
  }

  return ok({ id })
}

const saveUserAsync = (id: string): ResultAsync<User, SaveUserError> => okAsync({ id })

const inspect = (_value: unknown): void => {}

saveUser('ignored-sync')
saveUserAsync('ignored-async')

void saveUser('explicit-void')

const assigned = saveUser('assigned')
const unhandled = saveUser('unhandled')
const handled = saveUser('handled')

inspect(unhandled)

export const returned = (): Result<User, SaveUserError> => saveUser('returned')

export const awaited = async (): Promise<Result<User, SaveUserError>> =>
  await saveUserAsync('awaited')

export const assignedValue = assigned.match(
  (user) => user.id,
  (error) => error.message,
)

export const handledValue = handled.match(
  (user) => user.id,
  (error) => error.message,
)

export const preferMapErrExample = (): Result<User, SaveUserError> =>
  saveUser('prefer-map-err').orElse((error) => err(new SaveUserError(error.message)))

export const preferAndThenExample = () =>
  saveUser('prefer-and-then').map((user) => saveUser(user.id))

export const typedCatchMapperExample = () => tryResult(() => JSON.parse('{"id":"parsed"}') as User)

export const noTryCatchInSafeTryExample = (): Result<User, SaveUserError> =>
  safeTry(function* () {
    try {
      const user = yield* saveUser('safe-try')

      return ok(user)
    } catch {
      return err(new SaveUserError('Caught inside safeTry'))
    }
  })

export const yieldStarInSafeTryExample = (): Result<User, SaveUserError> =>
  safeTry(function* () {
    yield err<never, SaveUserError>(new SaveUserError('Use yield* here'))

    return ok({ id: 'unreachable' })
  })

export const unsafeResultTypeAssertionExample = (
  result: Result<User, SaveUserError | ParseUserError>,
): Result<User, SaveUserError> => result as Result<User, SaveUserError>

export const preferTaggedErrorExample = (): Result<User, Error> =>
  err(new Error('Use createTaggedError for domain errors'))

export const noUselessRecoveryExample = (): Result<User, never> =>
  ok<User, never>({ id: 'infallible' }).mapErr((error) => error)
