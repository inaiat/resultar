[resultar](../wiki/Home) / DisposableResult

# Class: DisposableResult\<T, E\>

A `Disposable` is an object that has a `dispose` method that can be used to
clean up resources.

## Type parameters

• **T**

• **E**

## Implements

- `Resultable`\<`T`, `E`\>
- `Disposable`

## Constructors

### new DisposableResult(result, finalizer)

> **new DisposableResult**\<`T`, `E`\>(`result`, `finalizer`): [`DisposableResult`](../wiki/Class.DisposableResult)\<`T`, `E`\>

#### Parameters

• **result**: `Resultable`\<`T`, `E`\>

• **finalizer**

#### Returns

[`DisposableResult`](../wiki/Class.DisposableResult)\<`T`, `E`\>

#### Source

[result.ts:389](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L389)

## Properties

### finalizer()

> **`private`** **`readonly`** **finalizer**: (`value`, `error`) => `void`

#### Parameters

• **value**: `T`

• **error**: `E`

#### Returns

`void`

#### Source

[result.ts:390](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L390)

***

### result

> **`readonly`** **result**: `Resultable`\<`T`, `E`\>

#### Source

[result.ts:389](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L389)

## Accessors

### error

> **`get`** **error**(): `E`

#### Returns

`E`

#### Source

[result.ts:396](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L396)

***

### value

> **`get`** **value**(): `T`

#### Returns

`T`

#### Source

[result.ts:392](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L392)

## Methods

### `[dispose]`()

> **[dispose]**(): `void`

#### Returns

`void`

#### Implementation of

`Disposable.[dispose]`

#### Source

[result.ts:420](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L420)

***

### \_unsafeUnwrap()

> **\_unsafeUnwrap**(`config`?): `T`

#### Parameters

• **config?**: `ErrorConfig`

#### Returns

`T`

#### Implementation of

`Resultable._unsafeUnwrap`

#### Source

[result.ts:400](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L400)

***

### \_unsafeUnwrapErr()

> **\_unsafeUnwrapErr**(`config`?): `E`

#### Parameters

• **config?**: `ErrorConfig`

#### Returns

`E`

#### Implementation of

`Resultable._unsafeUnwrapErr`

#### Source

[result.ts:404](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L404)

***

### isErr()

> **isErr**(): `boolean`

#### Returns

`boolean`

#### Implementation of

`Resultable.isErr`

#### Source

[result.ts:412](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L412)

***

### isOk()

> **isOk**(): `boolean`

#### Returns

`boolean`

#### Implementation of

`Resultable.isOk`

#### Source

[result.ts:408](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L408)

***

### unwrapOr()

> **unwrapOr**\<`A`\>(`defaultValue`): `T` \| `A`

#### Type parameters

• **A**

#### Parameters

• **defaultValue**: `A`

#### Returns

`T` \| `A`

#### Implementation of

`Resultable.unwrapOr`

#### Source

[result.ts:416](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result.ts#L416)
