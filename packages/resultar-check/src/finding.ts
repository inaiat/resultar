export type ResultarRuleName =
  | "no-discard"
  | "no-await-in-safe-try"
  | "no-tagged-error-constructor-override"
  | "no-throw"
  | "no-try-catch-in-safe-try"
  | "no-unsafe-await"
  | "no-useless-recovery"
  | "prefer-and-then"
  | "prefer-map-err"
  | "prefer-tagged-error"
  | "tagged-error-name-match"
  | "typed-catch-mapper"
  | "unsafe-result-type-assertion"
  | "yield-star-in-safe-try";

export type ResultarRuleSeverity = "error" | "message" | "off" | "suggestion" | "warning";

export interface ResultarLintFinding {
  readonly column: number;
  readonly file: string;
  readonly length: number;
  readonly line: number;
  readonly message: string;
  readonly rule: ResultarRuleName;
  readonly severity: Exclude<ResultarRuleSeverity, "off">;
  readonly start: number;
  readonly type?: string;
}
