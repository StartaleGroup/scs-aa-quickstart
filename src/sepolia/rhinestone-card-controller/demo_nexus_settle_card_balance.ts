import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  encodeFunctionData,
  parseUnits,
  keccak256,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const pimlicoApiKey = process.env.PIMLICO_API_KEY;
const cardAccountAddress = process.env.NEXUS_CARD_ACCOUNT_ADDRESS as Address;
const settleRecipient = (process.env.SETTLE_RECIPIENT ?? "0x22C9Baf7A0db2190AD74fCE24faBD68Ec6F97DAc") as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;
const settleAmountUsdsc = process.env.SETTLE_AMOUNT_USDSC ?? "10";
const settlementUid = process.env.SETTLEMENT_UID as Hex | undefined;

if (!privateKey || !controllerValidatorAddress || !pimlicoApiKey || !cardAccountAddress) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, PIMLICO_API_KEY, or NEXUS_CARD_ACCOUNT_ADDRESS is not set"
  );
}

const CARD_ACCOUNT_ABI = [
  {
    name: "settleCardBalance",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      {
        name: "tokenAmount",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      { name: "uid", type: "bytes32" },
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
    console.log("Recipient:", settleRecipient);

    const amount = parseUnits(settleAmountUsdsc, 6);

    const uid: Hex = settlementUid
      ? (settlementUid as Hex)
      : keccak256(
          encodePacked(
            ["address", "address", "uint256"],
            [cardAccountAddress, settleRecipient, amount]
          )
        );

    console.log(`Settling ${settleAmountUsdsc} USDSC → recipient ${settleRecipient}`);
    console.log("Settlement uid:", uid);

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "settleCardBalance",
      args: [settleRecipient, { token: usdscAddress, amount }, uid],
    });

    spinner.start("Sending settleCardBalance UserOp via ControllerValidator...");

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
        `Settled ${settleAmountUsdsc} USDSC to ${settleRecipient}`
      )
    );
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
