import "dotenv/config";
import ora from "ora";
import {
  http,
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
const pimlicoApiKey = process.env.PIMLICO_API_KEY;
const cardAccountAddress = process.env.NEXUS_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;
const depositAmountUsdsc = process.env.DEPOSIT_AMOUNT_USDSC ?? "500";

if (!privateKey || !controllerValidatorAddress || !pimlicoApiKey || !cardAccountAddress) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, PIMLICO_API_KEY, or NEXUS_CARD_ACCOUNT_ADDRESS is not set"
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

      // 'pimlico' type calls pimlico_getUserOperationGasPrice for correct fee
      // estimation. Safe to use here since the account is already deployed —
      // deploy() inside sendUserOperation is a no-op when isDeployed = true.
      bundler: { type: "pimlico" as const, apiKey: pimlicoApiKey },

      provider: {
        type: "custom" as const,
        urls: { [chain.id]: chain.rpcUrls.default.http[0] },
      },
    });

    const nexusAddress = account.getAddress();
    spinner.succeed(`Nexus account (controller): ${chalk.cyan(nexusAddress)}`);
    console.log("EOA (signer):", signer.address);
    console.log("Card account:", cardAccountAddress);

    const amount = parseUnits(depositAmountUsdsc, 6);
    console.log(`Depositing ${depositAmountUsdsc} USDSC (${amount} units) → card account`);

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "depositFromUserAccount",
      args: [{ token: usdscAddress, amount }],
    });

    spinner.start("Sending depositFromUserAccount UserOp via ControllerValidator...");

    const result = await account.sendUserOperation({
      chain,
      calls: [{ to: cardAccountAddress, data: callData, value: 0n }],
    });

    console.log("\nUserOp hash:", result.hash);

    spinner.start("Waiting for receipt...");
    const receipt = await account.waitForExecution(result);
    console.log("Tx hash:", receipt.receipt.transactionHash);

    spinner.succeed(
      chalk.greenBright.bold(
        `Deposited ${depositAmountUsdsc} USDSC from user account into card account`
      )
    );
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
