[resultar](../wiki/Home) / safeTry

# Function: safeTry()

## safeTry(body)

> **safeTry**\<`T`, `E`\>(`body`): [`Result`](../wiki/Class.Result)\<`T`, `E`\>

Evaluates the given generator to a Result returned or an Err yielded from it,
whichever comes first.

This function, in combination with `Result.safeUnwrap()`, is intended to emulate
Rust's ? operator.
See `/tests/safeTry.test.ts` for examples.

### Type parameters

• **T**

• **E**

### Parameters

• **body**

What is evaluated. In body, `yield* result.safeUnwrap()` works as
Rust's `result?` expression.

### Returns

[`Result`](../wiki/Class.Result)\<`T`, `E`\>

The first occurence of either an yielded Err or a returned Result.

### Source

[result.ts:444](https://github.com/inaiat/resultar/blob/6bdf9a02220a7cdf3ada422bc826a1ae3bdd86e8/src/result.ts#L444)

## safeTry(body)

> **safeTry**\<`T`, `E`\>(`body`): `Promise`\<[`Result`](../wiki/Class.Result)\<`T`, `E`\>\>

Evaluates the given generator to a Result returned or an Err yielded from it,
whichever comes first.

This function, in combination with `Result.safeUnwrap()`, is intended to emulate
Rust's ? operator.
See `/tests/safeTry.test.ts` for examples.

### Type parameters

• **T**

• **E**

### Parameters

• **body**

What is evaluated. In body, `yield* result.safeUnwrap()` and
`yield* resultAsync.safeUnwrap()` work as Rust's `result?` expression.

### Returns

`Promise`\<[`Result`](../wiki/Class.Result)\<`T`, `E`\>\>

The first occurence of either an yielded Err or a returned Result.

### Source

[result.ts:460](https://github.com/inaiat/resultar/blob/6bdf9a02220a7cdf3ada422bc826a1ae3bdd86e8/src/result.ts#L460)
