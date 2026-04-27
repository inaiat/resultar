# TypeScript Type-safe: Transformando Exceções em Valores com Resultar [Resultar](https://github.com/inaiat/resultar)

## O Problema das Exceções em JavaScript

JavaScript, como muitas linguagens dinâmicas, permite que exceções sejam lançadas em praticamente qualquer ponto do código. Este comportamento, embora flexível, pode criar diversos problemas:

   - Exceções Não Controladas
   - Crashes inesperados em produção
   - Stack traces confusos
   - Difícil rastreamento da origem do erro

Vou exemplificar alguns problemas mencionados acima:

### 1. O Erro silencioso (Swallowing Errors):
Erro silencioso pode esconder bugs e dificultar a depuração. Além disso, pode ocultar informações importantes sobre o motivo da falha.
```javascript
function parseJSONSafe(jsonString: string) {
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        return null; // O erro desaparece e não temos informações para depuração
    }
}

const result = parseJSONSafe("{ invalid json }");
console.log(result); // null (mas não sabemos o motivo da falha)
```

### 2. Promessas não Tratadas
Promessas não tratadas ainda hoje são fontes de muitos problemas, conseguimos minimiza-las com adoção correta de uma ferramenta de linting.
```typescript
// ❌ Problema: Try/catch não captura rejeições de promessas
try {
    Promise.reject(new Error('Falha'));
    // O código continua executando...
    console.log('Chegou aqui!');
} catch (error) {
    // Nunca chega aqui!
    console.error('Erro:', error);
}
```
### 3. Callbacks Assíncronos

```typescript
// ❌ Problema: Try/catch não funciona com callbacks
try {
    setTimeout(() => {
        throw new Error('Erro no callback');
    }, 1000);
} catch (error) {
    // Nunca captura o erro!
    console.error('Erro:', error);
}
```

### 4. Nested Try/Catch -

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

// ❌ Problema: Try/catch aninhados
const getPosts = async (url: string) => {
    try {
        const response = await fetch(url)
        if (response.status>=400) {
            // Tratamento de erro HTTP do cliente
            throw new HttpErrorHandler({type:'Http Client Error', value: response.status})
        }
        try {
            const data = await response.json() as Comments
            return data
        } catch (error) {
            // Tratamento de erro JSON
            throw new HttpErrorHandler({type:'Json parser Error', value: `${error}`})
        }
    } catch (error) {
      // Catch externo - Pode capturar erros inesperados
      // Este catch mais externo mascara o erro de HTTP cliente, por exemplo,
      // ocorra um erro de bad request (Http Client Error) o erro retornado
      // será um erro de infraestrutura
        throw new HttpErrorHandler({type:'Infra Error', value: `${error}`})
    }
}
```

### 5. Tratamento Inconsistente de Null
```typescript
// ❌ Problema: Mistura de null check com try/catch
function processarDados(data: any) {
    try {
        if (!data) return null;

        if (!data.usuario) {
            throw new Error('Usuário não encontrado');
        }

        if (!data.usuario.perfil) {
            return null; // Por que não throw?
        }

        return data.usuario.perfil.preferencias;
    } catch (error) {
        return null; // Perdemos o erro original
    }
}
```

Estes exemplos mostram situações comuns onde o try/catch tradicional pode levar a código frágil, difícil de manter e propenso a erros. O Resultar oferece uma abordagem mais estruturada e segura para lidar com estes cenários.


## [Resultar](https://github.com/inaiat/resultar)

Vasculhando na internet fazendo pesquisas e testes para encontrar soluções eficientes e seguras eu acabei encontrando uma biblioteca chamada [Neverthrow](https://github.com/supermacro/neverthrow). Eu já estava acostumado com o tratamento de erros usando o Rust (Result Pattern) e Golang (error handling). Essa biblioteca implementava um padrão de tratamento de erros semelhante ao Rust, seguindo o conceito de Railway Oriented Programming, onde o fluxo de execução é tratado como um pipe que encadeia operações de forma segura, mantendo separados os caminhos de sucesso e erro. Com isso, eu poderia usar este padrão robusto em TypeScript/JavaScript, trazendo as mesmas garantias de tipo e tratamento de erro que encontramos em Rust.

Depois de alguns meses usando o Neverthrow decidi criar um fork inicial da lib e implementar algumas coisas que eu queria adicionar, como hooks de cleanup, logs, erros tagged tipados e algumas condições bem específicas para minha necessidade. O Resultar v2 deve ser tratado como uma direção própria de API: ele mantém o modelo explícito de wrapper `Result`, mas recomenda fortemente `createTaggedError`, `StrictResult` e `StrictResultAsync` para falhas esperadas que aparecem em fronteiras de produção.

No v2, o `Result<T, E>` genérico ainda suporta strings, enums e objetos leves para fluxos locais e pequenos. Para fronteiras de backend e aplicação, falhas esperadas normalmente devem ser instâncias reais de `Error`, com `message`, `cause`, stack trace e metadados estruturados.

Vamos começar aqui com um paradigma full functional:

```javascript
class FetchPostsError extends createTaggedError({
  name: 'FetchPostsError',
  message: 'Não foi possível buscar posts',
}) {}

class FetchCommentsError extends createTaggedError({
  name: 'FetchCommentsError',
  message: 'Não foi possível buscar comentários',
}) {}

class ParsePostsError extends createTaggedError({
  name: 'ParsePostsError',
  message: 'Não foi possível interpretar posts',
}) {}

class ParseCommentsError extends createTaggedError({
  name: 'ParseCommentsError',
  message: 'Não foi possível interpretar comentários',
}) {}

class NoPostsFoundError extends createTaggedError({
  name: 'NoPostsFoundError',
  message: 'Nenhum post encontrado',
}) {}

const fetchPosts = () =>
  fromPromise(fetch("https://jsonplaceholder.typicode.com/posts"), (cause) => new FetchPostsError({ cause }))

const fetchComments = (id: number) =>
  fromPromise(fetch(`https://jsonplaceholder.typicode.com/posts/${id}/comments`), (cause) => new FetchCommentsError({ cause }))

fetchPosts()
        .andThen((r) => fromPromise(r.json() as Promise<Posts>, (cause) => new ParsePostsError({ cause })))
        .map((posts) => posts.at(-1)?.userId)
        .andThen((id) =>
            id ? fetchComments(id) : NoPostsFoundError.err()
        )
        .andThen((comments) => fromPromise(comments.json() as Promise<Comments>, (cause) => new ParseCommentsError({ cause })))
        .match((comments) => console.log(comments),
            (e) => console.error("Erro ao recuperar os comentários", e)
        )
```

Eu acho esse código elegante e eficiente, pois ele utiliza o padrão Result Pattern, o que facilita a leitura e manutenção do código. E é um código extremamente seguro e eficiente e... Usa um padrão funcional para lidar com erros.
Veja, eu adoro linguagens funcionais! Porém, eu percebi que muitas vezes as pessoas que são oriundas de linguagens imperativas não gostam de lidar com erros de forma funcional. Isso é porque elas estão acostumadas a lidar com erros de forma imperativa, onde o código é executado sequencialmente e o controle de fluxo é mais fácil de entender.

Vou reescrever o mesmo código seguindo um padrão mais imperativo, utilizando error propagation e/ou o operador `?` do Rust utilizando o **safeTry** do Resultar.

```javascript
const result = await safeTry(async function* () {
  const reqPosts = yield* tryCatchAsync(
      fetch(`https://jsonplaceholder.typicode.com/posts`),
      (cause) => new FetchPostsError({ cause }),
  );
  const posts = yield* tryCatchAsync(reqPosts.json() as Promise<Posts>);

  const lastPost = posts.at(-1)?.userId;
  if (!lastPost) {
      return NoPostsFoundError.err();
  }
  const reqComments = yield* tryCatchAsync(
      fetch(`https://jsonplaceholder.typicode.com/posts/${lastPost}/comments`),
      (cause) => new FetchCommentsError({ cause }),
  );
  const comments = yield* tryCatchAsync(
      reqComments.json() as Promise<Comments>,
  );
  return ok(comments);
});

result.match(
  (comments) => console.log(comments),
  (error) => console.error("Erro ao recuperar os comentários", error.message),
)
```

Ok, essa abordagem é mais simples de ler e fácil de entender para quem não está familiarizado com código funcional, ainda sim é eficiente e seguro, pois todos os blocos que podem disparar exceções são tratados de forma consistente.

Agora vamos para abordagem completamente imperativa e bem semelhante ao error handling do Golang.

```javascript
const reqPostsResult = await tryCatchAsync(
    fetch(`https://jsonplaceholder.typicode.com/posts`),
    (cause) => new FetchPostsError({ cause }),
);
if (reqPostsResult.isErr()) {
    return errAsync(reqPostsResult.error);
}

const postsResult = await tryCatchAsync(
    reqPostsResult.value.json() as Promise<Posts>,
    (cause) => new ParsePostsError({ cause }),
);
if (postsResult.isErr()) {
    return errAsync(postsResult.error);
}

const lastPost = postsResult.value.at(-1)?.userId;
if (!lastPost) {
    return errAsync(new NoPostsFoundError());
}

const reqCommentsResult = await tryCatchAsync(
    fetch(`https://jsonplaceholder.typicode.com/posts/${lastPost}/comments`),
    (cause) => new FetchCommentsError({ cause }),
);
if (reqCommentsResult.isErr()) {
    return errAsync(reqCommentsResult.error);
}

const commentsResult = await tryCatchAsync(
    reqCommentsResult.value.json() as Promise<Comments>,
    (cause) => new ParseCommentsError({ cause }),
);
if (commentsResult.isErr()) {
    return errAsync(commentsResult.error);
}
return okAsync(commentsResult.value);
```

O código continua seguro, pois estamos tratando todas as possíveis exceções que podem ocorrer durante a execução do código com o **tryCatch** do **Resultar**

Pedi para uma AI (sonet 3.5) comparar os 3 exemplos e jogar em uma tabela para compararmos os resultados.

## Análise Comparativa

### 1. Estilo Imperativo
- ✅ Validações explícitas
- ✅ Fácil de entender o fluxo
- ✅ Mensagens de erro específicas
- ❌ Código mais verboso
- ❌ Múltiplos pontos de saída (returns)
- ❌ Pode levar a muito código boilerplate

### 2. SafeTry
- ✅ Código conciso
- ✅ Fácil de implementar
- ✅ Bom para casos simples
- ❌ Menos controle sobre validações
- ❌ Pode mascarar erros específicos

### 3. Abordagem Funcional
- ✅ Composição elegante
- ✅ Type-safe
- ✅ Validações granulares
- ✅ Fácil de estender
- ❌ Requer conhecimento de programação funcional
- ❌ Curva de aprendizado inicial

Bom, dito isto, você é livre para escolher o estilo de programação que melhor se adapte às suas necessidades. Cada abordagem tem suas vantagens e desvantagens, e é importante escolher a que melhor se encaixa no seu projeto específico e seu time de desenvolvimento. O importante é que você saiba como lidar com erros e exceções de forma segura e eficiente. O fork inicial do **neverthrow** deu o ponto de partida ao Resultar; o Resultar v2 hoje segue sua própria direção com tagged errors, canais de erro estritos e ergonomia para fronteiras de serviço.


Para terminar vou colocar alguns exemplos de como é simples tornar o código mais seguro usando o **Resultar**."

### 1. Swallowing Errors

```typescript
// ❌ Problema: Try/catch não captura rejeições de promessas
function parseJSONSafe(jsonString: string) {
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        return null; // O erro desaparece e não temos informações para depuração
    }
}

// ✅ Resultar
class JsonParseError extends createTaggedError({
  name: 'JsonParseError',
  message: 'Não foi possível interpretar o JSON',
}) {}

const resultado = Result.tryCatch(
  () => JSON.parse("{'a'}"),
  (cause) => new JsonParseError({ cause }),
)

assert.ok(resultado.isErr())
if (resultado.isErr()) {
  assert.ok(resultado.error instanceof JsonParseError)
}
```



### 2. Promessas não Tratadas
```javascript
// ❌ Problema: Promessas não tratadas podem causar problemas de segurança
try {
  Promise.reject(new Error('Falha'));
  // O código continua executando...
  console.log('Não deveria chegar aqui!');
} catch (error) {
  // Nunca chega aqui!
  console.error('Erro:', error);
}

// ✅ Resultar
const resultado = await tryCatchAsync(
        Promise.reject(new Error('Falha')), String
    );
assert.ok(resultado.isErr())
```

### 3. Callbacks Assíncronos
```javascript
try {
    setTimeout(() => {
        throw new Error('Erro no callback');
    }, 1000);
} catch (error) {
    // Nunca captura o erro!
    console.error('Erro:', error);
}

// ✅ Resultar
const resultado = await tryCatchAsync(
    new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error('Erro no callback'));
        }, 1000);
    })
);
assert.ok(resultado.isErr())
```

### 4. Nested TryCatch

Dado esse teste:
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
  console.log( posts)
} catch (error) {
  if (error instanceof HttpErrorHandler) {
      assert.ok(error.httpError.type==='Http Client Error')
      assert.equal(error.httpError.value, 400)
  }
}
```
Esse teste sempre falhará, pois o erro lançado será sempre um erro de infraestrutura, pois o erro é ocultado pelo catch mais externo. Vamos alterar o código para uma abordagem mais type-safe:

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
if (result.isErr()) {
  assert.ok(result.error.type === 'Http Client Error')
  assert.equal(result.error.value, 400)
}
```

O Result Pattern não só torna o código mais testável e previsível, como também oferece garantias mais fortes nas assertivas de teste. No exemplo, o assert.equal(e.value, 400) passou com sucesso, confirmando que o Result capturou e transportou corretamente o erro HTTP 400, demonstrando como a estrutura tipada do Result mantém a integridade dos dados através de toda a cadeia de operações até o ponto de teste.

Ainda é possível usar o error-propagation (a.k.a ? Rust operator) para propagar erros de infraestrutura para o nível mais externo do código, garantindo que todos os erros sejam tratados de forma consistente e previsível. Acredito que desta forma ainda fica mais fácil de entender o código para desenvolvedores não familiarizados com o Railway Programming.

```javascript
const safeGetPosts =  (url: string) =>  safeTry(async function* () {
    const response = yield* tryCatchAsync(fetch(url), e=> ({ type: 'Infra Error', value: `${e}` } satisfies HttpError))
    if (response.status >= 400) {
        return err({ type: 'Http Client Error', value: response.status } satisfies HttpError)
    }
    return tryCatchAsync(response.json() as Promise<Posts>, e => ({ type: 'Json parser Error', value: `${e}` } satisfies HttpError))
})
const result = await safeGetPosts("https://httpbin.org/status/400")
assert.ok(result.isErr())
if (result.isErr()) {
  assert.ok(result.error.type === 'Http Client Error')
  assert.ok(result.error.value === 400)
}
```

Para tentar resumir aqui as principais vantagens do Result Pattern, podemos destacar:

1. **Type Safety**:
- Contratos explícitos via tipos
- Erros são tratados como ***first-class values***
- Garantias em tempo de compilação
- Sem undefined/null implícitos

2. **Error Handling**:
- Tratamento obrigatório de erros
- Pattern matching expressivo
- Transformações type-safe de erros
- Rastreamento preciso de falhas

3. **Composability**:
- Encadeamento fluente
- Transformações funcionais
- Combinação de operações
- Railway oriented programming


## Referências

### Artigos e Documentações
- [Railway Oriented Programming](https://fsharpforfunandprofit.com/rop/) - Scott Wlaschin
- [Rust Error Handling](https://doc.rust-lang.org/book/ch09-00-error-handling.html) - Documentação Oficial Rust
- [Error Handling in Go](https://go.dev/blog/error-handling-and-go) - Documentação Oficial Go
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) - Documentação Oficial TypeScript

### Bibliotecas
- [Resultar](https://github.com/inaiat/resultar) - Biblioteca de tratamento de erros type-safe para TypeScript
- [Neverthrow](https://github.com/supermacro/neverthrow) - O Resultar começou como um fork inicial deste projeto

### Exemplos e APIs utilizadas
- [JSONPlaceholder](https://jsonplaceholder.typicode.com/) - API de teste utilizada nos exemplos
- [HTTPBin](https://httpbin.org/) - Serviço de teste HTTP utilizado nos exemplos

### Leitura Adicional
- [Making Illegal States Unrepresentable](https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/)
- [Functional Error Handling](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes-func.html#error-handling)
