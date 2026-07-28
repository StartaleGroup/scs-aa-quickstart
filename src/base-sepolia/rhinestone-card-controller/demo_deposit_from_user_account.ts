import "dotenv/config";
import ora from "ora";
import {
  type Address,
  type Hex,
  encodeFunctionData,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const cardAccountAddress = process.env.BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = "0x610e208ef737a7918202B4CDD554B0D89d5cEA01" as Address;
// Target standing balance = max balance the card is allowed to hold + amount already held
const maxBalanceUsdsc = process.env.CARD_MAX_BALANCE_USDSC ?? "500";
const heldBalanceUsdsc = process.env.CARD_HELD_BALANCE_USDSC ?? "20";

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey || !cardAccountAddress) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, or BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS is not set"
  );
}

const CARD_ACCOUNT_ABI = [
  {
    name: "topUpToTarget",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "tokenTarget",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "targetStandingBalance", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountDeposited", type: "uint256" }],
  },
  {
    name: "MustTopUpToTarget",
    type: "error",
    inputs: [],
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

    const targetStandingBalance = parseUnits(maxBalanceUsdsc, 6) + parseUnits(heldBalanceUsdsc, 6);
    console.log(
      `Target standing balance: ${maxBalanceUsdsc} (max) + ${heldBalanceUsdsc} (held) = ${targetStandingBalance} units USDSC`
    );

    spinner.start("Checking deployment status...");
    await account.isDeployed(chain);
    spinner.succeed("Deployment status checked");

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "topUpToTarget",
      args: [{ token: usdscAddress, targetStandingBalance }],
    });

    spinner.start("Sending topUpToTarget via sendTransaction (sponsored)...");


    const result = await account.sendTransaction({
      chain,
      calls: [{ to: cardAccountAddress, value: 0n, data: callData }],
      sponsored: true,
    });
    

    console.log("\nIntent result:", result);
    spinner.start("Waiting for execution...");

    const status = await account.waitForExecution(result);
    spinner.succeed(
      chalk.greenBright.bold(
        `Topped up card account to standing balance target of ${maxBalanceUsdsc} + ${heldBalanceUsdsc} USDSC`
      )
    );
    console.log("Status:", status);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
