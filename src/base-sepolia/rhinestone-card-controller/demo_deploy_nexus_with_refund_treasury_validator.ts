import "dotenv/config";
import ora from "ora";
import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.REFUND_ACTOR_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey) {
  throw new Error(
    "REFUND_ACTOR_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, or RHINESTONE_API_KEY is not set"
  );
}

const chain = baseSepolia;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Nexus account (type: startale, refund treasury)...");

    // Same setup as the controller account (Startale factory + ControllerValidator
    // multi-owner module), but owned by the refund signer. Owners can be rotated
    // later via addOwner/removeOwner on the validator.
    const account = await createRhinestoneAccount({
      account: { type: "startale" as const },
      owners: {
        type: "ecdsa",
        accounts: [signer],
        module: controllerValidatorAddress,
      },
      apiKey: rhinestoneApiKey,
    });

    const address = account.getAddress();
    spinner.succeed(`Refund treasury account address: ${chalk.cyan(address)}`);
    console.log("EOA (refund signer):", signer.address);
    console.log("ControllerValidator:", controllerValidatorAddress);

    spinner.start("Checking deployment status...");
    const deployed = await account.isDeployed(chain);
    spinner.succeed(`Already deployed: ${deployed}`);

    if (deployed) {
      spinner.succeed(chalk.greenBright.bold("Refund treasury account already deployed — nothing to do"));
      process.exit(0);
    }

    spinner.start("Deploying refund treasury account (Rhinestone sponsored)...");
    await account.deploy(chain, { sponsored: true });

    spinner.succeed(
      chalk.greenBright.bold(`Refund treasury account deployed at ${chalk.cyan(address)}`)
    );
    console.log(`\nSet BASE_SEPOLIA_REFUND_TREASURY=${address} in .env`);
    console.log(`Fund it with USDSC — it is the payout address for refunds and cashbacks`);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
