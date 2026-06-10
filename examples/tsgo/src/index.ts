import { err, ok, okAsync, type Result, type ResultAsync } from 'resultar'

interface User {
  readonly id: string
}

class SaveUserError extends Error {}

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
