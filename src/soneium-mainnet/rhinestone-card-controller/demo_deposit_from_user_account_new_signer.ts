import "dotenv/config";
import ora from "ora";
import {
  type Address,
  type Hex,
  encodeFunctionData,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

// Signer added via demo_controller_add_owner.ts
const newSignerPrivateKey = process.env.NEW_CONTROLLER_SIGNER_PRIVATE_KEY;
const controllerAddress = process.env.MAINNET_CARD_ACCOUNT_CONTROLLER as Address;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const cardAccountAddress = process.env.MAINNET_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = process.env.MAINNET_USDSC_ADDRESS as Address;
// Target standing balance = max balance the card is allowed to hold + amount already held.
// Defaults are small on purpose — this is real mainnet USDSC. Override for larger tests.
const maxBalanceUsdsc = process.env.CARD_MAX_BALANCE_USDSC ?? "1";
const heldBalanceUsdsc = process.env.CARD_HELD_BALANCE_USDSC ?? "0";

if (
  !newSignerPrivateKey ||
  !controllerAddress ||
  !controllerValidatorAddress ||
  !rhinestoneApiKey ||
  !cardAccountAddress ||
  !usdscAddress
) {
  throw new Error(
    "NEW_CONTROLLER_SIGNER_PRIVATE_KEY, MAINNET_CARD_ACCOUNT_CONTROLLER, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, MAINNET_CARD_ACCOUNT_ADDRESS, or MAINNET_USDSC_ADDRESS is not set"
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

const chain = soneium;
const signer = privateKeyToAccount(newSignerPrivateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing controller Nexus account (type: startale) with new signer...");

    const account = await createRhinestoneAccount({
      account: { type: "startale" as const },
      owners: {
        type: "ecdsa",
        accounts: [signer],
        module: controllerValidatorAddress,
      },
      // Pin to the deployed controller — a different owner set would derive a different address
      initData: { address: controllerAddress },
      apiKey: rhinestoneApiKey,
    });

    const nexusAddress = account.getAddress();
    spinner.succeed(`Controller account: ${chalk.cyan(nexusAddress)}`);
    console.log("EOA (new signer):", signer.address);
    console.log("Card account:", cardAccountAddress);

    const targetStandingBalance = parseUnits(maxBalanceUsdsc, 6) + parseUnits(heldBalanceUsdsc, 6);
    console.log(
      `Target standing balance: ${maxBalanceUsdsc} (max) + ${heldBalanceUsdsc} (held) = ${targetStandingBalance} units USDSC`
    );

    spinner.start("Checking deployment status...");
    if (!(await account.isDeployed(chain))) {
      throw new Error("Controller account is not deployed");
    }
    spinner.succeed("Controller account is deployed");

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
