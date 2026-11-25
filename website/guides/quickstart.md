# Your first Result

A checkout form receives a quantity as text. The order needs a positive whole number. Give the parser a return type that tells its caller both what it can use and what it needs to handle.

## Run the example

Open the following block in **Playground** and select **Run**. To run it locally, use Node.js 24 or later, install the v5 core package, and save the TypeScript block as `quantity.mts`.

```sh
pnpm add 'resultar@^5.0.0-0'
node quantity.mts
```

The version range includes v5 previews of 5.0.0 and stable v5 releases. The core package provides everything used in this tutorial.

```ts
import { err, ok, type Result } from "resultar";

function parseQuantity(raw: string): Result<number, "InvalidQuantity"> {
  const text = raw.trim();
  const quantity = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(quantity) && quantity > 0
    ? ok(quantity)
    : err("InvalidQuantity");
}

for (const input of [" 3 ", "0", "two"]) {
  const message = parseQuantity(input).match({
    ok: (quantity) => `Reserve ${quantity} items`,
    err: () => "Enter a positive whole number",
  });
  console.log(message);
}
```

The first line is `Reserve 3 items`. Both remaining lines ask for a positive whole number. Try `"3.5"` and `"003"` to see which inputs the parser accepts.

## Transform a successful value

An order line costs 250 cents per item. Once the quantity has been parsed, `map` can calculate its price. On an `Err`, Resultar skips the calculation and carries the same error to the caller.

```ts
import { ok, err, type Result } from "resultar";

function priceLine(quantity: Result<number, "InvalidQuantity">) {
  return quantity.map((count) => count * 250);
}

console.log(priceLine(ok(3))); // Ok(750)
console.log(priceLine(err("InvalidQuantity"))); // Err("InvalidQuantity")
```

Use `map` when the next step returns an ordinary value. Use `andThen` when it returns another `Result`, such as an order-limit check. Call `match` where the program needs to display a message or choose an HTTP response.

## Choose your next step

| What are you building?                                                  | Where to continue                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| A checkout that reads stock from an async driver                        | [Compose a lazy workflow](./async-workflow.md)         |
| A handler or worker that needs to report failures and release resources | [Handle failures and cleanup](./failure-boundaries.md) |
| A first integration in an existing application                          | [Gradual adoption](../../docs/gradual-adoption.md)     |
| An upgrade from v4 with eager async operations                          | [v5 migration guide](../../docs/migrations/v5.md)      |
