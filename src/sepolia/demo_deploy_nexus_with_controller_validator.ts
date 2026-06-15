import "dotenv/config";
import ora from "ora";
import { http, type Address, type Hex, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!bundlerUrl || !privateKey || !controllerValidatorAddress) {
  throw new Error(
    "SEPOLIA_BUNDLER_URL, OWNER_PRIVATE_KEY, or CONTROLLER_VALIDATOR_ADDRESS is not set"
  );
}

const chain = sepolia;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Nexus account with ControllerValidator...");

    const account = await createRhinestoneAccount({
      // Auth (optional for local bundler usage; required for Rhinestone orchestration)
      ...(rhinestoneApiKey && {
        auth: { mode: "apiKey" as const, apiKey: rhinestoneApiKey },
      }),

      account: {
        type: "nexus",
      },

      owners: {
        type: "ecdsa",
        accounts: [signer],
        threshold: 1,
        module: controllerValidatorAddress,
      },

      bundler: {
        type: "custom",
        url: { [chain.id]: bundlerUrl } as Record<number, string>,
      },

      provider: {
        type: "custom",
        urls: {
          [chain.id]: (
            createPublicClient({ transport: http(), chain }).transport as any
          ).url ?? chain.rpcUrls.default.http[0],
        },
      },
    });

    const address = account.getAddress();
    spinner.succeed(`Nexus account address: ${chalk.cyan(address)}`);
    console.log("EOA (signer):", signer.address);
    console.log("ControllerValidator:", controllerValidatorAddress);

    spinner.start("Checking deployment status...");
    const deployed = await account.isDeployed(chain);
    console.log("\nAlready deployed:", deployed);

    if (!deployed) {
      spinner.start("Deploying Nexus account...");
      const success = await account.deploy(chain);

      if (success) {
        spinner.succeed(
          chalk.greenBright.bold(
            `Nexus account deployed with ControllerValidator at ${address}`
          )
        );
      } else {
        spinner.fail(chalk.red("Deployment returned false — check bundler logs"));
      }
    } else {
      spinner.succeed(
        chalk.greenBright.bold("Nexus account already deployed")
      );
    }
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
