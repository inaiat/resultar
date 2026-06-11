type Result<T, E> = { readonly error?: E; readonly value?: T }

const saveUser = (input: string): Result<string, Error> => ({ value: input })

saveUser('ignored')
