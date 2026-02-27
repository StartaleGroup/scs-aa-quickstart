import "dotenv/config";
import ora from "ora";
import { http, createPublicClient } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";

import { createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import { createPimlicoClient } from "permissionless/clients/pimlico";

import cliTable = require("cli-table3");
import chalk from "chalk";

const pimlicoApiKey = process.env.PIMLICO_API_KEY;
const privateKey = process.env.OWNER_PRIVATE_KEY;

if (!pimlicoApiKey || !privateKey) {
  throw new Error("PIMLICO_API_KEY or OWNER_PRIVATE_KEY is not set");
}

const pimlicoUrl = `https://api.pimlico.io/v2/soneium/rpc?apikey=${pimlicoApiKey}`;

const chain = soneium;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const pimlicoClient = createPimlicoClient({
  transport: http(pimlicoUrl),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
});

const signer = privateKeyToAccount(privateKey as `0x${string}`);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing smart account...");

    const eoaAddress = signer.address;
    console.log("eoaAddress", eoaAddress);

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer: signer,
        chain: chain,
        transport: http(),
        index: BigInt(2132),
      }),
      transport: http(pimlicoUrl),
      client: publicClient,
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => {
          return (await pimlicoClient.getUserOperationGasPrice()).fast;
        },
      },
    });

    const address = smartAccountClient.account.address;
    console.log("address", address);

    spinner.succeed("Smart account initialized");

    const hash = await smartAccountClient.sendUserOperation({
      calls: [
        {
          to: "0x2cf491602ad22944D9047282aBC00D3e52F56B37",
          value: BigInt(0),
          data: "0x",
        },
      ],
    });

    console.log("User Operation Hash:", hash);

    const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash });
    console.log("receipt", receipt);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }

  process.exit(0);
};

main();
