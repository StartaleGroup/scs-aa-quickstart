import "dotenv/config";
import ora from "ora";
import { http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const pimlicoApiKey = process.env.PIMLICO_API_KEY;

if (!privateKey || !controllerValidatorAddress || !pimlicoApiKey) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, or PIMLICO_API_KEY is not set"
  );
}

const chain = sepolia;

const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Rhinestone Nexus account...");

    const account = await createRhinestoneAccount({
      account: { type: "nexus", version: "1.2.0" },

      owners: {
        type: "ecdsa",
        accounts: [signer],
        threshold: 1,
        module: controllerValidatorAddress,
      },

      bundler: { type: "pimlico" as const, apiKey: pimlicoApiKey },

      provider: {
        type: "custom" as const,
        urls: { [chain.id]: chain.rpcUrls.default.http[0] },
      },
    });

    const nexusAddress = account.getAddress();
    spinner.succeed(`Nexus account: ${chalk.cyan(nexusAddress)}`);
    console.log("EOA (signer):", signer.address);
    console.log("ControllerValidator:", controllerValidatorAddress);

    spinner.start("Sending 0-value self-send UserOp via ControllerValidator...");

    const result = await account.sendUserOperation({
      chain,
      calls: [{ to: nexusAddress, value: 0n, data: "0x" }],
    });

    console.log("\nUserOp hash:", result.hash);

    spinner.start("Waiting for receipt...");
    const receipt = await account.waitForExecution(result);
    console.log("Tx hash:", receipt.receipt.transactionHash);

    spinner.succeed(
      chalk.greenBright.bold("ControllerValidator validated UserOp successfully")
    );
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
