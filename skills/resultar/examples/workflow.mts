import { createTaggedError, ok, Result, ResultTask } from 'resultar'
import type { StrictResult } from 'resultar'

export class InvalidEmailError extends createTaggedError({
  name: 'InvalidEmailError',
  message: 'Invalid email $email',
}) {}

export const validateEmail = (email: string): StrictResult<string, InvalidEmailError> => {
  const normalized = email.trim().toLowerCase()
  return normalized.includes('@') ? ok(normalized) : InvalidEmailError.err({ email })
}

export const account = (email: string): StrictResult<{ email: string }, InvalidEmailError> =>
  Result.gen(function* () {
    const normalized = yield* validateEmail(email)
    return ok({ email: normalized })
  })

export const Greeting = ResultTask.service<string, 'greeting'>('greeting')

// Creating this task runs no work. The boundary supplies its typed dependency.
export const welcome = (email: string) => ResultTask.gen(function* () {
  const normalized = yield* validateEmail(email)
  const greeting = yield* Greeting
  return `${greeting}, ${normalized}`
})
