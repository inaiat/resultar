type ResultAsyncFactory = (promise: Promise<unknown>) => unknown

let resultAsyncFactory: ResultAsyncFactory | undefined = undefined

export const registerResultAsyncFactory = (factory: ResultAsyncFactory): void => {
  resultAsyncFactory = factory
}

export const createResultAsync = <T>(promise: Promise<unknown>): T => {
  if (resultAsyncFactory === undefined) {
    throw new Error('ResultAsync is not registered')
  }

  return resultAsyncFactory(promise) as T
}
