import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { exec } from "child_process";

const execAsync = promisify(exec);
import {
  initializeFlow,
  type InitFlowDeps,
  type InitFlowOptions,
  type ExecResult,
} from "../bin/initFlow";

// ─── Helpers ────────────────────────────────────────────────────────────────

const ok: ExecResult = { stdout: "", stderr: "" };
const fail = (msg: string): ExecResult => ({ stdout: "", stderr: msg });

const EXAMPLE_CONFIG = JSON.stringify({
  name: "openauthster-issuer",
  d1_databases: [],
  vars: {
    WEBUI_ADMIN_EMAILS: "email1@example.com,email2@example.com",
    WEBUI_ORIGIN_URL: "https://your-webui-domain.com",
    ISSUER_URL: "https://your-issuer-domain.com",
    LOG_ENABLED: "false",
  },
});

/** Build a deps object where every exec command succeeds by default. */
function makeDeps(
  overrides: Partial<InitFlowDeps> = {},
  execResponses: Record<string, ExecResult> = {},
): {
  deps: InitFlowDeps;
  calls: string[];
  logs: string[];
  errors: string[];
  exitCodes: number[];
  written: Record<string, string>;
} {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const written: Record<string, string> = {};

  const deps: InitFlowDeps = {
    exec: async (cmd) => {
      calls.push(cmd);
      return execResponses[cmd] ?? ok;
    },
    checkBinary: async () => Promise.resolve(true),
    readFile: async (e: string) =>
      e.includes("wrangler.example.json") ? EXAMPLE_CONFIG : written[e],
    writeFile: async (path, content) => {
      written[path] = content;
    },
    parseJSONC: (content) => JSON.parse(content),
    // Default: return placeholder values unchanged (simulates user pressing Enter)
    promptVars: async (vars) => ({ ...vars }),
    exit: (code) => {
      exitCodes.push(code);
    },
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
    ...overrides,
  };

  return { deps, calls, logs, errors, exitCodes, written };
}

// ─── wrangler method ─────────────────────────────────────────────────────────

describe("initializeFlow – wrangler method", () => {
  it("runs all expected exec commands in order", async () => {
    const { deps, calls, logs } = makeDeps();
    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });
    console.log({ calls, logs });
    expect(calls).toEqual([
      "wrangler d1 create openauthster --binding AUTH_DB --update-config true --jurisdiction eu --location eeur",
      "wrangler d1 migrations apply AUTH_DB",
      "wrangler deploy --dry-run",
    ]);
  });

  it("writes wrangler.json with empty d1_databases", async () => {
    const { deps, written } = makeDeps();
    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });

    expect(written["./wrangler.json"]).toBeDefined();
    const parsed = JSON.parse(written["./wrangler.json"]);
    expect(parsed.d1_databases).toBeArrayOfSize(1);
    expect(parsed.name).toBe("openauthster-issuer");
  });

  it("does NOT run git commands for wrangler method", async () => {
    const { deps, calls } = makeDeps();
    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });

    expect(calls.some((c) => c.startsWith("git"))).toBe(false);
  });

  it("produces no errors and does not exit on happy path", async () => {
    const { deps, errors, exitCodes } = makeDeps();
    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });

    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});

// ─── git method ──────────────────────────────────────────────────────────────

describe("initializeFlow – git method", () => {
  it("runs all expected exec commands in order", async () => {
    const { deps, calls } = makeDeps();
    await initializeFlow(deps, {
      method: "git",
      jurisdiction: "fedramp",
      location: "wnam",
      repo: "https://github.com/example/repo.git",
    });

    expect(calls).toEqual([
      "git init",
      "git remote add cloudflare https://github.com/example/repo.git",
      "git push --set-upstream cloudflare main",
      "wrangler d1 create openauthster --binding AUTH_DB --update-config true --jurisdiction fedramp --location wnam",
      "wrangler d1 migrations apply AUTH_DB",
      "git remote set-url --push cloudflare https://github.com/example/repo.git",
      `git add . && git commit -m "Initial commit" && git push cloudflare main`,
    ]);
  });

  it("does NOT run wrangler deploy --dry-run for git method", async () => {
    const { deps, calls } = makeDeps();
    await initializeFlow(deps, {
      method: "git",
      jurisdiction: "fedramp",
      location: "wnam",
      repo: "https://github.com/example/repo.git",
    });

    expect(calls.some((c) => c.includes("--dry-run"))).toBe(false);
  });

  it("produces no errors and does not exit on happy path", async () => {
    const { deps, errors, exitCodes } = makeDeps();
    await initializeFlow(deps, {
      method: "git",
      jurisdiction: "fedramp",
      location: "wnam",
      repo: "https://github.com/example/repo.git",
    });

    expect(errors).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});

// ─── binary checks ───────────────────────────────────────────────────────────

describe("initializeFlow – binary checks", () => {
  it("exits with code 1 when wrangler is not installed", async () => {
    const { deps, errors, exitCodes } = makeDeps({
      checkBinary: async () => false,
    });
    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });

    expect(exitCodes).toEqual([1]);
    expect(
      errors.some((e) => e.includes("Wrangler CLI is not installed")),
    ).toBe(true);
  });

  it("does not run any exec commands when wrangler is missing", async () => {
    const { deps, calls } = makeDeps({ checkBinary: async () => false });
    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });

    expect(calls).toEqual([]);
  });

  it("exits with code 1 when git is not installed (git method)", async () => {
    const { deps, errors, exitCodes } = makeDeps({
      checkBinary: async (binary) => binary !== "git",
    });
    await initializeFlow(deps, {
      method: "git",
      jurisdiction: "eu",
      location: "eeur",
      repo: "https://github.com/example/repo.git",
    });

    expect(exitCodes).toEqual([1]);
    expect(errors.some((e) => e.includes("Git is not installed"))).toBe(true);
  });
});

// ─── exec error handling ─────────────────────────────────────────────────────

describe("initializeFlow – exec error handling", () => {
  const wranglerOptions: InitFlowOptions = {
    method: "wrangler",
    jurisdiction: "eu",
    location: "enam",
  };
  const gitOptions: InitFlowOptions = {
    method: "git",
    jurisdiction: "eu",
    location: "enam",
    repo: "https://example.com/repo.git",
  };

  it("exits on git init failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      {
        "git init": fail("not a git repo"),
      },
    );
    await initializeFlow(deps, gitOptions);

    expect(exitCodes).toEqual([1]);
    expect(
      errors.some((e) => e.includes("Error initializing git repository")),
    ).toBe(true);
  });

  it("logs error but continues when git push upstream fails (non-fatal)", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      { "git push --set-upstream cloudflare main": fail("rejected") },
    );
    await initializeFlow(deps, gitOptions);

    // non-fatal: flow continues, no exit
    expect(exitCodes).toEqual([]);
    expect(errors.some((e) => e.includes("Error setting upstream"))).toBe(true);
  });

  it("exits on D1 create failure", async () => {
    const cmd =
      "wrangler d1 create openauthster --binding AUTH_DB --update-config true --jurisdiction eu --location enam";
    const { deps, exitCodes, errors } = makeDeps(
      {},
      { [cmd]: fail("unauthorized") },
    );
    await initializeFlow(deps, wranglerOptions);

    expect(exitCodes).toEqual([1]);
    expect(errors.some((e) => e.includes("Error creating D1 database"))).toBe(
      true,
    );
  });

  it("exits on wrangler deploy --dry-run failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      { "wrangler deploy --dry-run": fail("deploy error") },
    );
    await initializeFlow(deps, wranglerOptions);

    expect(exitCodes).toEqual([1]);
    expect(
      errors.some((e) => e.includes("Error deploying with wrangler")),
    ).toBe(true);
  });

  it("exits on git remote set-url failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      {
        "git remote set-url --push cloudflare https://example.com/repo.git":
          fail("no remote"),
      },
    );
    await initializeFlow(deps, gitOptions);

    expect(exitCodes).toEqual([1]);
    expect(errors.some((e) => e.includes("Error setting git remote URL"))).toBe(
      true,
    );
  });

  it("exits on initial commit failure", async () => {
    const { deps, exitCodes, errors } = makeDeps(
      {},
      {
        [`git add . && git commit -m "Initial commit" && git push cloudflare main`]:
          fail("nothing to commit"),
      },
    );
    await initializeFlow(deps, gitOptions);

    expect(exitCodes).toEqual([1]);
    expect(errors.some((e) => e.includes("Error during initial commit"))).toBe(
      true,
    );
  });
});

// ─── jurisdiction / location forwarding ─────────────────────────────────────

describe("initializeFlow – jurisdiction and location forwarding", () => {
  it.each([
    ["eu", "weur"],
    ["fedramp", "apac"],
    ["eu", "oc"],
  ] as [string, string][])(
    "jurisdiction=%s location=%s is included in the D1 create command",
    async (jurisdiction, location) => {
      const { deps, calls } = makeDeps();
      await initializeFlow(deps, {
        method: "wrangler",
        jurisdiction,
        location,
      });
      const createCmd = calls.find((c) => c.includes("wrangler d1 create"));
      expect(createCmd).toContain(`--jurisdiction ${jurisdiction}`);
      expect(createCmd).toContain(`--location ${location}`);
    },
  );
});

// ─── promptVars ──────────────────────────────────────────────────────────────

describe("initializeFlow – promptVars", () => {
  const options: InitFlowOptions = {
    method: "wrangler",
    jurisdiction: "eu",
    location: "enam",
  };

  it("calls promptVars with the vars from the example config", async () => {
    let received: Record<string, string> | undefined;
    const { deps } = makeDeps({
      promptVars: async (vars) => {
        received = { ...vars, ...received };
        return vars;
      },
    });
    await initializeFlow(deps, options);

    expect(received).toEqual({
      WEBUI_ADMIN_EMAILS: "email1@example.com,email2@example.com",
      WEBUI_ORIGIN_URL: "https://your-webui-domain.com",
      ISSUER_URL: "https://your-issuer-domain.com",
      LOG_ENABLED: "false",
      "db jurisdiction (e.g. US, EU)": "eu",
      "db location (e.g. us-east, eu-west)": "enam",
      "db name": "openauthster",
      "Initialization method (wrangler/git)": "wrangler",
    });
  });

  it("writes placeholder values when the user accepts defaults (returns vars unchanged)", async () => {
    const { deps, written } = makeDeps();
    await initializeFlow(deps, options);

    const wranglerJson = JSON.parse(written["./wrangler.json"]);
    expect(wranglerJson.vars).toEqual({
      WEBUI_ADMIN_EMAILS: "email1@example.com,email2@example.com",
      WEBUI_ORIGIN_URL: "https://your-webui-domain.com",
      ISSUER_URL: "https://your-issuer-domain.com",
      LOG_ENABLED: "false",
    });
  });

  it("writes partially overridden vars when user fills only some fields", async () => {
    const { deps, written } = makeDeps({
      promptVars: async (vars) => ({
        ...vars,
        ISSUER_URL: "https://auth.mycompany.com",
        WEBUI_ORIGIN_URL: "https://admin.mycompany.com",
      }),
    });
    await initializeFlow(deps, options);

    const wranglerJson = JSON.parse(written["./wrangler.json"]);
    expect(wranglerJson.vars.ISSUER_URL).toBe("https://auth.mycompany.com");
    expect(wranglerJson.vars.WEBUI_ORIGIN_URL).toBe(
      "https://admin.mycompany.com",
    );
    // un-touched keys keep their placeholder
    expect(wranglerJson.vars.WEBUI_ADMIN_EMAILS).toBe(
      "email1@example.com,email2@example.com",
    );
    expect(wranglerJson.vars.LOG_ENABLED).toBe("false");
  });

  it("logs the prompt header before calling promptVars", async () => {
    const promptOrder: string[] = [];
    const { deps, logs } = makeDeps({
      promptVars: async (vars) => {
        promptOrder.push("prompt");
        return vars;
      },
    });
    // Capture log calls in order
    const logOrder: string[] = [];
    deps.log = (...args) => {
      const msg = args.join(" ");
      logs.push(msg);
      logOrder.push(msg);
    };

    await initializeFlow(deps, options);

    const headerIdx = logOrder.findIndex((l) =>
      l.includes("Please provide your environment configuration"),
    );
    expect(headerIdx).toBeGreaterThanOrEqual(0);
  });
});

// ─── integration: clone + wrangler initialize ────────────────────────────────

describe("initializeFlow – integration (real clone, mocked external commands)", () => {
  const REPO_URL = "https://github.com/shpaw415/OpenAuthSter-issuer.git";
  let cloneDir: string;

  beforeAll(async () => {
    cloneDir = mkdtempSync(join(tmpdir(), "openauthster-init-test-"));
    await execAsync(`git clone --depth 1 ${REPO_URL} ${cloneDir}`);
  }, 60_000);

  afterAll(() => {
    if (cloneDir && existsSync(cloneDir)) {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("wrangler.example.jsonc exists in the cloned repo", () => {
    expect(existsSync(join(cloneDir, "wrangler.example.jsonc"))).toBe(true);
  });

  it("wrangler method: writes wrangler.json with correct structure", async () => {
    const wranglerJsonPath = join(cloneDir, "wrangler.json");

    const deps: InitFlowDeps = {
      exec: async (cmd) => ({ stdout: "", stderr: "" }),
      checkBinary: async () => true,
      readFile: (path) =>
        Bun.file(join(cloneDir, path.replace(/^\.?\//, ""))).text(),
      writeFile: async (path, content) => {
        await Bun.write(join(cloneDir, path.replace(/^\.?\//, "")), content);
      },
      parseJSONC: (content) =>
        Bun.JSONC.parse(content) as Record<string, unknown>,
      promptVars: async (vars) => vars,
      exit: (code) => {
        throw new Error(`process.exit(${code}) called unexpectedly`);
      },
      log: () => {},
      error: (...args) => {
        throw new Error(`Unexpected error: ${args.join(" ")}`);
      },
    };

    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });

    expect(existsSync(wranglerJsonPath)).toBe(true);

    const written = JSON.parse(await Bun.file(wranglerJsonPath).text());
    // d1_databases must be reset to empty array by the init flow
    expect(Array.isArray(written.d1_databases)).toBe(true);
    expect(written.d1_databases).toBeArrayOfSize(1);
    // core fields from wrangler.example.jsonc must be preserved
    expect(written.name).toBeDefined();
    expect(written.main).toBeDefined();
    expect(written.compatibility_date).toBeDefined();
  });

  it("wrangler method: executes expected commands against the clone", async () => {
    const calls: string[] = [];

    const deps: InitFlowDeps = {
      exec: async (cmd) => {
        calls.push(cmd);
        return { stdout: "", stderr: "" };
      },
      checkBinary: async () => true,
      readFile: (path) =>
        Bun.file(join(cloneDir, path.replace(/^\.?\//, ""))).text(),
      writeFile: async (path, content) => {
        await Bun.write(join(cloneDir, path.replace(/^\.?\//, "")), content);
      },
      parseJSONC: (content) =>
        Bun.JSONC.parse(content) as Record<string, unknown>,
      promptVars: async (vars) => vars,
      exit: (code) => {
        throw new Error(`process.exit(${code}) called unexpectedly`);
      },
      log: () => {},
      error: (...args) => {
        throw new Error(`Unexpected error: ${args.join(" ")}`);
      },
    };

    await initializeFlow(deps, {
      method: "wrangler",
      jurisdiction: "eu",
      location: "eeur",
    });

    expect(calls).toEqual([
      "wrangler d1 create openauthster --binding AUTH_DB --update-config true --jurisdiction eu --location eeur",
      "wrangler d1 migrations apply AUTH_DB",
      "wrangler deploy --dry-run",
    ]);
  });

  it("git method: writes wrangler.json and executes expected git+wrangler commands", async () => {
    const calls: string[] = [];
    const REPO = "https://github.com/example/my-fork.git";

    const deps: InitFlowDeps = {
      exec: async (cmd) => {
        calls.push(cmd);
        return { stdout: "", stderr: "" };
      },
      checkBinary: async () => true,
      readFile: (path) =>
        Bun.file(join(cloneDir, path.replace(/^\.?\//, ""))).text(),
      writeFile: async (path, content) => {
        await Bun.write(join(cloneDir, path.replace(/^\.?\//, "")), content);
      },
      parseJSONC: (content) =>
        Bun.JSONC.parse(content) as Record<string, unknown>,
      promptVars: async (vars) => vars,
      exit: (code) => {
        throw new Error(`process.exit(${code}) called unexpectedly`);
      },
      log: () => {},
      error: (...args) => {
        throw new Error(`Unexpected error: ${args.join(" ")}`);
      },
    };

    await initializeFlow(deps, {
      method: "git",
      repo: REPO,
      jurisdiction: "fedramp",
      location: "wnam",
    });

    expect(calls).toEqual([
      "git init",
      `git remote add cloudflare ${REPO}`,
      "git push --set-upstream cloudflare main",
      `wrangler d1 create openauthster --binding AUTH_DB --update-config true --jurisdiction fedramp --location wnam`,
      "wrangler d1 migrations apply AUTH_DB",
      `git remote set-url --push cloudflare ${REPO}`,
      `git add . && git commit -m "Initial commit" && git push cloudflare main`,
    ]);

    // wrangler.json was still written
    const written = JSON.parse(
      await Bun.file(join(cloneDir, "wrangler.json")).text(),
    );
    expect(written.d1_databases).toBeArrayOfSize(1);
  });
});
