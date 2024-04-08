# Resultar

## About

Resultar is a TypeScript library that is a fork of the excellent [neverthrow](https://github.com/supermacro/neverthrow) library. The neverthrow library provides a robust and type-safe way to handle errors without throwing exceptions, using the Result type.

In the spirit of open-source development, **resultar** builds upon the solid foundation laid by neverthrow, extending its functionality to better suit specific needs. It introduces additional methods and functions such as tap, safeTryAsync, and fromThrowableAsync, providing more flexibility and control in error handling.

While resultar owes its origins to neverthrow, it has evolved to offer its own unique features, making error handling in TypeScript even more powerful and expressive. It's a testament to the power of open-source collaboration and the continuous pursuit of improving code quality and developer experience.

## Description

Encode failure into your program.

This package contains a `Result` type that represents either success (`Ok`) or failure (`Err`).

For asynchronous tasks, `resultar` offers a `ResultAsync` class which wraps a `Promise<Result<T, E>>` and gives you the same level of expressivity and control as a regular `Result<T, E>`.

`ResultAsync` is `thenable` meaning it **behaves exactly like a native `Promise<Result>`** ... except you have access to the same methods that `Result` provides without having to `await` or `.then` the promise! Check out [the wiki](https://github.com/inaiat/resultar/wiki/Basic-Usage-Examples#asynchronous-api) for examples and best practices.

> Need to see real-life examples of how to leverage this package for error handling? See this repo: https://github.com/parlez-vous/server

<div id="toc"></div>

## Table Of Contents

* [Installation](../wiki/#installation)
* [Top-Level API](../wiki/#top-level-api)
* [API Documentation](../wiki/#api-documentation)
  + [Synchronous API (`Result`)](../wiki/#synchronous-api-result)
    - [`ok`](../wiki/#ok)
    - [`err`](../wiki/#err)
    - [`Result.isOk` (method)](../wiki/#resultisok-method)
    - [`Result.isErr` (method)](../wiki/#resultiserr-method)
    - [`Result.map` (method)](../wiki/#resultmap-method)
    - [`Result.mapErr` (method)](../wiki/#resultmaperr-method)
    - [`Result.unwrapOr` (method)](../wiki/#resultunwrapor-method)
    - [`Result.andThen` (method)](../wiki/#resultandthen-method)
    - [`Result.asyncAndThen` (method)](../wiki/#resultasyncandthen-method)
    - [`Result.orElse` (method)](../wiki/#resultorelse-method)
    - [`Result.match` (method)](../wiki/#resultmatch-method)
    - [`Result.asyncMap` (method)](../wiki/#resultasyncmap-method)
    - [`Result.fromThrowable` (static class method)](../wiki/#resultfromthrowable-static-class-method)
    - [`Result.combine` (static class method)](../wiki/#resultcombine-static-class-method)
    - [`Result.combineWithAllErrors` (static class method)](../wiki/#resultcombinewithallerrors-static-class-method)
    - [`Result.safeUnwrap()`](../wiki/#resultsafeunwrap)
  + [Asynchronous API (`ResultAsync`)](../wiki/#asynchronous-api-resultasync)
    - [`okAsync`](../wiki/#okasync)
    - [`errAsync`](../wiki/#errasync)
    - [`ResultAsync.fromPromise` (static class method)](../wiki/#resultasyncfrompromise-static-class-method)
    - [`ResultAsync.fromSafePromise` (static class method)](../wiki/#resultasyncfromsafepromise-static-class-method)
    - [`ResultAsync.map` (method)](../wiki/#resultasyncmap-method)
    - [`ResultAsync.mapErr` (method)](../wiki/#resultasyncmaperr-method)
    - [`ResultAsync.unwrapOr` (method)](../wiki/#resultasyncunwrapor-method)
    - [`ResultAsync.andThen` (method)](../wiki/#resultasyncandthen-method)
    - [`ResultAsync.orElse` (method)](../wiki/#resultasyncorelse-method)
    - [`ResultAsync.match` (method)](../wiki/#resultasyncmatch-method)
    - [`ResultAsync.combine` (static class method)](../wiki/#resultasynccombine-static-class-method)
    - [`ResultAsync.combineWithAllErrors` (static class method)](../wiki/#resultasynccombinewithallerrors-static-class-method)
    - [`ResultAsync.safeUnwrap()`](../wiki/#resultasyncsafeunwrap)
  + [Utilities](../wiki/#utilities)
    - [`fromThrowable`](../wiki/#fromthrowable)
    - [`fromPromise`](../wiki/#frompromise)
    - [`fromSafePromise`](../wiki/#fromsafepromise)
    - [`safeTry`](../wiki/#safetry)
  + [Testing](../wiki/#testing)
* [A note on the Package Name](../wiki/#a-note-on-the-package-name)

## Installation

```sh
> npm install resultar
```

## Top-Level API

`resultar` exposes the following:

- `ok` convenience function to create an `Ok` variant of `Result`
- `err` convenience function to create an `Err` variant of `Result`
- `Ok` class and type
- `Err` class and type
- `Result` Type as well as namespace / object from which to call [`Result.fromThrowable`](../wiki/#resultfromthrowable-static-class-method), [Result.combine](../wiki/#resultcombine-static-class-method).
- `ResultAsync` class
- `okAsync` convenience function to create a `ResultAsync` containing an `Ok` type `Result`
- `errAsync` convenience function to create a `ResultAsync` containing an `Err` type `Result`

```typescript
import {
  ok,
  Ok,
  err,
  Err,
  Result,
  okAsync,
  errAsync,
  ResultAsync,
  fromThrowable,
  fromPromise,
  fromSafePromise,
  safeTry,
} from 'resultar'
```

---

**Check out the [wiki](https://github.com/inaiat/resultar/wiki) for help on how to make the most of `resultar`.**

---

## API Documentation

### Synchronous API (`Result`)

#### `ok`

Constructs an `Ok` variant of `Result`

**Signature:**

```typescript
ok<T, E>(value: T): Ok<T, E> { ... }
```

**Example:**

```typescript
import { ok } from 'resultar'

const myResult = ok({ myData: 'test' }) // instance of `Ok`

myResult.isOk() // true
myResult.isErr() // false
```

[⬆️  Back to top](../wiki/#toc)

---

#### `err`

Constructs an `Err` variant of `Result`

**Signature:**

```typescript
err<T, E>(error: E): Err<T, E> { ... }
```

**Example:**

```typescript
import { err } from 'resultar'

const myResult = err('Oh noooo') // instance of `Err`

myResult.isOk() // false
myResult.isErr() // true
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.isOk` (method)

Returns `true` if the result is an `Ok` variant

**Signature:**

```typescript
isOk(): boolean { ... }
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.isErr` (method)

Returns `true` if the result is an `Err` variant

**Signature**:

```typescript
isErr(): boolean { ... }
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.map` (method)

Maps a `Result<T, E>` to `Result<U, E>` by applying a function to a contained `Ok` value, leaving an `Err` value untouched.

This function can be used to compose the results of two functions.

**Signature:**

```typescript
class Result<T, E> {
  map<U>(callback: (value: T) => U): Result<U, E> { ... }
}
```

**Example**:

```typescript
import { getLines } from 'imaginary-parser'
// ^ assume getLines has the following signature:
// getLines(str: string): Result<Array<string>, Error>

// since the formatting is deemed correct by `getLines`
// then it means that `linesResult` is an Ok
// containing an Array of strings for each line of code
const linesResult = getLines('1\n2\n3\n4\n')

// this Result now has a Array<number> inside it
const newResult = linesResult.map(
  (arr: Array<string>) => arr.map(parseInt)
)

newResult.isOk() // true
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.mapErr` (method)

Maps a `Result<T, E>` to `Result<T, F>` by applying a function to a contained `Err` value, leaving an `Ok` value untouched.

This function can be used to pass through a successful result while handling an error.

**Signature:**

```typescript
class Result<T, E> {
  mapErr<F>(callback: (error: E) => F): Result<T, F> { ... }
}
```

**Example**:

```typescript
import { parseHeaders } from 'imaginary-http-parser'
// imagine that parseHeaders has the following signature:
// parseHeaders(raw: string): Result<SomeKeyValueMap, ParseError>

const rawHeaders = 'nonsensical gibberish and badly formatted stuff'

const parseResult = parseHeaders(rawHeaders)

parseResult.mapErr(parseError => {
  res.status(400).json({
    error: parseError
  })
})

parseResult.isErr() // true
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.unwrapOr` (method)

Unwrap the `Ok` value, or return the default if there is an `Err`

**Signature:**

```typescript
class Result<T, E> {
  unwrapOr<T>(value: T): T { ... }
}
```

**Example**:

```typescript
const myResult = err('Oh noooo')

const multiply = (value: number): number => value * 2

const unwrapped: number = myResult.map(multiply).unwrapOr(10)
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.andThen` (method)

Same idea as `map` above. Except you must return a new `Result`.

The returned value will be a `Result`. As of `v4.1.0-beta`, you are able to return distinct error types (see signature below). Prior to `v4.1.0-beta`, the error type could not be distinct.

This is useful for when you need to do a subsequent computation using the inner `T` value, but that computation might fail.

Additionally, `andThen` is really useful as a tool to flatten a `Result<Result<A, E2>, E1>` into a `Result<A, E2>` (see example below).

**Signature:**

```typescript
class Result<T, E> {
  // Note that the latest version lets you return distinct errors as well.
  // If the error types (E and F) are the same (like `string | string`)
  // then they will be merged into one type (`string`)
  andThen<U, F>(
    callback: (value: T) => Result<U, F>
  ): Result<U, E | F> { ... }
}
```

**Example 1: Chaining Results**

```typescript
import { err, ok } from 'resultar'

const sq = (n: number): Result<number, number> => ok(n ** 2)

ok(2)
  .andThen(sq)
  .andThen(sq) // Ok(16)

ok(2)
  .andThen(sq)
  .andThen(err) // Err(4)

ok(2)
  .andThen(err)
  .andThen(sq) // Err(2)

err(3)
  .andThen(sq)
  .andThen(sq) // Err(3)
```

**Example 2: Flattening Nested Results**

```typescript
// It's common to have nested Results
const nested = ok(ok(1234))

// notNested is a Ok(1234)
const notNested = nested.andThen((innerResult) => innerResult)
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.asyncAndThen` (method)

Same idea as [`andThen` above](../wiki/#resultandthen-method), except you must return a new `ResultAsync`.

The returned value will be a `ResultAsync`.

**Signature:**

```typescript
class Result<T, E> {
  asyncAndThen<U, F>(
    callback: (value: T) => ResultAsync<U, F>
  ): ResultAsync<U, E | F> { ... }
}
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.orElse` (method)

Takes an `Err` value and maps it to a `Result<T, SomeNewType>`. This is useful for error recovery.

**Signature:**

```typescript
class Result<T, E> {
  orElse<A>(
    callback: (error: E) => Result<T, A>
  ): Result<T, A> { ... }
}
```

**Example:**

```typescript
enum DatabaseError {
  PoolExhausted = 'PoolExhausted',
  NotFound = 'NotFound',
}

const dbQueryResult: Result<string, DatabaseError> = err(DatabaseError.NotFound)

const updatedQueryResult = dbQueryResult.orElse((dbError) =>
  dbError === DatabaseError.NotFound
    ? ok('User does not exist') // error recovery branch: ok() must be called with a value of type string
    //
    //
    // err() can be called with a value of any new type that you want
    // it could also be called with the same error value
    //     
    //     err(dbError)
    : err(500) 
)
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.match` (method)

Given 2 functions (one for the `Ok` variant and one for the `Err` variant) execute the function that matches the `Result` variant.

Match callbacks do not necessitate to return a `Result`, however you can return a `Result` if you want to.

**Signature:**

```typescript
class Result<T, E> {
  match<A>(
    okCallback: (value: T) =>  A,
    errorCallback: (error: E) =>  A
  ): A => { ... }
}
```

`match` is like chaining `map` and `mapErr`, with the distinction that with `match` both functions must have the same return type.
The differences between `match` and chaining `map` and `mapErr` are that:
- with `match` both functions must have the same return type `A`
- `match` unwraps the `Result<T, E>` into an `A` (the match functions' return type)
  - This makes no difference if you are performing side effects only

**Example:**

```typescript
// map/mapErr api
// note that you DON'T have to append mapErr
// after map which means that you are not required to do
// error handling
computationThatMightFail().map(console.log).mapErr(console.error)

// match api
// works exactly the same as above since both callbacks
// only perform side effects,
// except, now you HAVE to do error handling :)
computationThatMightFail().match(console.log, console.error)

// Returning values
const attempt = computationThatMightFail()
  .map((str) => str.toUpperCase())
  .mapErr((err) => `Error: ${err}`)
// `attempt` is of type `Result<string, string>`

const answer = computationThatMightFail().match(
  (str) => str.toUpperCase(),
  (err) => `Error: ${err}`
)
// `answer` is of type `string`
```

If you don't use the error parameter in your match callback then `match` is equivalent to chaining `map` with `unwrapOr`:
```ts
const answer = computationThatMightFail().match(
  (str) => str.toUpperCase(),
  () => 'ComputationError'
)
// `answer` is of type `string`

const answer = computationThatMightFail()
  .map((str) => str.toUpperCase())
  .unwrapOr('ComputationError')
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.asyncMap` (method)

Similar to `map` except for two things:

- the mapping function must return a `Promise`
- asyncMap returns a `ResultAsync`

You can then chain the result of `asyncMap` using the `ResultAsync` apis (like `map`, `mapErr`, `andThen`, etc.)

**Signature:**

```typescript
class Result<T, E> {
  asyncMap<U>(
    callback: (value: T) => Promise<U>
  ): ResultAsync<U, E> { ... }
}
```

**Example:**

```typescript
import { parseHeaders } from 'imaginary-http-parser'
// imagine that parseHeaders has the following signature:
// parseHeaders(raw: string): Result<SomeKeyValueMap, ParseError>

const asyncRes = parseHeaders(rawHeader)
  .map(headerKvMap => headerKvMap.Authorization)
  .asyncMap(findUserInDatabase)
```

Note that in the above example if `parseHeaders` returns an `Err` then `.map` and `.asyncMap` will not be invoked, and `asyncRes` variable will resolve to an `Err` when turned into a `Result` using `await` or `.then()`.
  
[⬆️  Back to top](../wiki/#toc)

---

#### `Result.fromThrowable` (static class method)

> Although Result is not an actual JS class, the way that `fromThrowable` has been implemented requires that you call `fromThrowable` as though it were a static method on `Result`. See examples below.

The JavaScript community has agreed on the convention of throwing exceptions.
As such, when interfacing with third party libraries it's imperative that you
wrap third-party code in try / catch blocks.

This function will create a new function that returns an `Err` when the original
function throws.

It is not possible to know the types of the errors thrown in the original
function, therefore it is recommended to use the second argument `errorFn` to
map what is thrown to a known type.

**Example**:

```typescript
import { Result } from 'resultar'

type ParseError = { message: string }
const toParseError = (): ParseError => ({ message: "Parse Error" })

const safeJsonParse = Result.fromThrowable(JSON.parse, toParseError)

// the function can now be used safely, if the function throws, the result will be an Err
const res = safeJsonParse("{");
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.combine` (static class method)

> Although Result is not an actual JS class, the way that `combine` has been implemented requires that you call `combine` as though it were a static method on `Result`. See examples below.

Combine lists of `Result`s.

If you're familiar with `Promise.all`, the combine function works conceptually the same.

**`combine` works on both heterogeneous and homogeneous lists**. This means that you can have lists that contain different kinds of `Result`s and still be able to combine them. Note that you cannot combine lists that contain both `Result`s **and** `ResultAsync`s.

The combine function takes a list of results and returns a single result. If all the results in the list are `Ok`, then the return value will be a `Ok` containing a list of all the individual `Ok` values.

If just one of the results in the list is an `Err` then the combine function returns that Err value (it short circuits and returns the first Err that it finds).

Formally speaking:

```typescript
// homogeneous lists
function combine<T, E>(resultList: Result<T, E>[]): Result<T[], E>

// heterogeneous lists
function combine<T1, T2, E1, E2>(resultList: [ Result<T1, E1>, Result<T2, E2> ]): Result<[ T1, T2 ], E1 | E2>
function combine<T1, T2, T3, E1, E2, E3> => Result<[ T1, T2, T3 ], E1 | E2 | E3>
function combine<T1, T2, T3, T4, E1, E2, E3, E4> => Result<[ T1, T2, T3, T4 ], E1 | E2 | E3 | E4>
// ... etc etc ad infinitum

```

Example:
```typescript
const resultList: Result<number, never>[] =
  [ok(1), ok(2)]

const combinedList: Result<number[], unknown> =
  Result.combine(resultList)
```

Example with tuples:
```typescript
/** @example tuple(1, 2, 3) === [1, 2, 3] // with type [number, number, number] */
const tuple = <T extends any[]>(...args: T): T => args

const resultTuple: [Result<string, never>, Result<string, never>] =
  tuple(ok('a'), ok('b'))

const combinedTuple: Result<[string, string], unknown> =
  Result.combine(resultTuple)
```

[⬆️  Back to top](../wiki/#toc)

---

#### `Result.combineWithAllErrors` (static class method)

> Although Result is not an actual JS class, the way that `combineWithAllErrors` has been implemented requires that you call `combineWithAllErrors` as though it were a static method on `Result`. See examples below.

Like `combine` but without short-circuiting. Instead of just the first error value, you get a list of all error values of the input result list.

If only some results fail, the new combined error list will only contain the error value of the failed results, meaning that there is no guarantee of the length of the new error list.

Function signature:

```typescript
// homogeneous lists
function combineWithAllErrors<T, E>(resultList: Result<T, E>[]): Result<T[], E[]>

// heterogeneous lists
function combineWithAllErrors<T1, T2, E1, E2>(resultList: [ Result<T1, E1>, Result<T2, E2> ]): Result<[ T1, T2 ], (E1 | E2)[]>
function combineWithAllErrors<T1, T2, T3, E1, E2, E3> => Result<[ T1, T2, T3 ], (E1 | E2 | E3)[]>
function combineWithAllErrors<T1, T2, T3, T4, E1, E2, E3, E4> => Result<[ T1, T2, T3, T4 ], (E1 | E2 | E3 | E4)[]>
// ... etc etc ad infinitum
```

Example usage:

```typescript
const resultList: Result<number, string>[] = [
  ok(123),
  err('boooom!'),
  ok(456),
  err('ahhhhh!'),
]

const result = Result.combineWithAllErrors(resultList)

// result is Err(['boooom!', 'ahhhhh!'])
```

[⬆️  Back to top](../wiki/#toc)

#### `Result.safeUnwrap()`

**⚠️ You must use `.safeUnwrap` in a generator context with `safeTry`**. Please see [safeTry](../wiki/#safeTry).

Allows for unwrapping a `Result` or returning an `Err` implicitly, thereby reducing boilerplate.

[⬆️  Back to top](../wiki/#toc)

---

### Asynchronous API (`ResultAsync`)

#### `okAsync`

Constructs an `Ok` variant of `ResultAsync`

**Signature:**

```typescript
okAsync<T, E>(value: T): ResultAsync<T, E>
```

**Example:**

```typescript
import { okAsync } from 'resultar'

const myResultAsync = okAsync({ myData: 'test' }) // instance of `ResultAsync`

const myResult = await myResultAsync // instance of `Ok`

myResult.isOk() // true
myResult.isErr() // false
```

[⬆️  Back to top](../wiki/#toc)

---

#### `errAsync`

Constructs an `Err` variant of `ResultAsync`

**Signature:**

```typescript
errAsync<T, E>(error: E): ResultAsync<T, E>
```

**Example:**

```typescript
import { errAsync } from 'resultar'

const myResultAsync = errAsync('Oh nooo') // instance of `ResultAsync`

const myResult = await myResultAsync // instance of `Err`

myResult.isOk() // false
myResult.isErr() // true
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.fromPromise` (static class method)

Transforms a `PromiseLike<T>` (that may throw) into a `ResultAsync<T, E>`.

The second argument handles the rejection case of the promise and maps the error from `unknown` into some type `E`.

**Signature:**

```typescript
// fromPromise is a static class method
// also available as a standalone function
// import { fromPromise } from 'resultar'
ResultAsync.fromPromise<T, E>(
  promise: PromiseLike<T>,
  errorHandler: (unknownError: unknown) => E)
): ResultAsync<T, E> { ... }
```

If you are working with `PromiseLike` objects that you **know for a fact** will not throw, then use `fromSafePromise` in order to avoid having to pass a redundant `errorHandler` argument.

**Example**:

```typescript
import { ResultAsync } from 'resultar'
import { insertIntoDb } from 'imaginary-database'
// insertIntoDb(user: User): Promise<User>

const res = ResultAsync.fromPromise(insertIntoDb(myUser), () => new Error('Database error'))
// `res` has a type of ResultAsync<User, Error>
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.fromSafePromise` (static class method)

Same as `ResultAsync.fromPromise` except that it does not handle the rejection of the promise. **Ensure you know what you're doing, otherwise a thrown exception within this promise will cause ResultAsync to reject, instead of resolve to a Result.**

**Signature:**

```typescript
// fromPromise is a static class method
// also available as a standalone function
// import { fromPromise } from 'resultar'
ResultAsync.fromSafePromise<T, E>(
  promise: PromiseLike<T>
): ResultAsync<T, E> { ... }
```

**Example**:

```typescript
import { RouteError } from 'routes/error'

// simulate slow routes in an http server that works in a Result / ResultAsync context
// Adopted from https://github.com/parlez-vous/server/blob/2496bacf55a2acbebc30631b5562f34272794d76/src/routes/common/signup.ts
export const slowDown = <T>(ms: number) => (value: T) =>
  ResultAsync.fromSafePromise<T, RouteError>(
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(value)
      }, ms)
    })
  )

export const signupHandler = route<User>((req, sessionManager) =>
  decode(userSignupDecoder, req.body, 'Invalid request body').map((parsed) => {
    return createUser(parsed)
      .andThen(slowDown(3000)) // slowdown by 3 seconds
      .andThen(sessionManager.createSession)
      .map(({ sessionToken, admin }) => AppData.init(admin, sessionToken))
  })
)
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.map` (method)

Maps a `ResultAsync<T, E>` to `ResultAsync<U, E>` by applying a function to a contained `Ok` value, leaving an `Err` value untouched.

The applied function can be synchronous or asynchronous (returning a `Promise<U>`) with no impact to the return type.

This function can be used to compose the results of two functions.

**Signature:**

```typescript
class ResultAsync<T, E> {
  map<U>(
    callback: (value: T) => U | Promise<U>
  ): ResultAsync<U, E> { ... }
}
```

**Example**:

```typescript
import { findUsersIn } from 'imaginary-database'
// ^ assume findUsersIn has the following signature:
// findUsersIn(country: string): ResultAsync<Array<User>, Error>

const usersInCanada = findUsersIn("Canada")

// Let's assume we only need their names
const namesInCanada = usersInCanada.map((users: Array<User>) => users.map(user => user.name))
// namesInCanada is of type ResultAsync<Array<string>, Error>

// We can extract the Result using .then() or await
namesInCanada.then((namesResult: Result<Array<string>, Error>) => {
  if(namesResult.isErr()){
    console.log("Couldn't get the users from the database", namesResult.error)
  }
  else{
    console.log("Users in Canada are named: " + namesResult.value.join(','))
  }
})
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.mapErr` (method)

Maps a `ResultAsync<T, E>` to `ResultAsync<T, F>` by applying a function to a contained `Err` value, leaving an `Ok` value untouched.

The applied function can be synchronous or asynchronous (returning a `Promise<F>`) with no impact to the return type.

This function can be used to pass through a successful result while handling an error.

**Signature:**

```typescript
class ResultAsync<T, E> {
  mapErr<F>(
    callback: (error: E) => F | Promise<F>
  ): ResultAsync<T, F> { ... }
}
```

**Example**:

```typescript
import { findUsersIn } from 'imaginary-database'
// ^ assume findUsersIn has the following signature:
// findUsersIn(country: string): ResultAsync<Array<User>, Error>

// Let's say we need to low-level errors from findUsersIn to be more readable
const usersInCanada = findUsersIn("Canada").mapErr((error: Error) => {
  // The only error we want to pass to the user is "Unknown country"
  if(error.message === "Unknown country"){
    return error.message
  }
  // All other errors will be labelled as a system error
  return "System error, please contact an administrator."
})

// usersInCanada is of type ResultAsync<Array<User>, string>

usersInCanada.then((usersResult: Result<Array<User>, string>) => {
  if(usersResult.isErr()){
    res.status(400).json({
      error: usersResult.error
    })
  }
  else{
    res.status(200).json({
      users: usersResult.value
    })
  }
})
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.unwrapOr` (method)

Unwrap the `Ok` value, or return the default if there is an `Err`.  
Works just like `Result.unwrapOr` but returns a `Promise<T>` instead of `T`.

**Signature:**

```typescript
class ResultAsync<T, E> {
  unwrapOr<T>(value: T): Promise<T> { ... }
}
```

**Example**:

```typescript
const unwrapped: number = await errAsync(0).unwrapOr(10)
// unwrapped = 10
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.andThen` (method)

Same idea as `map` above. Except the applied function must return a `Result` or `ResultAsync`.

`ResultAsync.andThen` always returns a `ResultAsync` no matter the return type of the applied function.

This is useful for when you need to do a subsequent computation using the inner `T` value, but that computation might fail.

`andThen` is really useful as a tool to flatten a `ResultAsync<ResultAsync<A, E2>, E1>` into a `ResultAsync<A, E2>` (see example below).

**Signature:**

```typescript
// Note that the latest version (v4.1.0-beta) lets you return distinct errors as well.
// If the error types (E and F) are the same (like `string | string`)
// then they will be merged into one type (`string`)

class ResultAsync<T, E> {
  andThen<U, F>(
    callback: (value: T) => Result<U, F> | ResultAsync<U, F>
  ): ResultAsync<U, E | F> { ... }
}
```

**Example**

```typescript

import { validateUser } from 'imaginary-validator'
import { insertUser } from 'imaginary-database'
import { sendNotification } from 'imaginary-service'

// ^ assume validateUser, insertUser and sendNotification have the following signatures:
// validateUser(user: User): Result<User, Error>
// insertUser(user): ResultAsync<User, Error>
// sendNotification(user): ResultAsync<void, Error>

const resAsync = validateUser(user)
               .andThen(insertUser)
               .andThen(sendNotification)

// resAsync is a ResultAsync<void, Error>

resAsync.then((res: Result<void, Error>) => {
  if(res.isErr()){
    console.log("Oops, at least one step failed", res.error)
  }
  else{
    console.log("User has been validated, inserted and notified successfully.")
  }
})
```

[⬆️  Back to top](../wiki/#toc)

---
#### `Result.tap` (method)
Executes a side effect function with the `Ok` value and returns the original `Result`.
This method is useful for performing actions that do not modify the `Result` itself, such as logging or updating external state.
**Signature:**
```typescript
class ResultAsync<T, E> {
  tap(f: (t: T) => void): Result<T, E> {..}
}
```

**Example:**
```typescript
const fooValue = ok('foo')

const mapped = okVal.tap((value) => {
  console.log(value) // print foo
})
// mapped.value === 'foo'

---

#### `ResultAsync.orElse` (method)

Takes an `Err` value and maps it to a `ResultAsync<T, SomeNewType>`. This is useful for error recovery.

**Signature:**

```typescript
class ResultAsync`<T, E>` \{
  orElse`<A>`(
    callback: (error: E) => Result`<T, A>` | ResultAsync`<T, A>`
  ): ResultAsync`<T, A>` \{ ... \}
\}
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.match` (method)

Given 2 functions (one for the `Ok` variant and one for the `Err` variant) execute the function that matches the `ResultAsync` variant.

The difference with `Result.match` is that it always returns a `Promise` because of the asynchronous nature of the `ResultAsync`.

**Signature:**

```typescript
class ResultAsync`<T, E>` \{
  match`<A>`(
    okCallback: (value: T) =>  A,
    errorCallback: (error: E) =>  A
  ): Promise`<A>` => \{ ... \}
\}
```

**Example:**

```typescript

import \{ validateUser \} from 'imaginary-validator'
import \{ insertUser \} from 'imaginary-database'

// ^ assume validateUser and insertUser have the following signatures:
// validateUser(user: User): Result`<User, Error>`
// insertUser(user): ResultAsync`<User, Error>`

// Handle both cases at the end of the chain using match
const resultMessage = await validateUser(user)
        .andThen(insertUser)
        .match(
            (user: User) => `User ${user.name} has been successfully created`,
            (error: Error) =>  `User could not be created because ${error.message}`
        )

// resultMessage is a string
```

[⬆️  Back to top](../wiki/#toc)

---

#### `ResultAsync.combine` (static class method)

Combine lists of `ResultAsync`s.

If you're familiar with `Promise.all`, the combine function works conceptually the same.

**`combine` works on both heterogeneous and homogeneous lists**. This means that you can have lists that contain different kinds of `ResultAsync`s and still be able to combine them. Note that you cannot combine lists that contain both `Result`s **and** `ResultAsync`s.

The combine function takes a list of results and returns a single result. If all the results in the list are `Ok`, then the return value will be a `Ok` containing a list of all the individual `Ok` values.

If just one of the results in the list is an `Err` then the combine function returns that Err value (it short circuits and returns the first Err that it finds).

Formally speaking:

```typescript
// homogeneous lists
function combine`<T, E>`(resultList: ResultAsync`<T, E>`[]): ResultAsync`<T[], E>`

// heterogeneous lists
function combine`<T1, T2, E1, E2>`(resultList: [ ResultAsync`<T1, E1>`, ResultAsync`<T2, E2>` ]): ResultAsync`<[ T1, T2 ], E1 | E2>`
function combine`<T1, T2, T3, E1, E2, E3>` => ResultAsync`<[ T1, T2, T3 ], E1 | E2 | E3>`
function combine`<T1, T2, T3, T4, E1, E2, E3, E4>` => ResultAsync`<[ T1, T2, T3, T4 ], E1 | E2 | E3 | E4>`
// ... etc etc ad infinitum

```

Example:
```typescript
const resultList: ResultAsync`<number, never>`[] =
  [okAsync(1), okAsync(2)]

const combinedList: ResultAsync`<number[], unknown>` =
  ResultAsync.combine(resultList)
```

Example with tuples:
```typescript
/**
