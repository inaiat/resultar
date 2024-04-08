[resultar](../wiki/Home) / CombineResultAsyncs

# Type alias: CombineResultAsyncs\<T\>

> **CombineResultAsyncs**\<`T`\>: `IsLiteralArray`\<`T`\> extends `1` ? `TraverseAsync`\<`UnwrapAsync`\<`T`\>\> : [`ResultAsync`](../wiki/Class.ResultAsync)\<`ExtractOkAsyncTypes`\<`T`\>, `ExtractErrAsyncTypes`\<`T`\>\[`number`\]\>

## Type parameters

• **T** extends `ReadonlyArray`\<[`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>\>

## Source

[result-async.ts:206](https://github.com/inaiat/resultar/blob/6bdf9a02220a7cdf3ada422bc826a1ae3bdd86e8/src/result-async.ts#L206)
