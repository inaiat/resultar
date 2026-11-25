import { transform } from "sucrase";

export const stripPlaygroundTypes = (source: string): string =>
  transform(source, {
    transforms: ["typescript"],
    keepUnusedImports: false,
    disableESTransforms: true,
  }).code;

export const transpilePlaygroundTs = (source: string): string =>
  transform(source, {
    transforms: ["typescript", "imports"],
    keepUnusedImports: true,
    // The loader supplies ESM namespaces directly, with no synthetic default export.
    enableLegacyTypeScriptModuleInterop: true,
    disableESTransforms: true,
  }).code;
