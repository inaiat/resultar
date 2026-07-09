import { join, resolve } from "node:path";

import * as ts from "../src/typescript-api.js";

export interface FixtureProgram {
  readonly close: () => void;
  readonly program: ts.Program;
  readonly sourceFile: ts.SourceFile;
}

export const openFixtureProgram = (rootDir: string, fileName = "fixture.ts"): FixtureProgram => {
  const projectPath = join(rootDir, "tsconfig.json");
  const api = new ts.API({ cwd: rootDir });
  const snapshot = api.updateSnapshot({ openProjects: [projectPath] });
  const project =
    snapshot.getProject(projectPath) ??
    snapshot.getProjects().find((candidate) => resolve(candidate.configFileName) === projectPath);

  if (project === undefined) {
    api.close();
    throw new Error(`Unable to open TypeScript project: ${projectPath}`);
  }

  const sourceFiles = project.program
    .getSourceFileNames()
    .map((sourceFileName) => project.program.getSourceFile(sourceFileName))
    .filter((sourceFile): sourceFile is ts.SourceFile => sourceFile !== undefined);
  const filePath = resolve(rootDir, fileName);
  const program: ts.Program = {
    getSourceFile: (sourceFileName) => project.program.getSourceFile(sourceFileName),
    getSourceFiles: () => sourceFiles,
    getTypeChecker: () => project.checker,
  };
  const sourceFile =
    program.getSourceFile(filePath) ??
    sourceFiles.find((candidate) => resolve(candidate.fileName) === filePath);

  if (sourceFile === undefined) {
    api.close();
    throw new Error(`Expected ${fileName} to be part of the fixture program`);
  }

  return {
    close: () => {
      api.close();
    },
    program,
    sourceFile,
  };
};
