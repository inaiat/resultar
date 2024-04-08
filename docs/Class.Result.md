[resultar](../wiki/Home) / Result

# Class: Result\<T, E\>

## Type parameters

• **T**

• **E**

## Implements

- `Resultable`\<`T`, `E`\>

## Constructors

### new Result(state)

> **`private`** **new Result**\<`T`, `E`\>(`state`): [`Result`](../wiki/Class.Result)\<`T`, `E`\>

#### Parameters

• **state**: `Ok`\<`T`\> \| `Err`\<`E`\>

#### Returns

[`Result`](../wiki/Class.Result)\<`T`, `E`\>

#### Source

[result.ts:133](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L133)

## Properties

### error

> **`readonly`** **error**: `E`

#### Implementation of

`Resultable.error`

#### Source

[result.ts:131](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L131)

***

### state

> **`private`** **`readonly`** **state**: `Ok`\<`T`\> \| `Err`\<`E`\>

#### Source

[result.ts:133](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L133)

***

### value

> **`readonly`** **value**: `T`

#### Implementation of

`Resultable.value`

#### Source

[result.ts:130](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L130)

## Methods

### \_unsafeUnwrap()

> **\_unsafeUnwrap**(`config`?): `T`

**This method is unsafe, and should only be used in a test environments**

Takes a `Result<T, E>` and returns a `T` when the result is an `Ok`, otherwise it throws a custom object.

#### Parameters

• **config?**: `ErrorConfig`

#### Returns

`T`

#### Implementation of

`Resultable._unsafeUnwrap`

#### Source

[result.ts:342](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L342)

***

### \_unsafeUnwrapErr()

> **\_unsafeUnwrapErr**(`config`?): `E`

**This method is unsafe, and should only be used in a test environments**

takes a `Result<T, E>` and returns a `E` when the result is an `Err`,
otherwise it throws a custom object.

#### Parameters

• **config?**: `ErrorConfig`

#### Returns

`E`

#### Implementation of

`Resultable._unsafeUnwrapErr`

#### Source

[result.ts:358](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L358)

***

### andThen()

> **andThen**\<`X`, `Y`\>(`f`): [`Result`](../wiki/Class.Result)\<`X`, `E` \| `Y`\>

Similar to `map` Except you must return a new `Result`.

This is useful for when you need to do a subsequent computation using the
inner `T` value, but that computation might fail.
Additionally, `andThen` is really useful as a tool to flatten a
`Result<Result<A, E2>, E1>` into a `Result<A, E2>` (see example below).

#### Type parameters

• **X**

• **Y**

#### Parameters

• **f**

The function to apply to the current value

#### Returns

[`Result`](../wiki/Class.Result)\<`X`, `E` \| `Y`\>

#### Source

[result.ts:206](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L206)

***

### asyncAndThen()

> **asyncAndThen**\<`X`, `Y`\>(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`X`, `E` \| `Y`\>

Similar to `map` Except you must return a new `Result`.

This is useful for when you need to do a subsequent async computation using
the inner `T` value, but that computation might fail. Must return a ResultAsync

#### Type parameters

• **X**

• **Y**

#### Parameters

• **f**

The function that returns a `ResultAsync` to apply to the current
value

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`X`, `E` \| `Y`\>

#### Source

[result.ts:242](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L242)

***

### asyncMap()

> **asyncMap**\<`X`\>(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`X`, `E`\>

Maps a `Result<T, E>` to `ResultAsync<U, E>`
by applying an async function to a contained `Ok` value, leaving an `Err`
value untouched.

#### Type parameters

• **X**

#### Parameters

• **f**

An async function to apply an `OK` value

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`X`, `E`\>

#### Source

[result.ts:258](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L258)

***

### finally()

> **finally**\<`X`, `Y`\>(`f`): [`DisposableResult`](../wiki/Class.DisposableResult)\<`X`, `Y`\>

This method is used to clean up and release any resources that the `Result`

#### Type parameters

• **X** = `T`

• **Y** = `E`

#### Parameters

• **f**

The function that will be called to clean up the resources

#### Returns

[`DisposableResult`](../wiki/Class.DisposableResult)\<`X`, `Y`\>

#### Source

[result.ts:325](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L325)

***

### isErr()

> **isErr**(): `boolean`

Used to check if a `Result` is an `Err`

#### Returns

`boolean`

`true` if the result is an `Err` variant of Result

#### Implementation of

`Resultable.isErr`

#### Source

[result.ts:157](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L157)

***

### isOk()

> **isOk**(): `boolean`

Used to check if a `Result` is an `OK`

#### Returns

`boolean`

`true` if the result is an `OK` variant of Result

#### Implementation of

`Resultable.isOk`

#### Source

[result.ts:148](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L148)

***

### map()

> **map**\<`X`, `Y`\>(`f`): [`Result`](../wiki/Class.Result)\<`X`, `E` \| `Y`\>

Maps a `Result<T, E>` to `Result<U, E>`
by applying a function to a contained `Ok` value, leaving an `Err` value
untouched.

#### Type parameters

• **X**

• **Y**

#### Parameters

• **f**

The function to apply an `OK` value

#### Returns

[`Result`](../wiki/Class.Result)\<`X`, `E` \| `Y`\>

the result of applying `f` or an `Err` untouched

#### Source

[result.ts:169](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L169)

***

### mapErr()

> **mapErr**\<`X`\>(`fn`): [`Result`](../wiki/Class.Result)\<`T`, `X`\>

Maps a `Result<T, E>` to `Result<T, F>` by applying a function to a
contained `Err` value, leaving an `Ok` value untouched.

This function can be used to pass through a successful result while
handling an error.

#### Type parameters

• **X**

#### Parameters

• **fn**

#### Returns

[`Result`](../wiki/Class.Result)\<`T`, `X`\>

#### Source

[result.ts:188](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L188)

***

### match()

> **match**\<`X`\>(`fnOk`, `fnErr`): `X`

Given 2 functions (one for the `Ok` variant and one for the `Err` variant)
execute the function that matches the `Result` variant.

Match callbacks do not necessitate to return a `Result`, however you can
return a `Result` if you want to.

`match` is like chaining `map` and `mapErr`, with the distinction that
with `match` both functions must have the same return type.

#### Type parameters

• **X**

#### Parameters

• **fnOk**

• **fnErr**

#### Returns

`X`

#### Source

[result.ts:293](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L293)

***

### orElse()

> **orElse**\<`Y`\>(`f`): [`Result`](../wiki/Class.Result)\<`T`, `Y`\>

Takes an `Err` value and maps it to a `Result<T, SomeNewType>`.

This is useful for error recovery.

#### Type parameters

• **Y**

#### Parameters

• **f**

A function to apply to an `Err` value, leaving `Ok` values
untouched.

#### Returns

[`Result`](../wiki/Class.Result)\<`T`, `Y`\>

#### Source

[result.ts:224](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L224)

***

### safeUnwrap()

> **safeUnwrap**(): `Generator`\<[`Result`](../wiki/Class.Result)\<`never`, `E`\>, `T`, `unknown`\>

#### Returns

`Generator`\<[`Result`](../wiki/Class.Result)\<`never`, `E`\>, `T`, `unknown`\>

#### Source

[result.ts:366](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L366)

***

### tap()

> **tap**(`f`): [`Result`](../wiki/Class.Result)\<`T`, `E`\>

Performs a side effect for the `Ok` variant of `Result`.

#### Parameters

• **f**

The function to apply an `OK` value

#### Returns

[`Result`](../wiki/Class.Result)\<`T`, `E`\>

the result of applying `f` or an `Err` untouched

#### Source

[result.ts:307](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L307)

***

### unwrapOr()

> **unwrapOr**\<`A`\>(`defaultValue`): `T` \| `A`

Unwrap the `Ok` value, or return the default if there is an `Err`

#### Type parameters

• **A**

#### Parameters

• **defaultValue**: `A`

#### Returns

`T` \| `A`

#### Implementation of

`Resultable.unwrapOr`

#### Source

[result.ts:271](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L271)

***

### combine()

#### combine(resultList)

> **`static`** **combine**\<`T`\>(`resultList`): `CombineResults`\<`T`\>

##### Type parameters

• **T** extends readonly [[`Result`](../wiki/Class.Result)\<`unknown`, `unknown`\>, [`Result`](../wiki/Class.Result)\<`unknown`, `unknown`\>]

##### Parameters

• **resultList**: `T`

##### Returns

`CombineResults`\<`T`\>

##### Source

[result.ts:106](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L106)

#### combine(resultList)

> **`static`** **combine**\<`T`\>(`resultList`): `CombineResults`\<`T`\>

##### Type parameters

• **T** extends readonly [`Result`](../wiki/Class.Result)\<`unknown`, `unknown`\>[]

##### Parameters

• **resultList**: `T`

##### Returns

`CombineResults`\<`T`\>

##### Source

[result.ts:109](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L109)

***

### combineWithAllErrors()

#### combineWithAllErrors(resultList)

> **`static`** **combineWithAllErrors**\<`T`\>(`resultList`): `CombineResultsWithAllErrorsArray`\<`T`\>

##### Type parameters

• **T** extends readonly [[`Result`](../wiki/Class.Result)\<`unknown`, `unknown`\>, [`Result`](../wiki/Class.Result)\<`unknown`, `unknown`\>]

##### Parameters

• **resultList**: `T`

##### Returns

`CombineResultsWithAllErrorsArray`\<`T`\>

##### Source

[result.ts:118](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L118)

#### combineWithAllErrors(resultList)

> **`static`** **combineWithAllErrors**\<`T`\>(`resultList`): `CombineResultsWithAllErrorsArray`\<`T`\>

##### Type parameters

• **T** extends readonly [`Result`](../wiki/Class.Result)\<`unknown`, `unknown`\>[]

##### Parameters

• **resultList**: `T`

##### Returns

`CombineResultsWithAllErrorsArray`\<`T`\>

##### Source

[result.ts:121](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L121)

***

### err()

> **`static`** **err**\<`T`, `E`\>(`error`): [`Result`](../wiki/Class.Result)\<`T`, `E`\>

#### Type parameters

• **T** = `never`

• **E** = `unknown`

#### Parameters

• **error**: `E`

#### Returns

[`Result`](../wiki/Class.Result)\<`T`, `E`\>

#### Source

[result.ts:102](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L102)

***

### fromThrowable()

> **`static`** **fromThrowable**\<`Fn`, `E`\>(`fn`, `errorFn`?): (...`args`) => [`Result`](../wiki/Class.Result)\<`ReturnType`\<`Fn`\>, `E`\>

Wraps a function with a try catch, creating a new function with the same
arguments but returning `Ok` if successful, `Err` if the function throws

#### Type parameters

• **Fn** extends (...`args`) => `unknown`

• **E**

#### Parameters

• **fn**: `Fn`

function to wrap with ok on success or err on failure

• **errorFn?**

when an error is thrown, this will wrap the error result if provided

#### Returns

`Function`

> ##### Parameters
>
> • ...**args**: `Parameters`\<`Fn`\>
>
> ##### Returns
>
> [`Result`](../wiki/Class.Result)\<`ReturnType`\<`Fn`\>, `E`\>
>

#### Source

[result.ts:80](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L80)

***

### ok()

> **`static`** **ok**\<`T`, `E`\>(`value`): [`Result`](../wiki/Class.Result)\<`T`, `E`\>

#### Type parameters

• **T**

• **E** = `never`

#### Parameters

• **value**: `T`

#### Returns

[`Result`](../wiki/Class.Result)\<`T`, `E`\>

#### Source

[result.ts:98](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L98)
