import { Command } from "commander";
import { version } from "../package.json";
import { exec } from "child_process";
import { promisify } from "util";

const execSync = promisify(exec);

const program = new Command();

program
  .name("openauth-multitenant-server-cli")
  .description("CLI for OpenAuth Multitenant Server")
  .version(version);

program
  .command("upgrade")
  .description("Upgrade the OpenAuth Multitenant Server")
  .option(
    "-v, --version <version>",
    "Specify the version to update to",
    "latest",
  )
  .option("-d, --deploy <method>", "Deploy using wrangler or git", "none")
  .action(async (options) => {
    const targetVersion =
      options.version == "latest" ? "main" : options.version;
    const deployMethod = options.deploy as "none" | "wrangler" | "git";

    const execSync = promisify(exec);

    await ensureGitExists();

    console.log(
      `Upgrading to version: ${targetVersion} with deploy method: ${deployMethod}...`,
    );

    const gitResult = await execSync(
      `git pull --rebase --no-edit origin ${targetVersion}`,
    );
    if (gitResult.stderr) {
      console.error("Error pulling from git:", gitResult.stderr);
      process.exit(1);
    }
    const dbResult = await execSync(`wrangler d1 apply AUTH_DB`);
    if (dbResult.stderr) {
      console.error("Error applying database schema:", dbResult.stderr);
      process.exit(1);
    }
    console.log("Upgrade successful!");

    if (deployMethod === "none")
      console.log(
        "now deploy the server using `wrangler deploy` or push to your private github repo to trigger a deployment",
      );
    else if (deployMethod === "wrangler") {
      const deployResult = await execSync(`wrangler deploy`);
      if (deployResult.stderr) {
        console.error("Error deploying with wrangler:", deployResult.stderr);
        process.exit(1);
      }
      console.log("Deployment successful!");
    } else if (deployMethod === "git") {
      const gitPushResult = await execSync(`git push`);
      if (gitPushResult.stderr) {
        console.error("Error pushing to git:", gitPushResult.stderr);
        process.exit(1);
      }
      console.log("Git push successful!");
    }
  });

const validMethods = ["wrangler", "git"];
program
  .command("initialize")
  .requiredOption(
    "-m, --method <method>",
    "Initialization method (wrangler or git)",
  )
  .requiredOption(
    "-j, --jurisdiction <jurisdiction>",
    'Jurisdiction for the server ["eu", "fedramp"]',
    "eu",
  )
  .requiredOption(
    "-l, --location <location>",
    "Location for the server \nweur: Western Europe\neeur: Eastern Europe\napac: Asia Pacific\noc: Oceania\nwnam: Western North America\nenam: Eastern North America",
    "enam",
  )
  .option("-r, --repo <repo>", "Git repository URL for git initialization")
  .description("Initialize the OpenAuth Multitenant Server")
  .action(async (options) => {
    await ensureWranglerExists();

    const method = options.method as "wrangler" | "git";

    if (!validMethods.includes(method)) {
      console.error(
        `Invalid initialization method: ${method}. Valid methods are: ${validMethods.join(", ")}`,
      );
      process.exit(1);
    }

    if (method === "git") {
      await ensureGitExists();
      if (!options.repo) {
        console.error("Git repository URL is required for git initialization.");
        process.exit(1);
      }

      const gitCreateResult = await execSync(
        `git init && git remote add cloudflare ${options.repo}`,
      );
      if (gitCreateResult.stderr) {
        console.error(
          "Error initializing git repository:",
          gitCreateResult.stderr,
        );
        process.exit(1);
      }

      const gitPushResult = await execSync(
        `git push --set-upstream cloudflare main`,
      );
      if (gitPushResult.stderr) {
        console.error(
          "Error setting upstream and pushing to git:",
          gitPushResult.stderr,
        );
        process.exit(1);
      }
    }

    console.log("Generating wrangler.json configuration...");
    const wranglerExempleFile = await Bun.file(
      "./wrangler.example.json",
    ).text();
    const wranglerConfig = Bun.JSONC.parse(
      wranglerExempleFile,
    ) as typeof import("../wrangler.json");

    wranglerConfig.d1_databases = [];

    await Bun.write("./wrangler.json", JSON.stringify(wranglerConfig, null, 2));
    console.log("wrangler.json configuration generated successfully!");

    const createDBResult = await execSync(
      `wrangler d1 create openauthster --binding AUTH_DB --update-config true --remote true --jurisdiction ${options.jurisdiction} --location ${options.location}`,
    );

    if (createDBResult.stderr) {
      console.error("Error creating D1 database:", createDBResult.stderr);
      process.exit(1);
    }

    console.log("D1 database created successfully!");

    const dbResult = await execSync(`wrangler d1 apply AUTH_DB`);
    if (dbResult.stderr) {
      console.error("Error applying database schema:", dbResult.stderr);
      process.exit(1);
    }

    if (method === "wrangler") {
      const deployResult = await execSync(`wrangler deploy --dry-run`);
      if (deployResult.stderr) {
        console.error("Error deploying with wrangler:", deployResult.stderr);
        process.exit(1);
      }
      console.log(
        "Dry run deployment successful! Now run `wrangler deploy` to deploy the server.",
      );
    } else if (method === "git") {
      const gitPushResult = await execSync(
        `git remote set-url --push cloudflare ${options.repo}`,
      );
      if (gitPushResult.stderr) {
        console.error("Error setting git remote URL:", gitPushResult.stderr);
        process.exit(1);
      }
      const initialCommitResult = await execSync(
        `git add . && git commit -m "Initial commit" && git push cloudflare main`,
      );
      if (initialCommitResult.stderr) {
        console.error(
          "Error during initial commit and push:",
          initialCommitResult.stderr,
        );
        process.exit(1);
      }
    }
    console.log("Initialization successful!");
  });

function checkBinaryExists(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`which ${binary}`, (error) => {
      resolve(!error);
    });
  });
}

async function ensureWranglerExists() {
  const exists = await checkBinaryExists("wrangler");
  if (!exists) {
    console.error(
      "Wrangler CLI is not installed. Please install it from https://developers.cloudflare.com/workers/wrangler/install-and-update/",
    );
    process.exit(1);
  }
}

async function ensureGitExists() {
  const exists = await checkBinaryExists("git");
  if (!exists) {
    console.error(
      "Git is not installed. Please install it from https://git-scm.com/downloads",
    );
    process.exit(1);
  }
}

program.parse(process.argv);
