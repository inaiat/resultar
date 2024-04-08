[resultar](../wiki/Home) / ResultAsync

# Class: ResultAsync\<T, E\>

## Type parameters

• **T**

• **E**

## Implements

- `PromiseLike`\<[`Result`](../wiki/Class.Result)\<`T`, `E`\>\>

## Constructors

### new ResultAsync(res)

> **new ResultAsync**\<`T`, `E`\>(`res`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Parameters

• **res**: `Promise`\<[`Result`](../wiki/Class.Result)\<`T`, `E`\>\>

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Source

[result-async.ts:65](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L65)

## Properties

### innerPromise

> **`private`** **`readonly`** **innerPromise**: `Promise`\<[`Result`](../wiki/Class.Result)\<`T`, `E`\>\>

#### Source

[result-async.ts:63](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L63)

## Methods

### andThen()

#### andThen(f)

> **andThen**\<`R`\>(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`InferOkTypes`\<`R`\>, `E` \| `InferErrTypes`\<`R`\>\>

##### Type parameters

• **R** extends [`Result`](../wiki/Class.Result)\<`unknown`, `unknown`\>

##### Parameters

• **f**

##### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`InferOkTypes`\<`R`\>, `E` \| `InferErrTypes`\<`R`\>\>

##### Source

[result-async.ts:100](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L100)

#### andThen(f)

> **andThen**\<`R`\>(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`InferAsyncOkTypes`\<`R`\>, `E` \| `InferAsyncErrTypes`\<`R`\>\>

##### Type parameters

• **R** extends [`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>

##### Parameters

• **f**

##### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`InferAsyncOkTypes`\<`R`\>, `E` \| `InferAsyncErrTypes`\<`R`\>\>

##### Source

[result-async.ts:103](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L103)

#### andThen(f)

> **andThen**\<`U`, `F`\>(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`U`, `E` \| `F`\>

##### Type parameters

• **U**

• **F**

##### Parameters

• **f**

##### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`U`, `E` \| `F`\>

##### Source

[result-async.ts:106](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L106)

***

### map()

> **map**\<`X`\>(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`X`, `E`\>

#### Type parameters

• **X**

#### Parameters

• **f**

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`X`, `E`\>

#### Source

[result-async.ts:86](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L86)

***

### mapErr()

> **mapErr**\<`U`\>(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `U`\>

#### Type parameters

• **U**

#### Parameters

• **f**

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `U`\>

#### Source

[result-async.ts:76](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L76)

***

### match()

> **match**\<`X`\>(`ok`, `_err`): `Promise`\<`X`\>

#### Type parameters

• **X**

#### Parameters

• **ok**

• **\_err**

#### Returns

`Promise`\<`X`\>

#### Source

[result-async.ts:121](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L121)

***

### safeUnwrap()

> **safeUnwrap**(): `AsyncGenerator`\<[`Result`](../wiki/Class.Result)\<`never`, `E`\>, `T`, `unknown`\>

Emulates Rust's `?` operator in `safeTry`'s body. See also `safeTry`.

#### Returns

`AsyncGenerator`\<[`Result`](../wiki/Class.Result)\<`never`, `E`\>, `T`, `unknown`\>

#### Source

[result-async.ts:146](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L146)

***

### tap()

> **tap**(`f`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Parameters

• **f**

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Source

[result-async.ts:125](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L125)

***

### then()

> **then**\<`A`, `B`\>(`successCallback`?, `failureCallback`?): `PromiseLike`\<`A` \| `B`\>

#### Type parameters

• **A**

• **B**

#### Parameters

• **successCallback?**

• **failureCallback?**

#### Returns

`PromiseLike`\<`A` \| `B`\>

#### Implementation of

`PromiseLike.then`

#### Source

[result-async.ts:69](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L69)

***

### combine()

#### combine(asyncResultList)

> **`static`** **combine**\<`T`\>(`asyncResultList`): [`CombineResultAsyncs`](../wiki/Type.CombineResultAsyncs)\<`T`\>

##### Type parameters

• **T** extends readonly [[`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>, [`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>]

##### Parameters

• **asyncResultList**: `T`

##### Returns

[`CombineResultAsyncs`](../wiki/Type.CombineResultAsyncs)\<`T`\>

##### Source

[result-async.ts:37](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L37)

#### combine(asyncResultList)

> **`static`** **combine**\<`T`\>(`asyncResultList`): [`CombineResultAsyncs`](../wiki/Type.CombineResultAsyncs)\<`T`\>

##### Type parameters

• **T** extends readonly [`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>[]

##### Parameters

• **asyncResultList**: `T`

##### Returns

[`CombineResultAsyncs`](../wiki/Type.CombineResultAsyncs)\<`T`\>

##### Source

[result-async.ts:40](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L40)

***

### combineWithAllErrors()

#### combineWithAllErrors(asyncResultList)

> **`static`** **combineWithAllErrors**\<`T`\>(`asyncResultList`): [`CombineResultsWithAllErrorsArrayAsync`](../wiki/Type.CombineResultsWithAllErrorsArrayAsync)\<`T`\>

##### Type parameters

• **T** extends readonly [[`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>, [`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>]

##### Parameters

• **asyncResultList**: `T`

##### Returns

[`CombineResultsWithAllErrorsArrayAsync`](../wiki/Type.CombineResultsWithAllErrorsArrayAsync)\<`T`\>

##### Source

[result-async.ts:49](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L49)

#### combineWithAllErrors(asyncResultList)

> **`static`** **combineWithAllErrors**\<`T`\>(`asyncResultList`): [`CombineResultsWithAllErrorsArrayAsync`](../wiki/Type.CombineResultsWithAllErrorsArrayAsync)\<`T`\>

##### Type parameters

• **T** extends readonly [`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>[]

##### Parameters

• **asyncResultList**: `T`

##### Returns

[`CombineResultsWithAllErrorsArrayAsync`](../wiki/Type.CombineResultsWithAllErrorsArrayAsync)\<`T`\>

##### Source

[result-async.ts:52](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L52)

***

### fromPromise()

> **`static`** **fromPromise**\<`T`, `E`\>(`promise`, `errorFn`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Type parameters

• **T**

• **E**

#### Parameters

• **promise**: `PromiseLike`\<`T`\>

• **errorFn**

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Source

[result-async.ts:28](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L28)

***

### fromSafePromise()

> **`static`** **fromSafePromise**\<`T`, `E`\>(`promise`): [`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Type parameters

• **T**

• **E** = `never`

#### Parameters

• **promise**: `PromiseLike`\<`T`\>

#### Returns

[`ResultAsync`](../wiki/Class.ResultAsync)\<`T`, `E`\>

#### Source

[result-async.ts:20](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L20)
