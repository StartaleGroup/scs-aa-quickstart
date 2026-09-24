import "dotenv/config";
import ora from "ora";
import { http, type Address, createPublicClient, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const pimlicoApiKey = process.env.PIMLICO_API_KEY;

if (!privateKey || !controllerValidatorAddress) {
  throw new Error("OWNER_PRIVATE_KEY or CONTROLLER_VALIDATOR_ADDRESS is not set");
}
if (!rhinestoneApiKey && !pimlicoApiKey) {
  throw new Error("Either RHINESTONE_API_KEY or PIMLICO_API_KEY is required");
}

const chain = sepolia;
// Pimlico requires maxPriorityFeePerGas >= ~0.072 gwei on Sepolia; the default
// viem estimation returns 0.002 gwei which gets rejected. Override to 0.1 gwei.
const sepoliaWithMinFees = {
  ...sepolia,
  fees: {
    estimateFeesPerGas: async () => ({
      maxFeePerGas: parseGwei("50"),
      maxPriorityFeePerGas: parseGwei("2"),
    }),
  },
};
const signer = privateKeyToAccount(privateKey as `0x${string}`);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Nexus account with ControllerValidator...");

    const account = await createRhinestoneAccount({
      ...(rhinestoneApiKey && {
        auth: { mode: "apiKey" as const, apiKey: rhinestoneApiKey },
      }),

      account: { type: "nexus", version: "1.2.0" },

      owners: {
        type: "ecdsa",
        accounts: [signer],
        threshold: 1,
        module: controllerValidatorAddress,
      },

      // type: 'custom' forces useCustomBundler=true in the SDK, routing deploy()
      // through deployWithBundler (direct bundler call) instead of deployWithIntent
      // (Rhinestone orchestrator, requires Rhinestone API key). Pimlico whitelists
      // Rhinestone contracts so the storage-access check passes.
      ...(pimlicoApiKey && {
        bundler: {
          type: "custom" as const,
          url: `https://api.pimlico.io/v2/${chain.id}/rpc?apikey=${pimlicoApiKey}`,
        },
      }),

      // Explicit provider so the SDK uses the chain's public RPC rather than
      // falling back to Rhinestone's own RPC service (which requires auth).
      provider: {
        type: "custom" as const,
        urls: {
          [chain.id]: (createPublicClient({ transport: http(), chain }).transport as any).url
            ?? chain.rpcUrls.default.http[0],
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

    if (deployed) {
      spinner.succeed(chalk.greenBright.bold("Nexus account already deployed"));
      process.exit(0);
    }

    spinner.start("Deploying Nexus account via Pimlico...");
    const success = await account.deploy(sepoliaWithMinFees as typeof sepolia);

    if (!success) {
      spinner.fail(chalk.red("Deployment returned false — check Pimlico logs"));
      process.exit(1);
    }

    spinner.succeed(chalk.greenBright.bold(`Nexus account deployed with ControllerValidator at ${address}`));
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
