import "dotenv/config";
import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

// Signer added via demo_controller_add_owner.ts
const newSignerPrivateKey = process.env.NEW_CONTROLLER_SIGNER_PRIVATE_KEY;
const controllerAddress = process.env.BASE_SEPOLIA_CARD_ACCOUNT_CONTROLLER as Address;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!newSignerPrivateKey || !controllerAddress || !controllerValidatorAddress || !rhinestoneApiKey) {
  throw new Error(
    "NEW_CONTROLLER_SIGNER_PRIVATE_KEY, BASE_SEPOLIA_CARD_ACCOUNT_CONTROLLER, CONTROLLER_VALIDATOR_ADDRESS, or RHINESTONE_API_KEY is not set"
  );
}

const chain = baseSepolia;
const signer = privateKeyToAccount(newSignerPrivateKey as Hex);

const main = async () => {
  console.log(chalk.bold("\n=== Controller account (new signer): sendUserOperation vs sendTransaction (Base Sepolia) ===\n"));
  console.log("Signer (EOA):", chalk.cyan(signer.address));
  console.log("ControllerValidator:", chalk.cyan(controllerValidatorAddress));

  // The address is derived from the owner set, so a different signer would yield a different
  // account — pin it to the already-deployed controller via initData.address
  const account = await createRhinestoneAccount({
    account: { type: "startale" as const },
    owners: {
      type: "ecdsa",
      accounts: [signer],
      module: controllerValidatorAddress,
    },
    initData: { address: controllerAddress },
    apiKey: rhinestoneApiKey,
  });

  const address = account.getAddress();
  console.log("Account:", chalk.cyan(address));

  const deployed = await account.isDeployed(chain);
  console.log("Deployed:", deployed);

  if (!deployed) {
    throw new Error("Controller account is not deployed — the new signer can only operate an existing controller");
  }

  // ── sendUserOperation ────────────────────────────────────────────────────────
  console.log(chalk.bold("\n[1] sendUserOperation (ERC-4337 bundler path)"));
  try {
    const result = await account.sendUserOperation({
      chain,
      calls: [{ to: address, value: 0n, data: "0x" }],
    });
    console.log("UserOp hash:", result.hash);
    const status = await account.waitForExecution(result);
    console.log(chalk.greenBright("✔ sendUserOperation succeeded"), status);
  } catch (e) {
    console.log(chalk.red("✖ sendUserOperation failed:"), (e as Error).message);
  }

  // ── sendTransaction ──────────────────────────────────────────────────────────
  console.log(chalk.bold("\n[2] sendTransaction (intent path, sponsored)"));
  try {
    const result = await account.sendTransaction({
      chain,
      calls: [{ to: address, value: 0n, data: "0x" }],
      sponsored: true,
    });
    console.log("Intent result:", result);
    const status = await account.waitForExecution(result);
    console.log(chalk.greenBright("✔ sendTransaction succeeded"), status);
  } catch (e) {
    console.log(chalk.red("✖ sendTransaction failed:"), (e as Error).message);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
