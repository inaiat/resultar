import { expectTypeOf, it } from "vite-plus/test";

import type { HttpErrorStatusByTag } from "../src/index.js";

it("requires a numeric HTTP status for every error tag", () => {
  type UserError = { readonly _tag: "UserNotFound" } | { readonly _tag: "UserConflict" };

  expectTypeOf<HttpErrorStatusByTag<UserError>>().toEqualTypeOf<{
    readonly UserNotFound: number;
    readonly UserConflict: number;
  }>();
});
