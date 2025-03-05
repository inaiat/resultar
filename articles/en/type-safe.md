# TypeScript Type-safe: Transforming Exceptions into Values with Resultar [Resultar](https://github.com/inaiat/resultar)

## The Problem with Exceptions in JavaScript

JavaScript, like many dynamic languages, allows exceptions to be thrown at virtually any point in the code. This behavior, while flexible, can create several problems:

   - Uncontrolled Exceptions
   - Unexpected crashes in production
   - Confusing stack traces
   - Difficult error origin tracking

Let's examine some of the problems mentioned above:

### 1. Swallowing Errors:
Silent errors can hide bugs and make debugging difficult. Additionally, they can hide important information about the cause of the failure.
```javascript
function parseJSONSafe(jsonString: string) {
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        return null; // Error disappears and we lose debugging information
    }
}

const result = parseJSONSafe("{ invalid json }");
console.log(result); // null (but we don't know why it failed)
```

### 2. Unhandled Promises
Unhandled promises are still a source of many problems today, though we can minimize them with proper linting tools.
```typescript
// ❌ Problem: Try/catch doesn't capture promise rejections
try {
    Promise.reject(new Error('Failure'));
    // Code continues executing...
    console.log('Got here!');
} catch (error) {
    // Never reaches here!
    console.error('Error:', error);
}
```

### 3. Asynchronous Callbacks
```typescript
// ❌ Problem: Try/catch doesn't work with callbacks
try {
    setTimeout(() => {
        throw new Error('Callback error');
    }, 1000);
} catch (error) {
    // Never catches the error!
    console.error('Error:', error);
}
```

### 4. Nested Try/Catch

```typescript
type HttpError =
     | { type: 'Http Client Error', value: number }
     | { type: 'Infra Error', value: string}
     | { type: 'Json parser Error', value: string}

class HttpErrorHandler extends Error {
    constructor(readonly httpError: HttpError) {
        super(JSON.stringify(httpError))
    }
}

// ❌ Problem: Nested try/catch blocks
const getPosts = async (url: string) => {
    try {
        const response = await fetch(url)
        if (response.status>=400) {
            // HTTP client error handling
            throw new HttpErrorHandler({type:'Http Client Error', value: response.status})
        }
        try {
            const data = await response.json() as Comments
            return data
        } catch (error) {
            // JSON parsing error handling
            throw new HttpErrorHandler({type:'Json parser Error', value: `${error}`})
        }
    } catch (error) {
      // Outer catch - Can capture unexpected errors
      // This outer catch masks the HTTP client error, for example,
      // if a bad request occurs (Http Client Error), the returned error
      // will be an infrastructure error
        throw new HttpErrorHandler({type:'Infra Error', value: `${error}`})
    }
}
```

### 5. Inconsistent Null Handling
```typescript
// ❌ Problem: Mixing null checks with try/catch
function processData(data: any) {
    try {
        if (!data) return null;

        if (!data.user) {
            throw new Error('User not found');
        }

        if (!data.user.profile) {
            return null; // Why not throw?
        }

        return data.user.profile.preferences;
    } catch (error) {
        return null; // We lose the original error
    }
}
```

These examples show common situations where traditional try/catch can lead to fragile, hard-to-maintain, and error-prone code. Resultar offers a more structured and safer approach to handle these scenarios.

## [Resultar](https://github.com/inaiat/resultar)

While searching the internet for efficient and secure solutions, I found a library called [Neverthrow](https://github.com/supermacro/neverthrow). I was already familiar with error handling using Rust (Result Pattern) and Golang (error handling). This library implemented an error handling pattern similar to Rust, following the concept of Railway Oriented Programming, where execution flow is treated as a pipe that chains operations safely, keeping success and error paths separate. With this, I could use this robust pattern in TypeScript/JavaScript, bringing the same type guarantees and error handling we find in Rust.

After using Neverthrow for a few months, I decided to fork the library and implement additional features I wanted, such as file closing using dispose, logs, and some specific conditions for my needs, while maintaining compatibility with Neverthrow. Until then, I was interested in the functional part of error handling, but I decided to expand to include other programming paradigms.

Let's start with a fully functional paradigm:

```javascript
const safeFetch = fromThrowableAsync(fetch, String);
    safeFetch("https://jsonplaceholder.typicode.com/posts")
        .map((r) => r.json() as Promise<Posts>)
        .map((posts) => posts.at(-1)?.userId)
        .andThen((id) =>
            id ? safeFetch(`https://jsonplaceholder.typicode.com/posts/${id}/comments`) : err('No posts found')
        )
        .map((comments) => comments.json() as Promise<Comments>)
        .match((comments) => console.log(comments),
            (e) => console.error("Error retrieving comments", e)
        )
```

I find this code elegant and efficient as it uses the Result Pattern, which makes the code easier to read and maintain. It's an extremely safe and efficient code that uses a functional pattern to handle errors.
You see, I love functional languages! However, I noticed that people coming from imperative languages often don't like dealing with errors functionally. This is because they're used to handling errors imperatively, where code is executed sequentially and flow control is easier to understand.

Let's rewrite the same code following a more imperative pattern, using error propagation and/or Rust's ? operator using Resultar/Neverthrow's **safeTry**.

```javascript
const { value, error } = await safeTry(async function* () {
  const reqPosts = yield* tryCatchAsync(
      fetch(`https://jsonplaceholder.typicode.com/posts`),
      String,
  );
  const posts = yield* tryCatchAsync(reqPosts.json() as Promise<Posts>);

  const lastPost = posts.at(-1)?.userId;
  if (!lastPost) {
      return err("No posts found");
  }
  const reqComments = yield* tryCatchAsync(
      fetch(`https://jsonplaceholder.typicode.com/posts/${lastPost}/comments`),
      String,
  );
  const comments = yield* tryCatchAsync(
      reqComments.json() as Promise<Comments>,
  );
  return ok(comments);
});
if (value) {
  console.log(value)
} else {
  console.log("Error retrieving comments", error)
}
```

Okay, this approach is simpler to read and easier to understand for those not familiar with functional code, yet it's still efficient and secure as all blocks that can throw exceptions are handled consistently.

Now let's look at a completely imperative approach that's very similar to Golang's error handling.

```javascript
const { value: reqPosts, error: reqPostError } = await tryCatchAsync(
    fetch(`https://jsonplaceholder.typicode.com/posts`),
    String,
);
if (reqPostError) {
    return errAsync(reqPostError);
}

const { value: posts, error: postParserError } = await tryCatchAsync(
    reqPosts.json() as Promise<Posts>,
    String,
);
if (postParserError) {
    return errAsync(postParserError);
}

const lastPost = posts.at(-1)?.userId;
if (!lastPost) {
    return errAsync("No posts found");
}

const { value: reqComments, error: reqCommentsError } = await tryCatchAsync(
    fetch(`https://jsonplaceholder.typicode.com/posts/${lastPost}/comments`),
    String,
);
if (reqCommentsError) {
    return errAsync(reqCommentsError);
}

const { value, error } = await tryCatchAsync(
    reqComments.json() as Promise<Comments>,
    String,
);
if (error) {
    return errAsync(error);
}
return okAsync(value);
```

The code remains secure because we're handling all possible exceptions that can occur during code execution with Resultar's **tryCatch**.

I asked ChatGPT 3.5 to compare the 3 examples and put them in a table to compare the results.

## Comparative Analysis

### 1. Imperative Style
- ✅ Explicit validations
- ✅ Easy to understand flow
- ✅ Specific error messages
- ❌ More verbose code
- ❌ Multiple exit points (returns)
- ❌ Can lead to lots of boilerplate code

### 2. SafeTry
- ✅ Concise code
- ✅ Easy to implement
- ✅ Good for simple cases
- ❌ Less control over validations
- ❌ Can mask specific errors

### 3. Functional Approach
- ✅ Elegant composition
- ✅ Type-safe
- ✅ Granular validations
- ✅ Easy to extend
- ❌ Requires functional programming knowledge
- ❌ Initial learning curve

Well, having said that, you're free to choose the programming style that best suits your needs. Each approach has its advantages and disadvantages, and it's important to choose the one that best fits your specific project and development team. The important thing is that you know how to handle errors and exceptions safely and efficiently. The idea of forking **neverthrow** was precisely to have more flexibility in programming style.

To finish, let's look at some examples of how simple it is to make code safer using **Resultar**.

### 1. Swallowing Errors

```typescript
// ❌ Problem: Try/catch doesn't capture promise rejections
function parseJSONSafe(jsonString: string) {
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        return null; // Error disappears and we lose debugging information
    }
}

// ✅ Resultar
// The output is { value: undefined, error: Error('Failure') }
// You are forced to handle the result of the tryCatch function
const { value, error } = Result.tryCatch(() => JSON.parse("{'a'}"), () => 'parser error')
assert.equal(error, 'parser error')
```

### 2. Unhandled Promises
```javascript
// ❌ Problem: Unhandled promises can cause security issues
try {
  Promise.reject(new Error('Failure'));
  // Code continues executing...
  console.log('Should not get here!');
} catch (error) {
  // Never reaches here!
  console.error('Error:', error);
}

// ✅ Resultar
const result = await tryCatchAsync(
        Promise.reject(new Error('Failure')), String
    );
assert.ok(result.isErr())
```

### 3. Asynchronous Callbacks
```javascript
try {
    setTimeout(() => {
        throw new Error('Callback error');
    }, 1000);
} catch (error) {
    // Never catches the error!
    console.error('Error:', error);
}

// ✅ Resultar
const result = await tryCatchAsync(
    new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Callback error'));
        }, 1000);
    })
);
assert.ok(result.isErr())
```

### 4. Nested Try/Catch

Given this test:
```javascript
type HttpError =
     | { type: 'Http Client Error', value: number }
     | { type: 'Infra Error', value: string}
     | { type: 'Json parser Error', value: string}

class HttpErrorHandler extends Error {
    constructor(readonly httpError: HttpError) {
        super(JSON.stringify(httpError))
    }
}

const getPosts = async (url: string) => {
  try {
      const response = await fetch(url)
      if (response.status>=400) {
          throw new HttpErrorHandler({type:'Http Client Error', value: response.status})
      }
      try {
          const data = await response.json() as Comments
          return data
      } catch (error) {
          throw new HttpErrorHandler({type:'Json parser Error', value: `${error}`})
      }
  } catch (error) {
      throw new HttpErrorHandler({type:'Infra Error', value: `${error}`})
  }
}

try {
  const posts = await getPosts("https://httpbin.org/status/400")
  console.log(posts)
} catch (error) {
  if (error instanceof HttpErrorHandler) {
      assert.ok(error.httpError.type==='Http Client Error')
      assert.equal(error.httpError.value, 400)
  }
}
```

This test will always fail because the thrown error will always be an infrastructure error, as the error is masked by the outer catch. Let's modify the code for a more type-safe approach:

```javascript
const safeGetPosts = (url: string) => tryCatchAsync(fetch(url))
  .mapErr(e => ({ type: 'Infra Error', value: `${e}` } satisfies HttpError))
  .andThen(r => {
      if (r.status >= 400) {
          return err({
              type: 'Http Client Error', value: r.status
          } satisfies HttpError)
      }
      return ok(r)
  })
  .andThen(r => tryCatchAsync(r.json() as Promise<Posts>, e => ({ type: 'Json parser Error', value: `${e}` } satisfies HttpError)))
const result = await safeGetPosts("https://httpbin.org/status/400")
assert.ok(result.isErr())
assert.ok(result.error.type === 'Http Client Error')
assert.equal(result.error.value, 400)
```

The Result Pattern not only makes the code more testable and predictable but also offers stronger guarantees in test assertions. In the example, assert.equal(e.value, 400) passed successfully, confirming that Result correctly captured and transported the HTTP 400 error, demonstrating how Result's typed structure maintains data integrity throughout the entire chain of operations up to the test point.

It's still possible to use error-propagation (a.k.a Rust's ? operator) to propagate infrastructure errors to the outermost level of the code, ensuring that all errors are handled consistently and predictably. I believe this way is even easier to understand for developers not familiar with Railway Programming.

```javascript
const safeGetPosts = (url: string) => safeTry(async function* () {
    const response = yield* tryCatchAsync(fetch(url), e=> ({ type: 'Infra Error', value: `${e}` } satisfies HttpError))
    if (response.status >= 400) {
        return err({ type: 'Http Client Error', value: response.status } satisfies HttpError)
    }
    return tryCatchAsync(response.json() as Promise<Posts>, e => ({ type: 'Json parser Error', value: `${e}` } satisfies HttpError))
})
const { error } = await safeGetPosts("https://httpbin.org/status/400")
assert.ok(error.type === 'Http Client Error')
assert.ok(error.value === 400)
```

To summarize the main advantages of the Result Pattern:

1. **Type Safety**:
- Explicit contracts via types
- Errors are treated as ***first-class values*** (values that can be manipulated, passed, and transformed like any other data in the system)
- Compile-time guarantees
- No implicit undefined/null

2. **Error Handling**:
- Mandatory error handling
- Expressive pattern matching
- Type-safe error transformations
- Precise error tracking

3. **Composability**:
- Fluent chaining
- Functional transformations
- Operation combination
- Railway oriented programming

## References

### Articles and Documentation
- [Railway Oriented Programming](https://fsharpforfunandprofit.com/rop/) - Scott Wlaschin
- [Rust Error Handling](https://doc.rust-lang.org/book/ch09-00-error-handling.html) - Official Rust Documentation
- [Error Handling in Go](https://go.dev/blog/error-handling-and-go) - Official Go Documentation
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) - Official TypeScript Documentation

### Libraries
- [Resultar](https://github.com/inaiat/resultar) - Type-safe error handling library for TypeScript
- [Neverthrow](https://github.com/supermacro/neverthrow) - Base library that inspired Resultar

### Examples and APIs Used
- [JSONPlaceholder](https://jsonplaceholder.typicode.com/) - Test API used in examples
- [HTTPBin](https://httpbin.org/) - HTTP test service used in examples

### Additional Reading
- [Making Illegal States Unrepresentable](https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/)
- [Functional Error Handling](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes-func.html#error-handling)
