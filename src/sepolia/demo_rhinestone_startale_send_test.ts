import "dotenv/config";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!privateKey || !rhinestoneApiKey) throw new Error("OWNER_PRIVATE_KEY or RHINESTONE_API_KEY not set");

const K1_DEFAULT_VALIDATOR = "0x00000072f286204bb934ed49d8969e86f7dec7b1" as `0x${string}`;

const chain = sepolia;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  console.log(chalk.bold("\n=== Rhinestone sendTransaction vs sendUserOperation (K1 module) ===\n"));
  console.log("Signer (EOA):", chalk.cyan(signer.address));

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
  console.log("Account:", chalk.cyan(address));

  const deployed = await account.isDeployed(chain);
  console.log("Deployed:", deployed);
  if (!deployed) {
    console.log("\nDeploying (sponsored)...");
    await account.deploy(chain, { sponsored: true });
    console.log(chalk.green("Deployed ✔"));
  }

  // ── sendTransaction ──────────────────────────────────────────────────────────
  console.log(chalk.bold("\n[1] sendTransaction (intent path, sponsored)"));
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

  // ── sendUserOperation ────────────────────────────────────────────────────────
  console.log(chalk.bold("\n[2] sendUserOperation (ERC-4337 bundler path)"));
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
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
