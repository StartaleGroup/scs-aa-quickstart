import "dotenv/config";
import ora from "ora";
import { http, type Hex, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.BASE_SEPOLIA_BUNDLER_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;

if (!bundlerUrl || !privateKey) {
  throw new Error("BASE_SEPOLIA_BUNDLER_URL or OWNER_PRIVATE_KEY is not set");
}

const chain = baseSepolia;
const publicClient = createPublicClient({ transport: http(), chain });
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Startale user AA account (Base Sepolia, no paymaster)...");

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer,
        chain,
        transport: http(),
        index: 100n,
      }),
      transport: http(bundlerUrl),
      client: publicClient,
    });

    const address = smartAccountClient.account.address;
    spinner.succeed(`User AA address: ${chalk.cyan(address)}`);
    console.log("EOA (signer):", signer.address);

    spinner.start("Sending no-op UserOperation (self-call, 0 ETH)...");

    const hash = await smartAccountClient.sendUserOperation({
      calls: [{ to: address, value: 0n, data: "0x" }],
    });

    console.log("UserOp hash:", chalk.cyan(hash));
    spinner.start("Waiting for receipt...");

    const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash });
    spinner.succeed(chalk.greenBright.bold("No-op UserOperation confirmed"));
    console.log("Tx hash:", receipt.receipt.transactionHash);
    console.log("User AA deployed:", receipt.receipt.status === "success");
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
