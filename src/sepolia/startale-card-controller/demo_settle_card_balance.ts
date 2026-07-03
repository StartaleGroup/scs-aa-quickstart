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
  toHex,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const cardAccountAddress = process.env.CARD_ACCOUNT_ADDRESS as Address;
const settleRecipient = (process.env.SETTLE_RECIPIENT ?? "0x22C9Baf7A0db2190AD74fCE24faBD68Ec6F97DAc") as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;
// Amount in USDSC (6 decimals), e.g. SETTLE_AMOUNT_USDSC=5 settles 5 USDSC
const settleAmountUsdsc = process.env.SETTLE_AMOUNT_USDSC ?? "10";
// Unique settlement id — deterministically derived from recipient + amount if not provided
const settlementUid = process.env.SETTLEMENT_UID as Hex | undefined;

if (!bundlerUrl || !privateKey || !cardAccountAddress) {
  throw new Error(
    "SEPOLIA_BUNDLER_URL, OWNER_PRIVATE_KEY, or CARD_ACCOUNT_ADDRESS is not set"
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
    console.log("Recipient:", settleRecipient);

    const amount = parseUnits(settleAmountUsdsc, 6);

    // Derive uid from recipient + amount + card account if not explicitly provided,
    // so each unique (recipient, amount, card) triple gets a stable uid in demos.
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

    spinner.start("Sending settleCardBalance UserOp...");
    const opHash = await smartAccountClient.sendUserOperation({
      calls: [{ to: cardAccountAddress, value: BigInt(0), data: callData }],
    });
    console.log("\nUserOp hash:", opHash);

    spinner.start("Waiting for receipt...");
    const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    console.log("Tx hash:", result.receipt.transactionHash);

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
