import { Data } from 'effect'

export class IntegrationError extends Data.TaggedError('IntegrationError')<{
  readonly source: string
  readonly operation: string
  readonly message: string
}> {
  getDisplayMessage(): string {
    return this.message
  }

  static queue(operation: string, message: string): IntegrationError {
    return new IntegrationError({ source: 'queue', operation, message })
  }
}
