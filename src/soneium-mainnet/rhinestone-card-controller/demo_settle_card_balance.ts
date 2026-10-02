import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  parseUnits,
  keccak256,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const cardAccountAddress = process.env.MAINNET_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = process.env.MAINNET_USDSC_ADDRESS as Address;
// No hardcoded fallback recipient here — this moves real USDSC on mainnet.
const settleRecipient = process.env.SETTLE_RECIPIENT as Address;
const settleAmountUsdsc = process.env.SETTLE_AMOUNT_USDSC ?? "0.5";
const settlementUid = process.env.SETTLEMENT_UID as Hex | undefined;

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey || !cardAccountAddress || !usdscAddress || !settleRecipient) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, MAINNET_CARD_ACCOUNT_ADDRESS, MAINNET_USDSC_ADDRESS, or SETTLE_RECIPIENT is not set"
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

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const chain = soneium;
const publicClient = createPublicClient({ transport: http(), chain });
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

    const cardBalance = await publicClient.readContract({
      address: usdscAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [cardAccountAddress],
    });
    console.log(`Card account USDSC balance: ${cardBalance} units (need ${amount})`);

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "settleCardBalance",
      args: [settleRecipient, { token: usdscAddress, amount }, uid],
    });

    spinner.start("Preflight-simulating settleCardBalance locally (as controller)...");
    try {
      await publicClient.simulateContract({
        address: cardAccountAddress,
        abi: CARD_ACCOUNT_ABI,
        functionName: "settleCardBalance",
        args: [settleRecipient, { token: usdscAddress, amount }, uid],
        account: nexusAddress,
      });
      spinner.succeed("Local simulation succeeded");
    } catch (simError) {
      spinner.fail(chalk.red("Local simulation reverted — see details below"));
      console.error(simError);
      throw simError;
    }

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
