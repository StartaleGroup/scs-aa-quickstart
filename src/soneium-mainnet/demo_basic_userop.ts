import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient
} from "viem";
import {
  type EntryPointVersion,
  entryPoint07Address
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";

import { createSCSPaymasterClient, createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";

import cliTable = require("cli-table3");
import chalk from "chalk";

const bundlerUrl = process.env.MAINNET_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const paymasterId = process.env.PAYMASTER_ID;
// const counterContract = process.env.COUNTER_CONTRACT_ADDRESS as Address;

if (!bundlerUrl || !paymasterUrl || !privateKey) {
  throw new Error("BUNDLER_RPC or PAYMASTER_SERVICE_URL or PRIVATE_KEY is not set");
}

const chain = soneium;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const scsPaymasterClient = createSCSPaymasterClient({
  transport: http(paymasterUrl) 
});


const signer = privateKeyToAccount(privateKey as Hex);

const entryPoint = {
  address: entryPoint07Address as Address,
  version: "0.7" as EntryPointVersion,
};

// Note: It is advised to always use calculateGasLimits true.

// Grab the paymasterId from the paymaster dashboard.
const scsContext = { calculateGasLimits: true, paymasterId: paymasterId /*Your paymasterId goes here. Grab it from dashboard*/ }

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
               index: BigInt(2132)
          }),
          transport: http(bundlerUrl),
          client: publicClient,
          paymaster: scsPaymasterClient,
          paymasterContext: scsContext,
      })

      const address = smartAccountClient.account.address;
      console.log("address", address);

      // Todo: Deploy fresh counter address which is also available on Mainnet
      // const counterStateBefore = (await publicClient.readContract({
      //   address: counterContract,
      //   abi: CounterAbi,
      //   functionName: "counters",
      //   args: [smartAccountClient.account.address],
      // })) as bigint;

      // // Construct call data
      // const callData = encodeFunctionData({
      //   abi: CounterAbi,
      //   functionName: "count",
      // });

      const hash = await smartAccountClient.sendUserOperation({ 
        calls: [
          {
            to: "0x2cf491602ad22944D9047282aBC00D3e52F56B37",
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
