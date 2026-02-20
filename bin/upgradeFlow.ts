export type ExecResult = { stdout: string; stderr: string };
export type ExecFn = (cmd: string) => Promise<ExecResult>;

export interface UpgradeFlowOptions {
  /** Branch / tag to pull. "latest" is resolved to "main" before calling this function. */
  version: string;
  deploy: "none" | "wrangler" | "git";
}

export interface UpgradeFlowDeps {
  exec: ExecFn;
  checkBinary: (binary: string) => Promise<boolean>;
  exit: (code: number) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export async function upgradeFlow(
  options: UpgradeFlowOptions,
  deps: UpgradeFlowDeps,
): Promise<void> {
  const { exec, checkBinary, exit, log, error } = deps;

  const gitExists = await checkBinary("git");
  if (!gitExists) {
    error(
      "Git is not installed. Please install it from https://git-scm.com/downloads",
    );
    exit(1);
    return;
  }

  log(
    `Upgrading to version: ${options.version} with deploy method: ${options.deploy}...`,
  );

  const gitResult = await exec(
    `git pull --rebase --no-edit origin ${options.version}`,
  );
  if (gitResult.stderr) {
    error("Error pulling from git:", gitResult.stderr);
    exit(1);
    return;
  }

  const dbResult = await exec(`wrangler d1 apply AUTH_DB`);
  if (dbResult.stderr) {
    error("Error applying database schema:", dbResult.stderr);
    exit(1);
    return;
  }

  log("Upgrade successful!");

  if (options.deploy === "none") {
    log(
      "now deploy the server using `wrangler deploy` or push to your private github repo to trigger a deployment",
    );
  } else if (options.deploy === "wrangler") {
    const deployResult = await exec(`wrangler deploy`);
    if (deployResult.stderr) {
      error("Error deploying with wrangler:", deployResult.stderr);
      exit(1);
      return;
    }
    log("Deployment successful!");
  } else if (options.deploy === "git") {
    const gitPushResult = await exec(`git push`);
    if (gitPushResult.stderr) {
      error("Error pushing to git:", gitPushResult.stderr);
      exit(1);
      return;
    }
    log("Git push successful!");
  }
}
