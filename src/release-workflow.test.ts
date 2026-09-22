import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * BP-772. release-please published vX.Y.Z as GitHub's "latest" the moment it tagged, and the
 * build that attaches the app took up to two hours after — or, for v1.1.0, failed and left the
 * docs' "latest release" link on a release with nothing to download. The release is now a draft
 * until publish has attached its assets, and only then made latest, and only when it is the
 * newest vX.Y.Z. These run the workflow's own shell, cut out of release.yml, against a real git
 * repository and a gh that records what it was asked.
 */

const WORKFLOW = readFileSync(join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
const CONFIG = JSON.parse(readFileSync(join(__dirname, "..", "release-please-config.json"), "utf8"));

/** The `run: |` block of the step with this name, dedented, the way the runner hands it to bash. */
function stepScript(name: string): string {
  const lines = WORKFLOW.split("\n");
  const at = lines.findIndex((line) => line.trim().replace(/^- /, "") === `name: ${name}`);
  if (at === -1) throw new Error(`no step named ${name}`);
  const run = lines.findIndex((line, i) => i > at && line.trim() === "run: |");
  const indent = lines[run].indexOf("run:") + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bp-release-"));
  dirs.push(dir);
  return dir;
}

function readEnvFile(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=", 2) as [string, string])
  );
}

function newestRelease(tags: string[], version: string): string {
  const repo = scratch();
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
  for (const tag of tags) git("tag", tag);
  const envFile = join(repo, "github-env");
  writeFileSync(envFile, "");
  execFileSync("bash", ["-e", "-c", stepScript("Is this the newest release")], {
    cwd: repo,
    env: { ...process.env, GITHUB_ENV: envFile, VERSION: version, RELEASE: "true" },
  });
  return readEnvFile(envFile).LATEST;
}

function publish(releaseExists: boolean, latest: string, published = "false 2"): string[] {
  const dir = scratch();
  const calls = join(dir, "calls");
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/bin/bash\necho "$*" >> "${calls}"\nif [ "$1 $2" = "release view" ] && [[ "$*" == *--json* ]]; then echo "${published}"; exit 0; fi\nif [ "$1 $2" = "release view" ] && [ "${releaseExists ? 1 : 0}" = 0 ]; then exit 1; fi\nexit 0\n`
  );
  chmodSync(gh, 0o755);
  const assets = join(dir, "release-assets");
  execFileSync("mkdir", [assets]);
  writeFileSync(join(assets, "board-planner-menubar-1.2.0.zip"), "zip");
  execFileSync("bash", ["-c", "cd release-assets && shasum -a 256 board-planner-menubar-1.2.0.zip > SHA256SUMS"], {
    cwd: dir,
  });
  const script = stepScript("Attach and publish").replace(/sha256sum -c/g, "shasum -a 256 -c");
  execFileSync("bash", ["-e", "-c", script], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TAG: "v1.2.0",
      GITHUB_REPOSITORY: "o/r",
      LATEST: latest,
    },
  });
  return readFileSync(calls, "utf8").trim().split("\n");
}

describe("the release workflow", () => {
  it("has release-please create the release as a draft, with its tag, so nothing is latest yet", () => {
    expect(CONFIG.packages["."]).toMatchObject({ draft: true, "force-tag-creation": true });
  });

  it("makes the newest vX.Y.Z latest, and neither a backport nor a pre-release name", () => {
    expect(newestRelease(["v1.0.1", "v1.1.0", "v1.2.0"], "1.2.0")).toBe("true");
    expect(newestRelease(["v1.0.1", "v1.1.0", "v1.0.2"], "1.0.2")).toBe("false");
    expect(newestRelease(["v1.1.0", "v1.2.0-rc.1"], "1.1.0")).toBe("true");
  });

  it("publishes a release-please draft only after uploading to it, as latest when it is newest", () => {
    const calls = publish(true, "true");
    const upload = calls.findIndex((c) => c.startsWith("release upload v1.2.0"));
    const edit = calls.findIndex((c) => c.startsWith("release edit v1.2.0"));

    expect(upload).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(upload);
    expect(calls[edit]).toContain("--draft=false");
    expect(calls[edit]).toContain("--latest=true");
  });

  it("keeps a backport from taking latest", () => {
    expect(publish(true, "false").find((c) => c.startsWith("release edit"))).toContain("--latest=false");
  });

  it("creates a hand-pushed tag's release with its assets, under the same rule", () => {
    const create = publish(false, "false").find((c) => c.startsWith("release create v1.2.0"));

    expect(create).toContain("release-assets/board-planner-menubar-1.2.0.zip");
    expect(create).toContain("--latest=false");
  });

  it("fails the job when the release is still a draft afterwards, or is missing an asset", () => {
    expect(() => publish(true, "true", "true 2")).toThrow();
    expect(() => publish(true, "true", "false 1")).toThrow();
  });

  it("has release-please keep the worker's manifest and lockfile at the release", () => {
    expect(CONFIG.packages["."]["extra-files"]).toEqual([
      { type: "json", path: "worker/package.json", jsonpath: "$.version" },
      { type: "json", path: "worker/package-lock.json", jsonpath: "$.version" },
      { type: "json", path: "worker/package-lock.json", jsonpath: "$.packages[''].version" },
    ]);
  });

  // BP-768 review: a local `make` stamped 1.0.0 into the app, which is the bug again
  it("stamps an unconfigured local app build with the worker's own version", () => {
    const line = readFileSync(join(__dirname, "..", "menubar", "bundle.sh"), "utf8")
      .split("\n")
      .find((l) => l.startsWith("VERSION="));
    const worker = JSON.parse(readFileSync(join(__dirname, "..", "worker", "package.json"), "utf8"));

    const stamped = execFileSync(
      "bash",
      ["-c", `ROOT="${join(__dirname, "..", "menubar")}"; unset CP_VERSION; ${line}; printf %s "$VERSION"`],
      { encoding: "utf8" }
    );

    expect(stamped).toBe(worker.version);
    expect(stamped).not.toBe("1.0.0");
  });

  it("decides latest in the publish job, after the build it depends on", () => {
    const publishJob = WORKFLOW.slice(WORKFLOW.indexOf("\n  publish:\n"), WORKFLOW.indexOf("\n  image:\n"));

    expect(publishJob).toContain("needs: [resolve, build]");
    expect(publishJob.indexOf("name: Is this the newest release")).toBeLessThan(
      publishJob.indexOf("name: Attach and publish")
    );
  });
});
