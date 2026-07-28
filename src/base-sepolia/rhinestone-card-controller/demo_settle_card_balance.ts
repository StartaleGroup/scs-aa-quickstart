import "dotenv/config";
import ora from "ora";
import {
  type Address,
  type Hex,
  encodeFunctionData,
  parseUnits,
  keccak256,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const cardAccountAddress = process.env.BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS as Address;
const settleRecipient = (process.env.SETTLE_RECIPIENT ?? "0x22C9Baf7A0db2190AD74fCE24faBD68Ec6F97DAc") as Address;
const usdscAddress = "0x610e208ef737a7918202B4CDD554B0D89d5cEA01" as Address;
const settleAmountUsdsc = process.env.SETTLE_AMOUNT_USDSC ?? "10";
const settlementUid = process.env.SETTLEMENT_UID as Hex | undefined;

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey || !cardAccountAddress) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, or BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS is not set"
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

const chain = baseSepolia;
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing controller Nexus account (type: startale)...");

    const account = await createRhinestoneAccount({
      account: { type: "startale" as const },
      owners: {
        type: "ecdsa",
        accounts: [signer],
        module: controllerValidatorAddress,
      },
      apiKey: rhinestoneApiKey,
    });

    const nexusAddress = account.getAddress();
    spinner.succeed(`Controller account: ${chalk.cyan(nexusAddress)}`);
    console.log("EOA (signer):", signer.address);
    console.log("Card account:", cardAccountAddress);
    console.log("Recipient:", settleRecipient);

    spinner.start("Checking deployment status...");
    await account.isDeployed(chain);
    spinner.succeed("Deployment status checked");

    const amount = parseUnits(settleAmountUsdsc, 6);

    const uid: Hex = settlementUid
      ? settlementUid
      : keccak256(
          encodePacked(
            ["address", "address", "uint256"],
            [cardAccountAddress, settleRecipient, amount]
          )
        );

    console.log(`Settling ${settleAmountUsdsc} USDSC → ${settleRecipient}`);
    console.log("Settlement uid:", uid);

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "settleCardBalance",
      args: [settleRecipient, { token: usdscAddress, amount }, uid],
    });

    spinner.start("Sending settleCardBalance via sendTransaction (sponsored)...");

    const result = await account.sendTransaction({
      chain,
      calls: [{ to: cardAccountAddress, value: 0n, data: callData }],
      sponsored: true,
    });

    console.log("\nIntent result:", result);
    spinner.start("Waiting for execution...");

    const status = await account.waitForExecution(result);
    spinner.succeed(
      chalk.greenBright.bold(`Settled ${settleAmountUsdsc} USDSC to ${settleRecipient}`)
    );
    console.log("Status:", status);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
