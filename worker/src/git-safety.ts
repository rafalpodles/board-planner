const SAFE_CONFIG = [
  "core.fsmonitor=false",
  "core.pager=cat",
  "core.hooksPath=/dev/null",
  "credential.helper=",
];

export const GIT_SAFE_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
};

function withConfig(config: string[], args: string[]): string[] {
  return [...config.flatMap((entry) => ["-c", entry]), ...args];
}

export function refuseOptionShapedPositionals(args: string[]): string[] {
  const separator = args.indexOf("--");
  if (separator === -1) return args;
  const offender = args.slice(separator + 1).find((arg) => arg.startsWith("-"));
  if (offender !== undefined) {
    throw new Error(
      `refusing git argument ${JSON.stringify(offender)}: git reads a leading dash as an option`
    );
  }
  return args;
}

export function gitArgs(args: string[]): string[] {
  return withConfig(SAFE_CONFIG, refuseOptionShapedPositionals(args));
}
