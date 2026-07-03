import "dotenv/config";
import ora from "ora";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const K1_DEFAULT_VALIDATOR = "0x00000072f286204bb934ed49d8969e86f7dec7b1" as `0x${string}`;

const privateKey = process.env.OWNER_PRIVATE_KEY;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!privateKey || !rhinestoneApiKey) {
  throw new Error("OWNER_PRIVATE_KEY or RHINESTONE_API_KEY is not set");
}

const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Rhinestone account (type:startale + K1 validator)...");

    const account = await createRhinestoneAccount({
      account: { type: "startale" as const },
      owners: {
        type: "ecdsa",
        accounts: [signer],
        module: K1_DEFAULT_VALIDATOR,
      },
      apiKey: rhinestoneApiKey,
    });

    const address = account.getAddress();
    spinner.succeed(`Account: ${chalk.cyan(address)}`);

    spinner.start("Checking deployment status...");
    const deployed = await account.isDeployed(sepolia);
    spinner.succeed(`Deployed: ${deployed}`);

    spinner.start("Sending no-op via sendTransaction (sponsored)...");

    const result = await account.sendTransaction({
      chain: sepolia,
      calls: [{ to: address, value: 0n, data: "0x" }],
      sponsored: true,
    });

    console.log("\nIntent result:", result);
    spinner.start("Waiting for execution...");

    const status = await account.waitForExecution(result);
    spinner.succeed(chalk.greenBright.bold("sendTransaction no-op succeeded"));
    console.log("Status:", status);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
