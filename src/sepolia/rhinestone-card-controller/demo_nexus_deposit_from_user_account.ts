import "dotenv/config";
import ora from "ora";
import {
  type Address,
  type Hex,
  encodeFunctionData,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const cardAccountAddress = process.env.NEXUS_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;
const depositAmountUsdsc = process.env.DEPOSIT_AMOUNT_USDSC ?? "500";

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey || !cardAccountAddress) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, or NEXUS_CARD_ACCOUNT_ADDRESS is not set"
  );
}

const CARD_ACCOUNT_ABI = [
  {
    name: "depositFromUserAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "tokenAmount",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const chain = sepolia;

const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Nexus account (card controller)...");

    const account = await createRhinestoneAccount({
      account: { type: "nexus", version: "1.2.0" },
      owners: {
        type: "ecdsa",
        accounts: [signer],
        threshold: 1,
        module: controllerValidatorAddress,
      },
      apiKey: rhinestoneApiKey,
    });

    const nexusAddress = account.getAddress();
    spinner.succeed(`Nexus account (controller): ${chalk.cyan(nexusAddress)}`);
    console.log("EOA (signer):", signer.address);
    console.log("Card account:", cardAccountAddress);

    spinner.start("Checking deployment status...");
    await account.isDeployed(chain);
    spinner.succeed("Deployment status checked");

    const amount = parseUnits(depositAmountUsdsc, 6);
    console.log(`Depositing ${depositAmountUsdsc} USDSC (${amount} units) → card account`);

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "depositFromUserAccount",
      args: [{ token: usdscAddress, amount }],
    });

    spinner.start("Sending depositFromUserAccount via sendTransaction (sponsored)...");

    const result = await account.sendTransaction({
      chain,
      calls: [{ to: cardAccountAddress, data: callData, value: 0n }],
      sponsored: true,
    });

    console.log("\nIntent result:", result);

    spinner.start("Waiting for execution...");
    const status = await account.waitForExecution(result);

    spinner.succeed(
      chalk.greenBright.bold(
        `Deposited ${depositAmountUsdsc} USDSC from user account into card account`
      )
    );
    console.log("Status:", status);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
