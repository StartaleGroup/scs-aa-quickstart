import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  isHex,
  keccak256,
  maxUint256,
  parseUnits,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const treasuryPrivateKey = process.env.REFUND_ACTOR_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const cardAccountAddress = process.env.BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = "0x610e208ef737a7918202B4CDD554B0D89d5cEA01" as Address;
const cashbackAmountUsdsc = process.env.CASHBACK_AMOUNT_USDSC ?? "5";
// bytes32 hex used as-is; any other string is hashed (keccak256) into a bytes32 id
const campaignIdInput = process.env.CASHBACK_CAMPAIGN_ID ?? "demo-cashback-campaign";

if (!treasuryPrivateKey || !controllerValidatorAddress || !rhinestoneApiKey || !cardAccountAddress) {
  throw new Error(
    "REFUND_ACTOR_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, or BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS is not set"
  );
}

const CARD_ACCOUNT_ABI = [
  {
    name: "depositForCashback",
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
      { name: "campaignId", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const chain = baseSepolia;
const signer = privateKeyToAccount(treasuryPrivateKey as Hex);
const publicClient = createPublicClient({ transport: http(), chain });

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    // Refund treasury (payout) smart account — handles refunds and cashbacks; deployed via demo_deploy_nexus_with_refund_treasury_validator.ts
    const account = await createRhinestoneAccount({
      account: { type: "startale" as const },
      owners: {
        type: "ecdsa",
        accounts: [signer],
        module: controllerValidatorAddress,
      },
      apiKey: rhinestoneApiKey,
    });
    const treasuryAddress = account.getAddress();

    console.log("Refund signer (EOA):", signer.address);
    console.log("Refund treasury account:", treasuryAddress);
    console.log("Card account:", cardAccountAddress);

    if (!(await account.isDeployed(chain))) {
      throw new Error(
        "Refund treasury account is not deployed — run demo_deploy_nexus_with_refund_treasury_validator.ts first"
      );
    }

    const amount = parseUnits(cashbackAmountUsdsc, 6);
    const campaignId =
      isHex(campaignIdInput) && campaignIdInput.length === 66
        ? (campaignIdInput as Hex)
        : keccak256(toHex(campaignIdInput));
    console.log(`Cashback ${cashbackAmountUsdsc} USDSC (${amount} units) → card account`);
    console.log(`Campaign: ${campaignIdInput} → ${campaignId}`);

    spinner.start("Checking USDSC balance and allowance...");
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({
        address: usdscAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [treasuryAddress],
      }),
      publicClient.readContract({
        address: usdscAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [treasuryAddress, cardAccountAddress],
      }),
    ]);
    if (balance < amount) {
      throw new Error(`Refund treasury USDSC balance ${balance} is below cashback amount ${amount}`);
    }
    spinner.succeed(`USDSC balance: ${balance}, allowance: ${allowance}`);

    // Approve (only if needed) + depositForCashback batched in one smart account execution
    const calls = [];
    if (allowance < amount) {
      console.log("Including USDSC approve (infinite) for card account");
      calls.push({
        to: usdscAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [cardAccountAddress, maxUint256],
        }),
      });
    }
    calls.push({
      to: cardAccountAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: CARD_ACCOUNT_ABI,
        functionName: "depositForCashback",
        args: [{ token: usdscAddress, amount }, campaignId],
      }),
    });

    spinner.start("Sending depositForCashback via refund treasury account (sponsored)...");
    const result = await account.sendTransaction({ chain, calls, sponsored: true });
    console.log("\nIntent result:", result);

    spinner.start("Waiting for execution...");
    const status = await account.waitForExecution(result);
    spinner.succeed(
      chalk.greenBright.bold(`Paid ${cashbackAmountUsdsc} USDSC cashback from treasury to card account`)
    );
    console.log("Status:", status);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
