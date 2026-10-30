import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { Runner } from "../exec.js";
import { agentEnv, INSTALL_NETWORK_OPT_IN, installNetworkAllowed } from "../env.js";
import { firstOnPath } from "../node-engines.js";
import { Network } from "../sandbox.js";
import { GateContext, GateResult } from "../types.js";
import { LOOPBACK_ONLY_NOTE, outputTail, refused, runConfinedProgram } from "./confined-npm.js";

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

/** Whether a changed file is one a command names: `./bin/test`, or `manage.py` in `python manage.py test`. */
export function namedByGateCommand(file: string, commands: GateCommands): boolean {
  const words = [commands.installCommand, commands.buildCommand, commands.testCommand].flatMap((command) => (command ? command.split(/ +/) : []));
  return words.some((word) => posix.join(commands.workingDirectory, word) === file);
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

const INSTALL_NETWORK_NOTE = `outbound network is loopback-only for a project's own install unless this machine sets ${INSTALL_NETWORK_OPT_IN}=1`;

interface OwnStep {
  label: string;
  command: string;
  network: Network;
  note: string;
}

/**
 * The project's own commands for one gate, in order, sharing one timeout. What they execute is as
 * agent-written as `npm test`; what is the owner's is only which program to start. The directory is
 * judged again before each: the install has just run code from the checkout, and that code can have
 * replaced it.
 */
async function runOwnSteps(runner: Runner, steps: OwnStep[], directory: string, timeoutMs: number, context: GateContext): Promise<GateResult> {
  const deadline = Date.now() + timeoutMs;

  for (const { label, command, network, note } of steps) {
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
      timeoutMs: remainingMs,
      signal: context.signal,
      network,
    });
    if ("refusal" in result) return refused(result);
    if (result.timedOut) return { ok: false, reason: `the ${label} command timed out after ${remainingMs}ms` };
    if (result.code !== 0) {
      const loopback = result.loopbackOnly ? `; ${note}` : "";
      return { ok: false, reason: `the ${label} command failed (exit ${result.code}${loopback}):\n${outputTail(result)}` };
    }
  }
  return { ok: true, reason: "", commands: steps.map((step) => named(step.command, directory)) };
}

export function runOwnBuild(runner: Runner, commands: GateCommands, timeoutMs: number, context: GateContext): Promise<GateResult> {
  const steps: OwnStep[] = [];
  if (commands.installCommand) {
    steps.push({
      label: "install",
      command: commands.installCommand,
      network: installNetworkAllowed() ? "open" : "loopback",
      note: INSTALL_NETWORK_NOTE,
    });
  }
  if (commands.buildCommand) {
    steps.push({ label: "build", command: commands.buildCommand, network: "loopback", note: LOOPBACK_ONLY_NOTE });
  }
  if (!steps.length) {
    return Promise.resolve({
      ok: false,
      reason: "this project names its own gate commands but neither an install nor a build command: set one in Settings → Workers, or take the Builds gate out of the agent",
    });
  }
  return runOwnSteps(runner, steps, commands.workingDirectory, timeoutMs, context);
}

export function runOwnTests(runner: Runner, commands: GateCommands, timeoutMs: number, context: GateContext): Promise<GateResult> {
  if (!commands.testCommand) {
    return Promise.resolve({
      ok: false,
      reason: "this project names its own gate commands but no test command: set one in Settings → Workers, or take the Tests gate out of the agent",
    });
  }
  const step = { label: "test", command: commands.testCommand, network: "loopback" as const, note: LOOPBACK_ONLY_NOTE };
  return runOwnSteps(runner, [step], commands.workingDirectory, timeoutMs, context);
}
