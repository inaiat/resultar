[resultar](../wiki/Home) / CombineResultsWithAllErrorsArrayAsync

# Type alias: CombineResultsWithAllErrorsArrayAsync\<T\>

> **CombineResultsWithAllErrorsArrayAsync**\<`T`\>: `IsLiteralArray`\<`T`\> extends `1` ? `TraverseWithAllErrorsAsync`\<`UnwrapAsync`\<`T`\>\> : [`ResultAsync`](../wiki/Class.ResultAsync)\<`ExtractOkAsyncTypes`\<`T`\>, `ExtractErrAsyncTypes`\<`T`\>\[`number`\][]\>

## Type parameters

• **T** extends `ReadonlyArray`\<[`ResultAsync`](../wiki/Class.ResultAsync)\<`unknown`, `unknown`\>\>

## Source

[result-async.ts:213](https://github.com/inaiat/resultar/blob/6bdf9a02220a7cdf3ada422bc826a1ae3bdd86e8/src/result-async.ts#L213)
