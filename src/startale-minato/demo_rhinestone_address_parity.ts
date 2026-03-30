import "dotenv/config";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneiumMinato } from "viem/chains";
import { toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import { RhinestoneSDK } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!privateKey) throw new Error("OWNER_PRIVATE_KEY is not set");
if (!rhinestoneApiKey) throw new Error("RHINESTONE_API_KEY is not set");

const chain = soneiumMinato;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  console.log(chalk.cyan("\n=== Rhinestone ↔ Startale Address Parity Check ===\n"));
  console.log(chalk.gray(`Signer (EOA): ${signer.address}\n`));

  // ── 1. Startale account with rhinestoneCompatible: true ──────────────────
  const startaleAccount = await toStartaleSmartAccount({
    chain: chain as any,
    transport: http() as any,
    signer: signer as any,
    index: 0n,
    rhinestoneCompatible: { sessionsEnabled: true } , // builds initData identical to Rhinestone SDK (no sessions)
  });
  const startaleAddress = await startaleAccount.getAddress();
  console.log(chalk.blue("Startale SDK address :"), chalk.white(startaleAddress));

  // ── 2. Rhinestone account (same owner, index 0, sessions off) ────────────
  const rhinestone = new RhinestoneSDK({ apiKey: rhinestoneApiKey });
  const rhinestoneAccount = await rhinestone.createAccount({
    account: { type: "startale" },
    owners: { type: "ecdsa", accounts: [signer], module: "0x00000072f286204bb934ed49d8969e86f7dec7b1" },
    experimental_sessions: { enabled: true }, // matches { sessionsEnabled: true } in startaleAccount
  });
  const rhinestoneAddress = rhinestoneAccount.getAddress();
  console.log(chalk.blue("Rhinestone SDK address:"), chalk.white(rhinestoneAddress));

  // ── 3. Compare ────────────────────────────────────────────────────────────
  console.log();
  const match = startaleAddress.toLowerCase() === rhinestoneAddress.toLowerCase();
  if (match) {
    console.log(chalk.green("✔  Addresses MATCH — both SDKs derive the same counterfactual address."));
  } else {
    console.log(chalk.red("✘  Addresses DO NOT match."));
    console.log(chalk.red(`   Startale  : ${startaleAddress}`));
    console.log(chalk.red(`   Rhinestone: ${rhinestoneAddress}`));
    process.exitCode = 1;
  }
  console.log();
};

main().catch((err) => {
  console.error(chalk.red(`Error: ${(err as Error).message}`));
  process.exit(1);
});
