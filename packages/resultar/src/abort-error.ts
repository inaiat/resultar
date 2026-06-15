export class AbortError extends Error {
  public constructor(message = 'Operation aborted', options?: ErrorOptions) {
    super(message, options)
    this.name = 'AbortError'
  }
}

const hasAbortName = (value: unknown): value is { readonly name: 'AbortError' } =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  (value as { readonly name?: unknown }).name === 'AbortError'

const hasAbortCode = (value: unknown): value is { readonly code: 'ABORT_ERR' } =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  (value as { readonly code?: unknown }).code === 'ABORT_ERR'

export const isAbortError = (value: unknown): value is AbortError =>
  value instanceof AbortError || hasAbortName(value) || hasAbortCode(value)
