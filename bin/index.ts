import { Command } from "commander";
import { version } from "../package.json";
import { exec } from "child_process";
import { createInterface } from "readline";
import { initializeFlow } from "./initFlow";
import { upgradeFlow } from "./upgradeFlow";

const execSync = async (
  command: string,
): Promise<{ stdout: string; stderr: string }> => {
  const res = Bun.spawnSync(command.split(" "));
  return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};

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
      options.version === "latest" ? "main" : options.version;
    await upgradeFlow(
      {
        version: targetVersion,
        deploy: options.deploy as "none" | "wrangler" | "git",
      },
      {
        exec: execSync,
        checkBinary: checkBinaryExists,
        exit: (code) => process.exit(code),
        log: console.log,
        error: console.error,
      },
    );
  });

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
    await initializeFlow(
      {
        method: options.method as "wrangler" | "git",
        jurisdiction: options.jurisdiction,
        location: options.location,
        repo: options.repo,
      },
      {
        exec: execSync,
        checkBinary: checkBinaryExists,
        readFile: (path) => Bun.file(path).text(),
        writeFile: (path, content) => Bun.write(path, content).then(() => {}),
        parseJSONC: (content) =>
          Bun.JSONC.parse(content) as Record<string, unknown>,
        promptVars: async (vars) => {
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const result: Record<string, string> = {};
          for (const [key, placeholder] of Object.entries(vars)) {
            result[key] = await new Promise((resolve) => {
              rl.question(`  ${key} [${placeholder}]: `, (answer) =>
                resolve(answer.trim() || placeholder),
              );
            });
          }
          rl.close();
          return result;
        },
        exit: (code) => process.exit(code),
        log: console.log,
        error: console.error,
      },
    );
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
