import "dotenv/config";
import ora from "ora";
import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, or RHINESTONE_API_KEY is not set"
  );
}

const chain = soneium;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Nexus account (type: startale, controller validator)...");

    // type: 'startale' uses Startale's factory — same address space as
    // toStartaleSmartAccount from @startale-scs/aa-sdk.
    // Using controllerValidatorAddress (not K1) so this account can authorize
    // card account operations (deposit, settle) as the CARD_ACCOUNT_CONTROLLER.
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
    spinner.succeed(`Nexus account address: ${chalk.cyan(address)}`);
    console.log("EOA (signer):", signer.address);
    console.log("ControllerValidator:", controllerValidatorAddress);

    spinner.start("Checking deployment status...");
    const deployed = await account.isDeployed(chain);
    spinner.succeed(`Already deployed: ${deployed}`);

    if (deployed) {
      spinner.succeed(chalk.greenBright.bold("Controller account already deployed — nothing to do"));
      process.exit(0);
    }

    spinner.start("Deploying controller account (Rhinestone sponsored)...");
    await account.deploy(chain, { sponsored: true });

    spinner.succeed(
      chalk.greenBright.bold(`Controller account deployed at ${chalk.cyan(address)}`)
    );
    console.log(`\nSet MAINNET_CARD_ACCOUNT_CONTROLLER=${address} in .env`);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
