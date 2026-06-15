import "dotenv/config";
import ora from "ora";
import {
  http,
  type Hex,
  createPublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";

import cliTable = require("cli-table3");
import chalk from "chalk";

const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;

if (!bundlerUrl || !privateKey) {
  throw new Error("SEPOLIA_BUNDLER_URL or OWNER_PRIVATE_KEY is not set");
}

const chain = sepolia;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
    const spinner = ora({ spinner: "bouncingBar" });

    const tableConfig = {
      colWidths: [30, 60], // Requires fixed column widths
      wordWrap: true,
      wrapOnWordBoundary: false,
    };

    try {
      spinner.start("Initializing smart account...");
      const tableBefore = new cliTable(tableConfig);

      const eoaAddress = signer.address;
      console.log("eoaAddress", eoaAddress);

      const smartAccountClient = createSmartAccountClient({
          account: await toStartaleSmartAccount({
               signer: signer,
               chain: chain,
               transport: http(),
               index: BigInt(0)
          }),
          transport: http(bundlerUrl),
          client: publicClient,
      })

      // This is how you can get counterfactual address of the smart account even before it is deployed.
      // It is useful to pre-send some eth or erc20 tokens so that deployment txn could use those funds (depending on the paymaster)
      const address = smartAccountClient.account.address;
      console.log("address", address);

      const hash = await smartAccountClient.sendUserOperation({
        calls: [
          {
            to: address,
            value: BigInt(0),
            data: "0x",
          },
        ],
      });
      const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash });
      console.log("receipt", receipt);
    } catch (error) {
      spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
    }
    process.exit(0);
}

main();
