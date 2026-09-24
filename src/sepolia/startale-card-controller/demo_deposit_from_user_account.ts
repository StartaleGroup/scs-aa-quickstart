import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  parseUnits,
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
// Amount in USDSC (6 decimals), e.g. DEPOSIT_AMOUNT_USDSC=10 deposits 10 USDSC
const depositAmountUsdsc = process.env.DEPOSIT_AMOUNT_USDSC ?? "500";

if (!bundlerUrl || !privateKey || !cardAccountAddress) {
  throw new Error(
    "SEPOLIA_BUNDLER_URL, OWNER_PRIVATE_KEY, or CARD_ACCOUNT_ADDRESS is not set"
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
        index: BigInt(0),
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      // paymaster: scsPaymasterClient,
      // paymasterContext: scsContext,
    });

    const userAccount = smartAccountClient.account.address;
    spinner.succeed(`Smart account (controller): ${userAccount}`);
    console.log("EOA:", signer.address);
    console.log("Card account:", cardAccountAddress);

    const amount = parseUnits(depositAmountUsdsc, 6);
    console.log(`Depositing ${depositAmountUsdsc} USDSC (${amount} units) → card account`);

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "depositFromUserAccount",
      args: [{ token: usdscAddress, amount }],
    });

    spinner.start("Sending depositFromUserAccount UserOp...");
    const opHash = await smartAccountClient.sendUserOperation({
      calls: [{ to: cardAccountAddress, value: BigInt(0), data: callData }],
    });
    console.log("\nUserOp hash:", opHash);

    spinner.start("Waiting for receipt...");
    const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    console.log("Tx hash:", result.receipt.transactionHash);

    spinner.succeed(
      chalk.greenBright.bold(
        `Deposited ${depositAmountUsdsc} USDSC from smart account to card account`
      )
    );
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
