#!/usr/bin/env node
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import ts from 'typescript'

import type { Result } from './result.js'

import { err, ok } from './result.js'

const resultTypeMatcher =
  /\b(?:DisposableResult|DisposableResultAsync|ErrResult|OkResult|Result|ResultAsync|StrictResult|StrictResultAsync)\b/

export interface NoDiscardFinding {
  readonly column: number
  readonly file: string
  readonly line: number
  readonly type: string
}

export interface NoDiscardOptions {
  readonly project?: string
  readonly rootDir?: string
}

interface CliOptions extends NoDiscardOptions {
  readonly help: boolean
}

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => '\n',
}

const usage = `Usage: resultar-no-discard [--project tsconfig.json]

Flags:
  -p, --project <path>  TypeScript project file to inspect. Defaults to tsconfig.json.
  -h, --help            Show this help message.
`

const cliError = (message: string): Result<never, Error> => err(new Error(message))

const parseArgs = (args: readonly string[]): Result<CliOptions, Error> => {
  let project: string | undefined = undefined
  let help = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--project' || arg === '-p') {
      const nextArg = args[index + 1]

      if (nextArg === undefined || nextArg === '') {
        return cliError(`${arg} requires a path`)
      }

      project = nextArg
      index += 1
    } else if (arg !== undefined && arg.startsWith('--project=')) {
      project = arg.slice('--project='.length)
    } else if (arg !== undefined && arg !== '') {
      return cliError(`Unknown argument: ${arg}`)
    }
  }

  if (project === '') {
    return cliError('--project requires a path')
  }

  return project === undefined ? ok({ help }) : ok({ help, project })
}

const readProject = (projectPath: string): Result<ts.ParsedCommandLine, Error> => {
  const config = ts.readConfigFile(projectPath, (fileName) => ts.sys.readFile(fileName))

  if (config.error) {
    return err(new Error(ts.formatDiagnosticsWithColorAndContext([config.error], formatHost)))
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolve(projectPath, '..'),
    undefined,
    projectPath,
  )

  if (parsed.errors.length > 0) {
    return err(new Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, formatHost)))
  }

  return ok(parsed)
}

const isResultLikeType = (checker: ts.TypeChecker, node: ts.Node, type: ts.Type): boolean => {
  if (type.isUnionOrIntersection()) {
    return type.types.some((innerType) => isResultLikeType(checker, node, innerType))
  }

  const typeName = checker.typeToString(
    type,
    node,
    ts.TypeFormatFlags.NoTruncation + ts.TypeFormatFlags.UseFullyQualifiedType,
  )

  return resultTypeMatcher.test(typeName)
}

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  let current = expression

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression
  }

  return current
}

const isExplicitDiscard = (expression: ts.Expression): boolean =>
  ts.isVoidExpression(unwrapExpression(expression))

const isCallLikeDiscard = (expression: ts.Expression): boolean => {
  const unwrapped = unwrapExpression(expression)

  if (ts.isAwaitExpression(unwrapped)) {
    return isCallLikeDiscard(unwrapped.expression)
  }

  if (ts.isCallExpression(unwrapped)) {
    return true
  }

  if (ts.isConditionalExpression(unwrapped)) {
    return isCallLikeDiscard(unwrapped.whenTrue) || isCallLikeDiscard(unwrapped.whenFalse)
  }

  if (
    ts.isBinaryExpression(unwrapped) &&
    [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(unwrapped.operatorToken.kind)
  ) {
    return isCallLikeDiscard(unwrapped.right)
  }

  return false
}

const inspectSourceFile = (
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): readonly NoDiscardFinding[] => {
  const findings: NoDiscardFinding[] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isExpressionStatement(node) &&
      !isExplicitDiscard(node.expression) &&
      isCallLikeDiscard(node.expression)
    ) {
      const type = checker.getTypeAtLocation(node.expression)

      if (isResultLikeType(checker, node.expression, type)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart())
        findings.push({
          column: position.character + 1,
          file: sourceFile.fileName,
          line: position.line + 1,
          type: checker.typeToString(type, node.expression, ts.TypeFormatFlags.NoTruncation),
        })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return findings
}

export const findDiscardedResults = (
  options: NoDiscardOptions = {},
): Result<readonly NoDiscardFinding[], Error> => {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const projectPath = resolve(rootDir, options.project ?? 'tsconfig.json')

  return readProject(projectPath).map((parsed) => {
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const checker = program.getTypeChecker()
    const findings: NoDiscardFinding[] = []

    for (const sourceFile of program.getSourceFiles()) {
      if (!sourceFile.isDeclarationFile && !sourceFile.fileName.includes('/node_modules/')) {
        findings.push(...inspectSourceFile(checker, sourceFile))
      }
    }

    return findings
  })
}

const formatFinding = (finding: NoDiscardFinding, rootDir: string): string => {
  const file = relative(rootDir, finding.file)

  return [
    `${file}:${finding.line}:${finding.column} no-discard-result`,
    `Ignored ${finding.type} value. Handle it or explicitly discard it with \`void\`.`,
  ].join(' - ')
}

export const runNoDiscardCli = (args: readonly string[] = process.argv.slice(2)): number => {
  const rootDir = process.cwd()

  return parseArgs(args)
    .andThen((options) => {
      if (!options.help) {
        return options.project === undefined
          ? findDiscardedResults({ rootDir })
          : findDiscardedResults({ project: options.project, rootDir })
      }

      process.stdout.write(usage)
      return ok([] as const)
    })
    .match(
      (findings) => {
        if (findings.length === 0) {
          return 0
        }

        process.stderr.write(
          `${findings.map((finding) => formatFinding(finding, rootDir)).join('\n')}\n`,
        )

        return 1
      },
      (error) => {
        process.stderr.write(`${error.message}\n`)
        return 1
      },
    )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = runNoDiscardCli()
}
