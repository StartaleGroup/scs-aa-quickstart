import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  maxUint256,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const cardAccountAddress = process.env.CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;

if (!bundlerUrl || !privateKey || !cardAccountAddress) {
  throw new Error(
    "SEPOLIA_BUNDLER_URL, OWNER_PRIVATE_KEY, or CARD_ACCOUNT_ADDRESS is not set"
  );
}

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

const chain = sepolia;
const publicClient = createPublicClient({ transport: http(), chain });
const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(bundlerUrl),
});
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing smart account...");

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer,
        chain,
        transport: http(),
        index: BigInt(1),
      }),
      transport: http(bundlerUrl),
      client: publicClient,
    });

    const userAccount = smartAccountClient.account.address;
    spinner.succeed(`Smart account: ${userAccount}`);
    console.log("EOA:", signer.address);
    console.log("Card account:", cardAccountAddress);
    console.log("USDSC:", usdscAddress);

    spinner.start("Checking existing USDSC allowance...");
    const currentAllowance = await publicClient.readContract({
      address: usdscAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [userAccount, cardAccountAddress],
    });
    console.log(`\nCurrent USDSC allowance: ${currentAllowance}`);

    if (currentAllowance === maxUint256) {
      spinner.succeed(chalk.greenBright.bold("Unlimited USDSC approval already set — skipping"));
    } else {
      spinner.start("Sending USDSC approval UserOp...");

      const approveCallData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [cardAccountAddress, maxUint256],
      });

      const opHash = await smartAccountClient.sendUserOperation({
        calls: [{ to: usdscAddress, value: BigInt(0), data: approveCallData }],
      });
      console.log("\nUserOp hash:", opHash);

      spinner.start("Waiting for receipt...");
      const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
      console.log("Tx hash:", result.receipt.transactionHash);

      spinner.succeed(
        chalk.greenBright.bold(
          `Unlimited USDSC approval granted to card account ${cardAccountAddress}`
        )
      );
    }
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
