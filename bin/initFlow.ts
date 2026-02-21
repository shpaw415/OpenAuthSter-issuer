export type ExecResult = { stdout: string; stderr: string };
export type ExecFn = (cmd: string) => Promise<ExecResult>;

export interface InitFlowOptions {
  method: "wrangler" | "git";
  jurisdiction: string;
  location: string;
  repo?: string;
}

export interface InitFlowDeps<
  T extends Record<string, string> = Record<string, string>,
> {
  exec: ExecFn;
  checkBinary: (binary: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  parseJSONC: (content: string) => Record<string, unknown>;
  /** Prompt the user to fill in each var. Receives the vars from the example
   * config (key → placeholder) and returns the user-supplied values. */
  promptVars: (vars: T) => Promise<Record<keyof T, string>>;
  exit: (code: number) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const validMethods = ["wrangler", "git"];

export async function initializeFlow(
  deps: InitFlowDeps,
  options: Partial<InitFlowOptions>,
): Promise<void> {
  const {
    exec,
    checkBinary,
    readFile,
    writeFile,
    parseJSONC,
    promptVars,
    exit,
    log,
    error,
  } = deps;

  const wranglerExists = await checkBinary("wrangler");
  if (!wranglerExists) {
    error(
      "Wrangler CLI is not installed. Please install it from https://developers.cloudflare.com/workers/wrangler/install-and-update/",
    );
    exit(1);
    return;
  }

  const method = (await promptVars({
    "Initialization method (wrangler/git)": options.method ?? "wrangler",
  })
    .then((answers) => Object.entries(answers).at(0)![1])
    .then((m) =>
      ["git", "wrangler"].includes(m.toLowerCase())
        ? m.toLowerCase()
        : (() => {
            throw new Error("Invalid method: " + m);
          })(),
    )) as "wrangler" | "git";

  if (!validMethods.includes(method)) {
    error(
      `Invalid initialization method: ${method}. Valid methods are: ${validMethods.join(", ")}`,
    );
    exit(1);
    return;
  }

  const repo =
    method == "git"
      ? await promptVars({
          "Git repository URL (must be a repository you have push access to)":
            options.repo ?? "http://example.com/repo.git",
        }).then(
          (answers) =>
            answers[
              "Git repository URL (must be a repository you have push access to)"
            ],
        )
      : undefined;

  if (method === "git") {
    const gitExists = await checkBinary("git");
    if (!gitExists) {
      error(
        "Git is not installed. Please install it from https://git-scm.com/downloads",
      );
      exit(1);
      return;
    }

    if (!repo) {
      error("Git repository URL is required for git initialization.");
      exit(1);
      return;
    }

    const gitInitResult = await exec(`git init`);
    if (gitInitResult.stderr) {
      error("Error initializing git repository:", gitInitResult.stderr);
      exit(1);
      return;
    }

    const gitCreateResult = await exec(`git remote add cloudflare ${repo}`);
    if (
      gitCreateResult.stderr &&
      !gitCreateResult.stderr.includes("remote cloudflare already exists")
    ) {
      console.log({ gitCreateResult });
      error("Error initializing git repository:", gitCreateResult.stderr);
      console.log(
        "error has occured you may continue but may encounter issues",
      );
    }

    const gitPushResult = await exec(`git push --set-upstream cloudflare main`);
    if (
      gitPushResult.stderr &&
      !gitPushResult.stderr.includes("Everything up-to-date") &&
      !gitPushResult.stderr.endsWith("main -> main\n")
    ) {
      console.log({ gitPushResult });
      error("Error setting upstream and pushing to git:", gitPushResult.stderr);
      console.log(
        "error has occured you may continue but may encounter issues",
      );
    }
  }

  log("Generating wrangler.json configuration...");

  const wranglerExampleFile = await readFile("./wrangler.example.jsonc");
  let wranglerConfig = parseJSONC(wranglerExampleFile) as {
    d1_databases: Array<{
      binding: string;
      database_name: string;
      database_id: string;
      migrations_dir: string;
      remote: boolean;
    }>;
    vars: Record<string, string>;
  };

  wranglerConfig.d1_databases = [];

  // Prompt the user to fill in environment-specific vars
  const exampleVars = (wranglerConfig.vars ?? {}) as Record<string, string>;
  log(
    "\nPlease provide your environment configuration (press Enter to keep the placeholder):",
  );
  const filledVars = await promptVars(exampleVars);
  wranglerConfig.vars = filledVars;

  await writeFile("./wrangler.json", JSON.stringify(wranglerConfig, null, 2));
  log("wrangler.json configuration generated successfully!");

  const dbInfo = await promptVars({
    "db name": "openauthster",
    "db jurisdiction (e.g. US, EU)": options.jurisdiction ?? "US",
    "db location (e.g. us-east, eu-west)": options.location ?? "us-east",
  });

  const dbParsedInfo = {
    name: dbInfo["db name"],
    jurisdiction: dbInfo["db jurisdiction (e.g. US, EU)"],
    location: dbInfo["db location (e.g. us-east, eu-west)"],
  };

  const createDBResult = await exec(
    `wrangler d1 create ${dbParsedInfo.name} --binding AUTH_DB --update-config true --jurisdiction ${dbParsedInfo.jurisdiction} --location ${dbParsedInfo.location}`,
  );
  if (createDBResult.stderr) {
    console.log({ createDBResult });
    error("Error creating D1 database:", createDBResult.stderr);
    if (
      createDBResult.stderr.includes("database with that name already exists")
    ) {
      const res = await promptVars({
        "the database already exists. Do you want to continue? (yes/no)": "no",
      });
      const acceptedValues = ["yes", "y", "true"];
      if (
        !acceptedValues.includes(
          res[
            "the database already exists. Do you want to continue? (yes/no)"
          ].toLowerCase(),
        )
      ) {
        log("Exiting initialization.");
        exit(0);
        return;
      }
      console.log(
        `\x1b[31m ${"-".repeat(10)}\n\n > YOU MUST ENTER MANUALY YOUR DATABASE CREDENTIALS INTO THE VARS IN wrangler.json BEFORE DEPLOYING \n\n${"-".repeat(10)}\x1b[0m`,
      );
      Bun.sleepSync(3000);
    } else {
      exit(1);
      return;
    }
  }

  log("D1 database created successfully!");

  wranglerConfig = JSON.parse(
    await readFile("./wrangler.json"),
  ) as typeof wranglerConfig;

  if (process.env.NODE_ENV === "test") {
    log("Mocking database information for testing...");
    wranglerConfig.d1_databases.push({
      binding: "AUTH_DB",
      database_name: "test_db",
      database_id: "test_db_id",
      migrations_dir: "drizzle/migrations",
      remote: true,
    });
  }

  wranglerConfig.d1_databases.find(
    (db) => db.binding === "AUTH_DB",
  )!.migrations_dir = "drizzle/migrations";

  await writeFile("./wrangler.json", JSON.stringify(wranglerConfig, null, 2));

  const dbResult = await exec(`wrangler d1 migrations apply AUTH_DB`);
  if (dbResult.stderr) {
    error("Error applying database schema:", dbResult.stderr);
    exit(1);
    return;
  }

  if (method === "wrangler") {
    const deployResult = await exec(`wrangler deploy --dry-run`);
    if (deployResult.stderr) {
      error("Error deploying with wrangler:", deployResult.stderr);
      exit(1);
      return;
    }
    log(
      "Dry run deployment successful! Now run `wrangler deploy` to deploy the server.",
    );
  } else if (method === "git") {
    const setUrlResult = await exec(
      `git remote set-url --push cloudflare ${repo}`,
    );
    if (setUrlResult.stderr) {
      error("Error setting git remote URL:", setUrlResult.stderr);
      exit(1);
      return;
    }

    const initialCommitResult = await exec(
      `git add . && git commit -m "Initial commit" && git push cloudflare main`,
    );
    if (initialCommitResult.stderr) {
      error(
        "Error during initial commit and push:",
        initialCommitResult.stderr,
      );
      exit(1);
      return;
    }
  }

  log("Initialization successful!");
}
