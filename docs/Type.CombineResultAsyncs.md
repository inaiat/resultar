[resultar](../wiki/Home) / CombineResultAsyncs

# Type alias: CombineResultAsyncs\<T\>

> **CombineResultAsyncs**\<`T`\>: `IsLiteralArray`\<`T`\> extends `1` ? `TraverseAsync`\<`UnwrapAsync`\<`T`\>\> : [`ResultAsync`](../wiki/Class.ResultAsync)\<`ExtractOkAsyncTypes`\<`T`\>, `ExtractErrAsyncTypes`\<`T`\>\[`number`\]\>

## Type parameters

• **T** extends `ReadonlyArray`\<[`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>\>

## Source

[result-async.ts:206](https://github.com/inaiat/resultar/blob/e9d397e3e0e8543e675ebf3b04ec4ad2e5577c52/src/result-async.ts#L206)
