# Changesets

Use this directory to collect release notes and version bump intent before publishing.

Typical flow:

1. Run `pnpm changeset` in a feature branch.
2. Select the packages that should be released and the bump type.
   Deprecated compatibility wrappers (`resultar-lint` and `resultar-tsgo`) are ignored by Changesets.
3. Commit the generated `.changeset/*.md` file with the code change.
4. Run `pnpm run version:packages` when preparing a release.
5. Commit the generated package version, changelog, and `jsr.json` updates.
6. Push a `v*` tag or run the publish workflow manually.
