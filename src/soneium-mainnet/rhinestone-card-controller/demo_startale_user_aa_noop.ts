import "dotenv/config";
import ora from "ora";
import { http, type Hex, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";
import { createSCSPaymasterClient, createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.MAINNET_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const paymasterId = process.env.PAYMASTER_ID;
const privateKey = process.env.OWNER_PRIVATE_KEY;

if (!bundlerUrl || !paymasterUrl || !privateKey) {
  throw new Error("MAINNET_BUNDLER_URL, PAYMASTER_SERVICE_URL, or OWNER_PRIVATE_KEY is not set");
}

const chain = soneium;
const publicClient = createPublicClient({ transport: http(), chain });
const signer = privateKeyToAccount(privateKey as Hex);

const scsPaymasterClient = createSCSPaymasterClient({ transport: http(paymasterUrl) });
const scsContext = { calculateGasLimits: true, paymasterId };

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Startale user AA account (Soneium Mainnet, SCS paymaster)...");

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer,
        chain,
        transport: http(),
        index: 100n,
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      paymaster: scsPaymasterClient,
      paymasterContext: scsContext,
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
