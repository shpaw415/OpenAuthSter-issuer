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
  .option("-r, --repo <repo>", "Git repository URL for git initialization")
  .description("Initialize the OpenAuth Multitenant Server")
  .action(async () => {
    await initializeFlow(
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
      {},
    );
  });

function checkBinaryExists(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`which ${binary}`, (error) => {
      resolve(!error);
    });
  });
}

program.parse(process.argv);
