import "dotenv/config";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import { toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
if (!privateKey) throw new Error("OWNER_PRIVATE_KEY not set");

const K1_DEFAULT_VALIDATOR = "0x00000072f286204bb934ed49d8969e86f7dec7b1" as `0x${string}`;
const INTENT_EXECUTOR      = "0x00000000005aD9ce1f5035FD62CA96CEf16AdAAF" as `0x${string}`;

const chain = sepolia;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  console.log(chalk.bold("\n=== Rhinestone ↔ Startale Address Parity Check ===\n"));
  console.log("Signer (EOA):", chalk.cyan(signer.address));
  console.log();

  // Startale SDK: include intent executor in initData to match Rhinestone's setup
  const startaleAccount = await toStartaleSmartAccount({
    signer,
    chain,
    transport: http(),
    index: 0n,
    executors: [{ module: INTENT_EXECUTOR, data: "0x" }],
  });

  // Rhinestone SDK: explicit K1 module required for address parity with Startale SDK
  const rhinestoneAccount = await createRhinestoneAccount({
    account: { type: "startale" },
    owners: {
      type: "ecdsa",
      accounts: [signer],
      module: K1_DEFAULT_VALIDATOR,
    },
    provider: {
      type: "custom" as const,
      urls: { [chain.id]: chain.rpcUrls.default.http[0] },
    },
  });

  const startaleAddress    = startaleAccount.address;
  const rhinestoneAddress  = rhinestoneAccount.getAddress();
  const match = startaleAddress.toLowerCase() === rhinestoneAddress.toLowerCase();

  console.log("Startale SDK address  :", chalk.cyan(startaleAddress));
  console.log("Rhinestone SDK address:", chalk.cyan(rhinestoneAddress));
  console.log();

  console.log(
    match
      ? chalk.greenBright.bold("✔  Addresses MATCH — both SDKs derive the same counterfactual address.")
      : chalk.red("✖  Addresses DO NOT MATCH")
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
