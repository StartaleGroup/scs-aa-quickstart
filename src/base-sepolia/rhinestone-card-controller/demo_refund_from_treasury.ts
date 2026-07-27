import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  maxUint256,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import chalk from "chalk";

const treasuryPrivateKey = process.env.REFUND_ACTOR_PRIVATE_KEY;
const cardAccountAddress = process.env.BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = "0x610e208ef737a7918202B4CDD554B0D89d5cEA01" as Address;
const refundAmountUsdsc = process.env.REFUND_AMOUNT_USDSC ?? "20";

if (!treasuryPrivateKey || !cardAccountAddress) {
  throw new Error(
    "REFUND_ACTOR_PRIVATE_KEY or BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS is not set"
  );
}

const CARD_ACCOUNT_ABI = [
  {
    name: "depositForRefund",
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
] as const;

const chain = baseSepolia;
const treasury = privateKeyToAccount(treasuryPrivateKey as Hex);
const publicClient = createPublicClient({ transport: http(), chain });
const walletClient = createWalletClient({ account: treasury, transport: http(), chain });

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    console.log("Treasury (settlement) EOA:", treasury.address);
    if (process.env.SETTLE_RECIPIENT && process.env.SETTLE_RECIPIENT.toLowerCase() !== treasury.address.toLowerCase()) {
      console.log(
        chalk.yellow(
          `Warning: REFUND_ACTOR_PRIVATE_KEY resolves to ${treasury.address}, which does not match SETTLE_RECIPIENT (${process.env.SETTLE_RECIPIENT})`
        )
      );
    }
    console.log("Card account:", cardAccountAddress);

    const amount = parseUnits(refundAmountUsdsc, 6);
    console.log(`Refunding ${refundAmountUsdsc} USDSC (${amount} units) → card account`);

    spinner.start("Checking USDSC allowance...");
    const allowance = await publicClient.readContract({
      address: usdscAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [treasury.address, cardAccountAddress],
    });

    if (allowance < amount) {
      spinner.start("Approving USDSC (infinite) for card account...");
      const approveHash = await walletClient.writeContract({
        address: usdscAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [cardAccountAddress, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      spinner.succeed(`Approved USDSC: ${chalk.cyan(approveHash)}`);
    } else {
      spinner.succeed("Sufficient USDSC allowance already set");
    }

    spinner.start("Sending depositForRefund...");
    const hash = await walletClient.writeContract({
      address: cardAccountAddress,
      abi: CARD_ACCOUNT_ABI,
      functionName: "depositForRefund",
      args: [{ token: usdscAddress, amount }],
    });
    console.log("\nTx hash:", hash);

    spinner.start("Waiting for receipt...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    spinner.succeed(
      chalk.greenBright.bold(`Refunded ${refundAmountUsdsc} USDSC from treasury to card account`)
    );
    console.log("Status:", receipt.status);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
