import { describe, it, expect } from "bun:test";
import {
  upgradeFlow,
  type UpgradeFlowDeps,
  type UpgradeFlowOptions,
  type ExecResult,
} from "../bin/upgradeFlow";

// ─── Helpers ────────────────────────────────────────────────────────────────

const ok: ExecResult = { stdout: "", stderr: "" };
const fail = (msg: string): ExecResult => ({ stdout: "", stderr: msg });

function makeDeps(
  overrides: Partial<UpgradeFlowDeps> = {},
  execResponses: Record<string, ExecResult> = {},
): {
  deps: UpgradeFlowDeps;
  calls: string[];
  logs: string[];
  errors: string[];
  exitCodes: number[];
} {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];

  const deps: UpgradeFlowDeps = {
    exec: async (cmd) => {
      calls.push(cmd);
      return execResponses[cmd] ?? ok;
    },
    checkBinary: async () => true,
    exit: (code) => {
      exitCodes.push(code);
    },
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
    ...overrides,
  };

  return { deps, calls, logs, errors, exitCodes };
}

// ─── deploy: none ────────────────────────────────────────────────────────────

describe("upgradeFlow – deploy: none", () => {
  const options: UpgradeFlowOptions = { version: "main", deploy: undefined };

  it("runs expected exec commands in order", async () => {
    const { deps, calls } = makeDeps();
    await upgradeFlow(options, deps);

    expect(calls).toEqual([
      "git pull --rebase --no-edit origin main",
      "wrangler d1 migrations apply AUTH_DB",
    ]);
  });

  it("does NOT run wrangler deploy or git push", async () => {
    const { deps, calls } = makeDeps();
    await upgradeFlow(options, deps);

    expect(calls.some((c) => c === "wrangler deploy")).toBe(false);
    expect(calls.some((c) => c === "git push")).toBe(false);
  });

  it("logs upgrade start and success", async () => {
    const { deps, logs } = makeDeps();
    await upgradeFlow(options, deps);

    expect(logs.some((l) => l.includes("Upgrading to version: main"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("Upgrade successful"))).toBe(true);
  });

  it("logs the manual deploy hint", async () => {
    const { deps, logs } = makeDeps();
    await upgradeFlow(options, deps);

    expect(
      logs.some((l) =>
        l.includes("No deployment method specified, skipping deployment."),
      ),
    ).toBe(true);
  });

  it("produces no errors and does not exit", async () => {
    const { deps, errors, exitCodes } = makeDeps();
    await upgradeFlow(options, deps);

    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});

// ─── deploy: wrangler ────────────────────────────────────────────────────────

describe("upgradeFlow – deploy: wrangler", () => {
  const options: UpgradeFlowOptions = { version: "v0.3.0", deploy: "wrangler" };

  it("runs expected exec commands in order", async () => {
    const { deps, calls } = makeDeps();
    await upgradeFlow(options, deps);

    expect(calls).toEqual([
      "git pull --rebase --no-edit origin v0.3.0",
      "wrangler d1 migrations apply AUTH_DB",
      "wrangler deploy",
    ]);
  });

  it("logs deployment success", async () => {
    const { deps, logs } = makeDeps();
    await upgradeFlow(options, deps);

    expect(logs.some((l) => l.includes("Deployment successful"))).toBe(true);
  });

  it("does NOT run git push", async () => {
    const { deps, calls } = makeDeps();
    await upgradeFlow(options, deps);

    expect(calls.some((c) => c === "git push")).toBe(false);
  });

  it("produces no errors and does not exit", async () => {
    const { deps, errors, exitCodes } = makeDeps();
    await upgradeFlow(options, deps);

    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});

// ─── deploy: git ─────────────────────────────────────────────────────────────

describe("upgradeFlow – deploy: git", () => {
  const options: UpgradeFlowOptions = { version: "main", deploy: "git" };

  it("runs expected exec commands in order", async () => {
    const { deps, calls } = makeDeps();
    await upgradeFlow(options, deps);

    expect(calls).toEqual([
      "git pull --rebase --no-edit origin main",
      "wrangler d1 migrations apply AUTH_DB",
      "git push cloudflare main",
    ]);
  });

  it("logs git push success", async () => {
    const { deps, logs } = makeDeps();
    await upgradeFlow(options, deps);

    expect(logs.some((l) => l.includes("Git push successful"))).toBe(true);
  });

  it("does NOT run wrangler deploy", async () => {
    const { deps, calls } = makeDeps();
    await upgradeFlow(options, deps);

    expect(calls.some((c) => c === "wrangler deploy")).toBe(false);
  });

  it("produces no errors and does not exit", async () => {
    const { deps, errors, exitCodes } = makeDeps();
    await upgradeFlow(options, deps);

    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});

// ─── version forwarding ──────────────────────────────────────────────────────

describe("upgradeFlow – version forwarding", () => {
  it.each([["main"], ["v0.2.0"], ["v0.3.0"]])(
    "version=%s is passed to git pull",
    async (version) => {
      const { deps, calls } = makeDeps();
      await upgradeFlow({ version, deploy: undefined }, deps);

      expect(calls[0]).toBe(`git pull --rebase --no-edit origin ${version}`);
    },
  );
});

// ─── binary check ────────────────────────────────────────────────────────────

describe("upgradeFlow – binary checks", () => {
  it("exits with code 1 when git is not installed", async () => {
    const { deps, errors, exitCodes } = makeDeps({
      checkBinary: async () => false,
    });
    await upgradeFlow({ version: "main", deploy: undefined }, deps);

    expect(exitCodes).toEqual([1]);
    expect(errors.some((e) => e.includes("Git is not installed"))).toBe(true);
  });

  it("does not run any exec commands when git is missing", async () => {
    const { deps, calls } = makeDeps({ checkBinary: async () => false });
    await upgradeFlow({ version: "main", deploy: undefined }, deps);

    expect(calls).toEqual([]);
  });
});

// ─── exec error handling ─────────────────────────────────────────────────────

describe("upgradeFlow – exec error handling", () => {
  it("exits on git pull failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      { "git pull --rebase --no-edit origin main": fail("conflict") },
    );
    await upgradeFlow({ version: "main", deploy: undefined }, deps);

    expect(exitCodes).toEqual([1]);
    expect(errors.some((e) => e.includes("Error pulling from git"))).toBe(true);
  });

  it("does not run further commands after git pull failure", async () => {
    const { deps, calls } = makeDeps(
      {},
      { "git pull --rebase --no-edit origin main": fail("conflict") },
    );
    await upgradeFlow({ version: "main", deploy: undefined }, deps);

    expect(calls).toEqual(["git pull --rebase --no-edit origin main"]);
  });

  it("exits on D1 apply failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      { "wrangler d1 migrations apply AUTH_DB": fail("migration error") },
    );
    await upgradeFlow({ version: "main", deploy: undefined }, deps);

    expect(exitCodes).toEqual([1]);
    expect(
      errors.some((e) => e.includes("Error applying database schema")),
    ).toBe(true);
  });

  it("does not run deploy step after D1 apply failure", async () => {
    const { deps, calls } = makeDeps(
      {},
      { "wrangler d1 migrations apply AUTH_DB": fail("migration error") },
    );
    await upgradeFlow({ version: "main", deploy: "wrangler" }, deps);

    expect(calls.some((c) => c === "wrangler deploy")).toBe(false);
  });

  it("exits on wrangler deploy failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      { "wrangler deploy": fail("deploy error") },
    );
    await upgradeFlow({ version: "main", deploy: "wrangler" }, deps);

    expect(exitCodes).toEqual([1]);
    expect(
      errors.some((e) => e.includes("Error deploying with wrangler")),
    ).toBe(true);
  });

  it("exits on git push failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      { "git push cloudflare main": fail("rejected") },
    );
    await upgradeFlow({ version: "main", deploy: "git" }, deps);

    expect(exitCodes).toEqual([1]);
    expect(errors.some((e) => e.includes("Error pushing to git"))).toBe(true);
  });
});
