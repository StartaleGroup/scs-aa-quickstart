import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  keccak256,
  toHex,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSCSPaymasterClient, createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const paymasterId = process.env.PAYMASTER_ID;
const cardAccountFactoryAddress = process.env.CARD_ACCOUNT_FACTORY_ADDRESS as Address;

if (!bundlerUrl || !paymasterUrl || !privateKey || !cardAccountFactoryAddress) {
  throw new Error(
    "SEPOLIA_BUNDLER_URL, PAYMASTER_SERVICE_URL, OWNER_PRIVATE_KEY, or CARD_ACCOUNT_FACTORY_ADDRESS is not set"
  );
}

const CARD_ACCOUNT_FACTORY_ABI = [
  {
    name: "makeNewCardAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "userAccount", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "clone", type: "address" }],
  },
] as const;

const chain = sepolia;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(bundlerUrl),
});

const scsPaymasterClient = createSCSPaymasterClient({
  transport: http(paymasterUrl),
});

const signer = privateKeyToAccount(privateKey as Hex);

const scsContext = { calculateGasLimits: true, paymasterId: paymasterId };

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing smart account...");

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer: signer,
        chain: chain,
        transport: http(),
        index: BigInt(1),
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      // paymaster: scsPaymasterClient,
      // paymasterContext: scsContext,
    });

    const userAccount = smartAccountClient.account.address;
    spinner.succeed(`Smart account: ${userAccount}`);
    console.log("EOA:", signer.address);
    console.log("CardAccountFactory:", cardAccountFactoryAddress);

    // Derive a deterministic salt from the smart account address so re-runs
    // are idempotent (same salt → same clone address, factory will revert if
    // already deployed, which surfaces cleanly in the error handler).
    const salt = keccak256(toHex(userAccount)) as Hex;
    console.log("Salt:", salt);

    const callData = encodeFunctionData({
      abi: CARD_ACCOUNT_FACTORY_ABI,
      functionName: "makeNewCardAccount",
      args: [userAccount, salt as `0x${string}`],
    });

    spinner.start("Sending UserOp to makeNewCardAccount...");

    const opHash = await smartAccountClient.sendUserOperation({
      calls: [
        {
          to: cardAccountFactoryAddress,
          value: BigInt(0),
          data: callData,
        },
      ],
    });

    console.log("\nUserOp hash:", opHash);
    spinner.start("Waiting for receipt...");

    const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    console.log("Tx hash:", result.receipt.transactionHash);

    spinner.succeed(chalk.greenBright.bold("Card account created successfully"));
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
