import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { Runner } from "../exec.js";
import { agentEnv } from "../env.js";
import { firstOnPath } from "../node-engines.js";
import { RecordedDir } from "../sandbox.js";
import { programDirectory } from "../sealed-home.js";
import { GateContext, GateResult } from "../types.js";
import { outputTail, refused, runConfinedProgram } from "./confined-npm.js";

export interface GateCommands {
  installCommand: string;
  buildCommand: string;
  testCommand: string;
  workingDirectory: string;
}

export const NPM_GATES: GateCommands = { installCommand: "", buildCommand: "", testCommand: "", workingDirectory: "" };

export function gateCommandsOf(config: Partial<GateCommands>): GateCommands {
  return {
    installCommand: config.installCommand ?? "",
    buildCommand: config.buildCommand ?? "",
    testCommand: config.testCommand ?? "",
    workingDirectory: config.workingDirectory ?? "",
  };
}

/** Any command at all and the project has left npm, so an empty install is no install rather than `npm ci`. */
export function usesOwnCommands(commands: GateCommands): boolean {
  return Boolean(commands.installCommand || commands.buildCommand || commands.testCommand);
}

export function gateProgramOf(command: string): string {
  return command.split(/ +/)[0];
}

/**
 * Whether a changed file is one a command names: as a word, after `=` or a short option, or as the
 * module of `-m`. Compared in lower case, because macOS will run `bin/test` for `./bin/Test`.
 */
export function namedByGateCommand(file: string, commands: GateCommands): boolean {
  const words = [commands.installCommand, commands.buildCommand, commands.testCommand].flatMap((command) => (command ? command.split(/ +/) : []));
  const named = words.flatMap((word, index) => [
    word,
    word.slice(word.indexOf("=") + 1),
    ...(/^-[A-Za-z]./.test(word) ? [word.slice(2)] : []),
    ...(words[index - 1] === "-m" ? [`${word.replaceAll(".", "/")}.py`] : []),
  ]);
  return named.some((word) => posix.join(commands.workingDirectory, word).toLowerCase() === file.toLowerCase());
}

/** Where the gate's commands run: the checkout, or a directory in it reached through no symlink. */
export function gateDirectory(worktreePath: string, directory: string): { path: string } | { reason: string } {
  let path = worktreePath;
  for (const part of directory ? directory.split("/") : []) {
    path = join(path, part);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return { reason: `the working directory ${directory} does not exist in this checkout` };
    }
    if (stat.isSymbolicLink()) return { reason: `the working directory ${directory} passes through the symlink ${part}` };
    if (!stat.isDirectory()) return { reason: `the working directory ${directory} is not a directory: ${part} is a file` };
  }
  return { path };
}

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A bare name on the worker's own PATH, or `./path` from the directory the command runs in. */
export function resolveGateProgram(program: string, directory: string, path: string): string | null {
  if (program.startsWith("./")) {
    const inDirectory = join(directory, program);
    return runnable(inDirectory) ? inDirectory : null;
  }
  return firstOnPath(program, path, runnable);
}

const named = (command: string, directory: string) => (directory ? `${command} (in ${directory})` : command);

interface OwnStep {
  label: string;
  command: string;
}

/**
 * The project's own commands for one gate, in order, sharing one timeout. What they execute is as
 * agent-written as `npm test`, and the owner chooses the program and its arguments. The directory is
 * judged again before each: the install has just run code from the checkout, and that code can have
 * replaced it.
 */
const installedInto = new WeakSet<RecordedDir>();

async function runOwnSteps(runner: Runner, steps: OwnStep[], directory: string, timeoutMs: number, context: GateContext): Promise<GateResult> {
  const deadline = Date.now() + timeoutMs;

  for (const { label, command } of steps) {
    const place = gateDirectory(context.worktreePath, directory);
    if ("reason" in place) return { ok: false, reason: place.reason };
    const [program, ...args] = command.split(/ +/);
    const path = resolveGateProgram(program, place.path, agentEnv().PATH ?? "");
    if (!path) return { ok: false, reason: `${label} command: ${program} was not found, or cannot be run` };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { ok: false, reason: `the ${timeoutMs}ms budget ran out before the ${label} command started` };

    const result = await runConfinedProgram(runner, path, args, {
      cwd: place.path,
      worktree: context.worktreeDir,
      home: context.gateHome,
      readable: [context.checkoutGitDir, programDirectory(path)],
      timeoutMs: remainingMs,
      signal: context.signal,
    });
    if ("refusal" in result) return refused(result);
    if (result.timedOut) return { ok: false, reason: `the ${label} command timed out after ${remainingMs}ms` };
    if (result.code !== 0) {
      return { ok: false, reason: `the ${label} command failed (exit ${result.code}):\n${outputTail(result)}` };
    }
    if (label === "install") installedInto.add(context.gateHome);
  }
  return { ok: true, reason: "", commands: steps.map((step) => named(step.command, directory)) };
}

const NO_BUILD_COMMAND =
  "this project names its own gate commands but neither an install nor a build command, and its agent has a Builds gate: set one in Settings → Workers, or take that gate out of the agent";
const NO_TEST_COMMAND =
  "this project names its own gate commands but no test command, and its agent has a Tests pass gate: set one in Settings → Workers, or take that gate out of the agent";

export function runOwnBuild(runner: Runner, commands: GateCommands, timeoutMs: number, context: GateContext): Promise<GateResult> {
  const steps: OwnStep[] = [];
  if (commands.installCommand) steps.push({ label: "install", command: commands.installCommand });
  if (commands.buildCommand) steps.push({ label: "build", command: commands.buildCommand });
  if (!steps.length) return Promise.resolve({ ok: false, reason: NO_BUILD_COMMAND });
  return runOwnSteps(runner, steps, commands.workingDirectory, timeoutMs, context);
}

export function runOwnTests(runner: Runner, commands: GateCommands, timeoutMs: number, context: GateContext): Promise<GateResult> {
  if (!commands.testCommand) return Promise.resolve({ ok: false, reason: NO_TEST_COMMAND });
  const steps: OwnStep[] = [{ label: "test", command: commands.testCommand }];
  // A sequence may have no build gate, and a step's commit replaces the home. An empty home would not
  // say which: a venv in the worktree leaves it empty, and installing again would undo the build
  if (commands.installCommand && !installedInto.has(context.gateHome)) steps.unshift({ label: "install", command: commands.installCommand });
  return runOwnSteps(runner, steps, commands.workingDirectory, timeoutMs, context);
}

/**
 * What can be told about a project's commands before anybody pays for a step. A missing working
 * directory is not here: the task may be the one that creates it.
 */
export function gateConfigFault(sequence: { gateKind?: string }[], commands: GateCommands, worktreePath: string): string | null {
  if (!usesOwnCommands(commands)) return null;
  const hasBuild = sequence.some((entry) => entry.gateKind === "build");
  const hasTests = sequence.some((entry) => entry.gateKind === "test-run");
  if (hasBuild && !commands.installCommand && !commands.buildCommand) return NO_BUILD_COMMAND;
  if (hasTests && !commands.testCommand) return NO_TEST_COMMAND;

  const place = gateDirectory(worktreePath, commands.workingDirectory);
  if ("reason" in place) return null;
  // The first alone: an install is what makes `./.venv/bin/pytest` exist for the command after it
  const first = sequence
    .flatMap(({ gateKind }) => (gateKind === "build" ? [commands.installCommand, commands.buildCommand] : gateKind === "test-run" ? [commands.installCommand, commands.testCommand] : []))
    .find(Boolean);
  const program = first ? gateProgramOf(first) : "";
  if (program.startsWith("./") && !resolveGateProgram(program, place.path, "")) {
    return `${program} is named by a gate command, and this checkout has no such executable file`;
  }
  return null;
}
