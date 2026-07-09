import * as ast from "typescript/unstable/ast";
import type {
  Checker,
  DiagnosticCategory as DiagnosticCategoryType,
} from "typescript/unstable/sync";

export * from "typescript/unstable/ast";
export {
  API,
  DiagnosticCategory,
  ModuleKind,
  NodeBuilderFlags,
  ObjectFlags,
  SignatureKind,
  SymbolFlags,
  TypeFlags,
} from "typescript/unstable/sync";
export type {
  Project as ApiProject,
  Checker as TypeChecker,
  CompilerOptions,
  Signature,
  Symbol,
  Type,
  TypeReference,
  UnionOrIntersectionType,
  UnionType,
} from "typescript/unstable/sync";

export interface Diagnostic {
  readonly category: DiagnosticCategoryType;
  readonly code: number;
  readonly file: ast.SourceFile | undefined;
  readonly length: number | undefined;
  readonly messageText: string;
  readonly source: string | undefined;
  readonly start: number | undefined;
}

export interface Program {
  readonly getSourceFile: (fileName: string) => ast.SourceFile | undefined;
  readonly getSourceFiles: () => readonly ast.SourceFile[];
  readonly getTypeChecker: () => Checker;
}

export const TypeFormatFlags = { NoTruncation: 1 } as const;

export const isTypeAssertionExpression: typeof ast.isTypeAssertion = ast.isTypeAssertion;

export const forEachChild = (node: ast.Node, visitor: (node: ast.Node) => void): void => {
  node.forEachChild((child) => {
    visitor(child);
  });
};

export const getLineAndCharacterOfPosition = (
  sourceFile: ast.SourceFile,
  position: number,
): ast.LineAndCharacter => sourceFile.getLineAndCharacterOfPosition(position);
