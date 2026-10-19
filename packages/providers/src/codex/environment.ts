const codexEnvironmentKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CODEX_HOME",
] as const;

export function createCodexCliEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    codexEnvironmentKeys.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  ) as NodeJS.ProcessEnv;
}
