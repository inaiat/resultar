# Resultar Check for VS Code & Cursor

Official thin VS Code / Cursor / OpenVSX extension bridging the native TypeScript-Go [`resultar-check lsp`](../../packages/check/README.md) server directly into your editor — with **zero external runtime dependencies**.

## Features

- **Live semantic diagnostics**: All 42 `resultar-check` TypeScript-Go rules update live on unsaved buffers, saves, and cross-file dependency edits.
- **`T / E / R` channel hover**: Hover over `Result`, `ResultTask`, `yield*` expressions, `Match` builders, and DI `Service` tags to inspect exact success (`T`), error (`E`), and requirement (`R`) channels.
- **Inline quickfixes & refactors**: Applies safe semantic corrections (`kind: "correction"`, marked preferred) while keeping `intentional-discard` actions (`void expr`) explicitly opt-in with explanations.
- **One-click safe autofix**: Run `Resultar Check: Apply Safe Fixes (Workspace)` or `(Current File)` directly from the Command Palette or editor context menu (runs `resultar-check --fix`, never auto-applying `intentional-discard`).
- **Workspace overview**: Run `Resultar Check: Show Workflows, Errors & Services Overview` to print exported Resultar workflows, tagged errors, and services to the output panel.
- **Zero-config binary discovery**: Automatically finds workspace `node_modules/.bin/resultar-check`, falls back to `pnpm exec resultar-check`, or uses `resultarCheck.executablePath`.

## Requirements

Install `resultar-check` in your project:

```sh
pnpm add -D resultar-check
```

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `resultarCheck.enable` | `true` | Enable live diagnostics, hover, and quickfixes |
| `resultarCheck.project` | `"tsconfig.json"` | Path to the TypeScript project file |
| `resultarCheck.executablePath` | `""` | Optional explicit path to the `resultar-check` executable |
| `resultarCheck.trace` | `"off"` | Log JSON-RPC traffic (`"off"` or `"messages"`) to the output channel |

## Local development & packaging

```sh
# Build the CJS bundle (dist/extension.cjs)
pnpm run build:vscode

# Type-check, lint, and run unit + real native LSP integration tests
pnpm run check:vscode
pnpm run test:vscode

# Package a .vsix for VS Code / Cursor / OpenVSX
pnpm --dir editors/vscode run package:vsix
```
