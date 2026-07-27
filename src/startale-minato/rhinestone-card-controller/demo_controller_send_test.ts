import "dotenv/config";
import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneiumMinato } from "viem/chains";
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

const chain = soneiumMinato;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  console.log(chalk.bold("\n=== Controller account: sendUserOperation vs sendTransaction (Minato) ===\n"));
  console.log("Signer (EOA):", chalk.cyan(signer.address));
  console.log("ControllerValidator:", chalk.cyan(controllerValidatorAddress));

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
  console.log("Account:", chalk.cyan(address));

  // Required warm-up — Rhinestone intent orchestrator fetches on-chain state
  const deployed = await account.isDeployed(chain);
  console.log("Deployed:", deployed);

  if (!deployed) {
    console.log("\nDeploying (sponsored)...");
    await account.deploy(chain, { sponsored: true });
    console.log(chalk.green("Deployed ✔"));
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
