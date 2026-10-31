---
name: tsgo-typecheck
description: Use whenever you edit TypeScript or JavaScript files (.ts .tsx .mts .cts .js .jsx .mjs .cjs) or need to find where a TS/JS symbol is defined or used. Type-check with the tsgo MCP tools (ts_diagnostics) before finishing, and use ts_definition / ts_references instead of grep for symbol navigation.
---

# TypeScript checking with tsgo

The `tsgo` MCP server runs the TypeScript 7 native language server for this workspace. It understands the project's tsconfig, path aliases and cross-file types, so it is more accurate than text search and much faster than running `tsc` on the whole repo.

## After editing TS/JS files

1. Call `ts_diagnostics` with the files you changed (or with no arguments to check every changed file in git).
2. Fix every `error` you introduced. Re-run `ts_diagnostics` until your files report 0 errors.
3. If an error existed before your change or is unrelated to the task, leave it and mention it in your summary instead of "fixing" unrelated code.
4. Do this before you tell the user the work is done.

`ts_diagnostics` reads files from disk, so call it after the edit is written. It returns lines like:

```
src/main.ts:4:14 error TS2322: Type 'string' is not assignable to type 'number'.
```

## Navigating code

- `ts_definition {file, line, symbol}`: where a symbol is defined. Prefer it over grep for functions, types, imports and re-exports.
- `ts_references {file, line, symbol}`: every usage of a symbol across the project. Use it before renaming or changing a signature.
- `ts_hover {file, line, symbol}`: the inferred type or signature.
- `ts_symbols {query}`: find a class, function or type by name.

Lines and columns are 1-based. You can pass `symbol` (the identifier text on that line) instead of `column`.

## Notes

- The checker is TypeScript 7. It can be slightly stricter than the project's own TypeScript 5/6 build. If the project build passes but TS 7 reports an error, mention it rather than rewriting working code.
- The first call after a long idle period takes about a second while the server restarts.
