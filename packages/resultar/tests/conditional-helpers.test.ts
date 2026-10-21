import { equal } from 'node:assert'

import { describe, expectTypeOf, it } from 'vite-plus/test'

import { Result, ResultAsync, err, errAsync, ok, okAsync, pipe } from '../src/index.js'

describe('Result conditional helpers', () => {
  it('runs the true branch for Result.if', () => {
    const result = Result.if(true, {
      onTrue: () => ok<string, string>('true'),
      onFalse: () => ok<string, string>('false'),
    })

    equal(result._unsafeUnwrap(), 'true')
  })

  it('runs the false branch for Result.if and does not call the skipped branch', () => {
    let trueCalls = 0
    let falseCalls = 0

    const result = Result.if(() => false, {
      onTrue: () => {
        trueCalls += 1
        return ok<string, string>('true')
      },
      onFalse: () => {
        falseCalls += 1
        return ok<string, string>('false')
      },
    })

    equal(result._unsafeUnwrap(), 'false')
    equal(trueCalls, 0)
    equal(falseCalls, 1)
  })

  it('short-circuits Result.if when the Result condition is Err', () => {
    let calls = 0

    const result = Result.if(err<boolean, string>('condition failed'), {
      onTrue: () => {
        calls += 1
        return ok<number, string>(1)
      },
      onFalse: () => {
        calls += 1
        return ok<number, string>(2)
      },
    })

    equal(result._unsafeUnwrapErr(), 'condition failed')
    equal(calls, 0)
  })

  it('runs Result.if when the Result condition is Ok', () => {
    const trueResult = Result.if(ok<boolean, string>(true), {
      onTrue: () => ok<number, string>(1),
      onFalse: () => ok<number, string>(2),
    })
    const falseResult = Result.if(ok<boolean, string>(false), {
      onTrue: () => ok<number, string>(1),
      onFalse: () => ok<number, string>(2),
    })

    equal(trueResult._unsafeUnwrap(), 1)
    equal(falseResult._unsafeUnwrap(), 2)
  })

  it('executes and skips Result.when with Ok(undefined) for skipped branches', () => {
    let calls = 0

    const executed = Result.when(true, () => {
      calls += 1
      return ok<number, string>(1)
    })
    const skipped = Result.when(false, () => {
      calls += 1
      return ok<number, string>(2)
    })

    equal(executed._unsafeUnwrap(), 1)
    equal(skipped._unsafeUnwrap(), undefined)
    equal(calls, 1)
  })

  it('executes and skips Result.unless with Ok(undefined) for skipped branches', () => {
    let calls = 0

    const executed = Result.unless(false, () => {
      calls += 1
      return ok<number, string>(1)
    })
    const skipped = Result.unless(true, () => {
      calls += 1
      return ok<number, string>(2)
    })

    equal(executed._unsafeUnwrap(), 1)
    equal(skipped._unsafeUnwrap(), undefined)
    equal(calls, 1)
  })

  it('evaluates lazy Result.when and Result.unless conditions', () => {
    let conditionCalls = 0
    let bodyCalls = 0

    const whenExecuted = Result.when(
      () => {
        conditionCalls += 1
        return true
      },
      () => {
        bodyCalls += 1
        return ok<number, string>(1)
      },
    )
    const whenSkipped = Result.when(
      () => {
        conditionCalls += 1
        return false
      },
      () => {
        bodyCalls += 1
        return ok<number, string>(2)
      },
    )
    const unlessExecuted = Result.unless(
      () => {
        conditionCalls += 1
        return false
      },
      () => {
        bodyCalls += 1
        return ok<number, string>(3)
      },
    )
    const unlessSkipped = Result.unless(
      () => {
        conditionCalls += 1
        return true
      },
      () => {
        bodyCalls += 1
        return ok<number, string>(4)
      },
    )

    equal(whenExecuted._unsafeUnwrap(), 1)
    equal(whenSkipped._unsafeUnwrap(), undefined)
    equal(unlessExecuted._unsafeUnwrap(), 3)
    equal(unlessSkipped._unsafeUnwrap(), undefined)
    equal(conditionCalls, 4)
    equal(bodyCalls, 2)
  })

  it('short-circuits Result.whenResult and Result.unlessResult on condition Err', () => {
    let calls = 0
    const body = (): Result<number, string> => {
      calls += 1
      return ok(1)
    }

    const when = Result.whenResult(err<boolean, string>('when failed'), body)
    const unless = Result.unlessResult(err<boolean, string>('unless failed'), body)

    equal(when._unsafeUnwrapErr(), 'when failed')
    equal(unless._unsafeUnwrapErr(), 'unless failed')
    equal(calls, 0)
  })

  it('runs and skips Result.whenResult and Result.unlessResult with Ok conditions', () => {
    const whenExecuted = Result.whenResult(ok<boolean, string>(true), () => ok<number, string>(1))
    const whenSkipped = Result.whenResult(ok<boolean, string>(false), () => ok<number, string>(2))
    const unlessExecuted = Result.unlessResult(ok<boolean, string>(false), () =>
      ok<number, string>(3),
    )
    const unlessSkipped = Result.unlessResult(ok<boolean, string>(true), () =>
      ok<number, string>(4),
    )

    equal(whenExecuted._unsafeUnwrap(), 1)
    equal(whenSkipped._unsafeUnwrap(), undefined)
    equal(unlessExecuted._unsafeUnwrap(), 3)
    equal(unlessSkipped._unsafeUnwrap(), undefined)
  })

  it('infers sync conditional helper result types', () => {
    const conditional = Result.if(err<boolean, 'condition-error'>('condition-error'), {
      onTrue: () => ok<number, 'true-error'>(1),
      onFalse: () => err<string, 'false-error'>('false-error'),
    })
    const when = Result.when(true, () => ok<number, 'body-error'>(1))
    const whenCondition = Result.whenResult(
      err<boolean, 'condition-error'>('condition-error'),
      () => ok<number, 'body-error'>(1),
    )

    expectTypeOf(conditional).toEqualTypeOf<
      Result<number | string, 'condition-error' | 'true-error' | 'false-error'>
    >()
    expectTypeOf(when).toEqualTypeOf<Result<number | undefined, 'body-error'>>()
    expectTypeOf(whenCondition).toEqualTypeOf<
      Result<number | undefined, 'condition-error' | 'body-error'>
    >()
  })

  it('supports Result conditions, direct bodies, curried pipe forms, and instance .when/.unless in Result', () => {
    const directWhen = Result.when(() => ok<boolean, 'cond-err'>(true), ok<number, 'body-err'>(42))
    const curriedUnless = pipe(
      ok<number, 'body-err'>(7),
      Result.unless(ok<boolean, 'cond-err'>(true)),
    )
    const instanceWhen = ok<number, 'body-err'>(10).when(err<boolean, 'cond-err'>('cond-err'))
    const instanceUnless = ok<number, 'body-err'>(10).unless(() => false)

    equal(directWhen._unsafeUnwrap(), 42)
    equal(curriedUnless._unsafeUnwrap(), undefined)
    equal(instanceWhen._unsafeUnwrapErr(), 'cond-err')
    equal(instanceUnless._unsafeUnwrap(), 10)

    expectTypeOf(directWhen).toEqualTypeOf<Result<number | undefined, 'cond-err' | 'body-err'>>()
    expectTypeOf(curriedUnless).toEqualTypeOf<Result<number | undefined, 'cond-err' | 'body-err'>>()
    expectTypeOf(instanceWhen).toEqualTypeOf<Result<number | undefined, 'cond-err' | 'body-err'>>()
    expectTypeOf(instanceUnless).toEqualTypeOf<Result<number | undefined, 'body-err'>>()
  })
})

describe('ResultAsync conditional helpers', () => {
  it('runs ResultAsync.if true branch and normalizes sync Result branches', async () => {
    const result = await ResultAsync.if(true, {
      onTrue: () => ok<number, string>(1),
      onFalse: () => okAsync<number, string>(2),
    })

    equal(result._unsafeUnwrap(), 1)
  })

  it('runs ResultAsync.if false branch and does not call the skipped branch', async () => {
    let trueCalls = 0
    let falseCalls = 0

    const result = await ResultAsync.if(() => false, {
      onTrue: () => {
        trueCalls += 1
        return okAsync<string, string>('true')
      },
      onFalse: () => {
        falseCalls += 1
        return ok<string, string>('false')
      },
    })

    equal(result._unsafeUnwrap(), 'false')
    equal(trueCalls, 0)
    equal(falseCalls, 1)
  })

  it('short-circuits ResultAsync.if when the ResultAsync condition is Err', async () => {
    let calls = 0

    const result = await ResultAsync.if(errAsync<boolean, string>('condition failed'), {
      onTrue: () => {
        calls += 1
        return okAsync<number, string>(1)
      },
      onFalse: () => {
        calls += 1
        return ok<number, string>(2)
      },
    })

    equal(result._unsafeUnwrapErr(), 'condition failed')
    equal(calls, 0)
  })

  it('runs ResultAsync.if when the ResultAsync condition is Ok', async () => {
    const trueResult = await ResultAsync.if(okAsync<boolean, string>(true), {
      onTrue: () => okAsync<number, string>(1),
      onFalse: () => ok<number, string>(2),
    })
    const falseResult = await ResultAsync.if(okAsync<boolean, string>(false), {
      onTrue: () => okAsync<number, string>(1),
      onFalse: () => ok<number, string>(2),
    })

    equal(trueResult._unsafeUnwrap(), 1)
    equal(falseResult._unsafeUnwrap(), 2)
  })

  it('executes and skips ResultAsync.when with Ok(undefined) for skipped branches', async () => {
    let calls = 0

    const executed = await ResultAsync.when(true, () => {
      calls += 1
      return okAsync<number, string>(1)
    })
    const skipped = await ResultAsync.when(false, () => {
      calls += 1
      return ok<number, string>(2)
    })

    equal(executed._unsafeUnwrap(), 1)
    equal(skipped._unsafeUnwrap(), undefined)
    equal(calls, 1)
  })

  it('executes and skips ResultAsync.unless with Ok(undefined) for skipped branches', async () => {
    let calls = 0

    const executed = await ResultAsync.unless(false, () => {
      calls += 1
      return ok<number, string>(1)
    })
    const skipped = await ResultAsync.unless(true, () => {
      calls += 1
      return okAsync<number, string>(2)
    })

    equal(executed._unsafeUnwrap(), 1)
    equal(skipped._unsafeUnwrap(), undefined)
    equal(calls, 1)
  })

  it('short-circuits ResultAsync.whenResult and ResultAsync.unlessResult on condition Err', async () => {
    let calls = 0
    const body = (): ResultAsync<number, string> => {
      calls += 1
      return okAsync(1)
    }

    const when = await ResultAsync.whenResult(errAsync<boolean, string>('when failed'), body)
    const unless = await ResultAsync.unlessResult(err<boolean, string>('unless failed'), body)

    equal(when._unsafeUnwrapErr(), 'when failed')
    equal(unless._unsafeUnwrapErr(), 'unless failed')
    equal(calls, 0)
  })

  it('runs and skips ResultAsync.whenResult and ResultAsync.unlessResult with Ok conditions', async () => {
    const whenExecuted = await ResultAsync.whenResult(okAsync<boolean, string>(true), () =>
      okAsync<number, string>(1),
    )
    const whenSkipped = await ResultAsync.whenResult(okAsync<boolean, string>(false), () =>
      ok<number, string>(2),
    )
    const unlessExecuted = await ResultAsync.unlessResult(okAsync<boolean, string>(false), () =>
      okAsync<number, string>(3),
    )
    const unlessSkipped = await ResultAsync.unlessResult(okAsync<boolean, string>(true), () =>
      ok<number, string>(4),
    )

    equal(whenExecuted._unsafeUnwrap(), 1)
    equal(whenSkipped._unsafeUnwrap(), undefined)
    equal(unlessExecuted._unsafeUnwrap(), 3)
    equal(unlessSkipped._unsafeUnwrap(), undefined)
  })

  it('infers async conditional helper result types', () => {
    const conditional = ResultAsync.if(errAsync<boolean, 'condition-error'>('condition-error'), {
      onTrue: () => ok<number, 'true-error'>(1),
      onFalse: () => errAsync<string, 'false-error'>('false-error'),
    })
    const when = ResultAsync.when(true, () => ok<number, 'body-error'>(1))
    const whenCondition = ResultAsync.whenResult(
      errAsync<boolean, 'condition-error'>('condition-error'),
      () => okAsync<number, 'body-error'>(1),
    )

    expectTypeOf(conditional).toEqualTypeOf<
      ResultAsync<number | string, 'condition-error' | 'true-error' | 'false-error'>
    >()
    expectTypeOf(when).toEqualTypeOf<ResultAsync<number | undefined, 'body-error'>>()
    expectTypeOf(whenCondition).toEqualTypeOf<
      ResultAsync<number | undefined, 'condition-error' | 'body-error'>
    >()
  })

  it('supports Result/ResultAsync conditions, direct bodies, curried pipe forms, and instance .when/.unless in ResultAsync', async () => {
    const directWhen = ResultAsync.when(
      () => okAsync<boolean, 'cond-err'>(true),
      ok<number, 'body-err'>(42),
    )
    const curriedUnless = pipe(
      okAsync<number, 'body-err'>(7),
      ResultAsync.unless(ok<boolean, 'cond-err'>(true)),
    )
    const instanceWhen = okAsync<number, 'body-err'>(10).when(
      errAsync<boolean, 'cond-err'>('cond-err'),
    )
    const instanceUnless = okAsync<number, 'body-err'>(10).unless(() => false)

    equal((await directWhen)._unsafeUnwrap(), 42)
    equal((await curriedUnless)._unsafeUnwrap(), undefined)
    equal((await instanceWhen)._unsafeUnwrapErr(), 'cond-err')
    equal((await instanceUnless)._unsafeUnwrap(), 10)

    expectTypeOf(directWhen).toEqualTypeOf<
      ResultAsync<number | undefined, 'cond-err' | 'body-err'>
    >()
    expectTypeOf(curriedUnless).toEqualTypeOf<
      ResultAsync<number | undefined, 'cond-err' | 'body-err'>
    >()
    expectTypeOf(instanceWhen).toEqualTypeOf<
      ResultAsync<number | undefined, 'cond-err' | 'body-err'>
    >()
    expectTypeOf(instanceUnless).toEqualTypeOf<ResultAsync<number | undefined, 'body-err'>>()
  })
})
