import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneiumMinato } from "viem/chains";
import { Counter as CounterAbi } from "../abi/Counter";
import { createSCSPaymasterClient, createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import { RhinestoneSDK } from "@rhinestone/sdk";

import cliTable = require("cli-table3");
import chalk from "chalk";

const bundlerUrl = process.env.MINATO_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const counterContract = process.env.COUNTER_CONTRACT_ADDRESS as Address;
const paymasterId = process.env.PAYMASTER_ID;

if (!bundlerUrl || !paymasterUrl || !privateKey) {
  throw new Error("BUNDLER_RPC or PAYMASTER_SERVICE_URL or PRIVATE_KEY is not set");
}
if (!rhinestoneApiKey) {
  throw new Error("RHINESTONE_API_KEY is not set");
}

const chain = soneiumMinato;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const scsPaymasterClient = createSCSPaymasterClient({
  transport: http(paymasterUrl) as any 
});

const signer = privateKeyToAccount(privateKey as Hex);

// Note: It is advised to always use calculateGasLimits true.
// Grab the paymasterId from the paymaster dashboard.
const scsContext = { calculateGasLimits: true, paymasterId: paymasterId }

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

      // ── Rhinestone address-parity check ──────────────────────────────────────
      // Both SDKs must derive the same counterfactual address for the same signer.
      const startaleAccount = await toStartaleSmartAccount({
        chain: chain as any,
        transport: http() as any,
        signer: signer as any,
        index: 0n,
        rhinestoneCompatible: true, // aligns init-data with Rhinestone SDK
      });
      const startaleAddress = await startaleAccount.getAddress();

      const rhinestone = new RhinestoneSDK({ apiKey: rhinestoneApiKey as string });
      const rhinestoneAccount = await rhinestone.createAccount({
        account: { type: "startale" },
        owners: { type: "ecdsa", accounts: [signer] },
        experimental_sessions: { enabled: false },
      });
      const rhinestoneAddress = rhinestoneAccount.getAddress();

      const addressesMatch = startaleAddress.toLowerCase() === rhinestoneAddress.toLowerCase();
      console.log(chalk.cyan("\n── Rhinestone ↔ Startale address parity ──"));
      console.log("  Startale  :", startaleAddress);
      console.log("  Rhinestone:", rhinestoneAddress);
      console.log(
        addressesMatch
          ? chalk.green("  ✔ MATCH\n")
          : chalk.red(`  ✘ MISMATCH\n`)
      );
      if (!addressesMatch) throw new Error("Address parity check failed");
      // ─────────────────────────────────────────────────────────────────────────

      const smartAccountClient = createSmartAccountClient({
          account: await toStartaleSmartAccount({ 
               signer: signer as any, 
               chain: chain as any,
               transport: http() as any,
               index: BigInt(0),
               rhinestoneCompatible: true,
          }),
          transport: http(bundlerUrl) as any,
          client: publicClient as any,
          paymaster: scsPaymasterClient,
          paymasterContext: scsContext,
      })

      // This is how you can get counterfactual address of the smart account even before it is deployed.
      // It is useful to pre-send some eth or erc20 tokens so that deployment txn could use those funds (depending on the paymaster)
      const address = smartAccountClient.account.address;
      console.log("address", address);

      // Todo: Deploy fresh counter address which is also available on Mainnet
      const counterStateBefore = (await publicClient.readContract({
        address: counterContract,
        abi: CounterAbi,
        functionName: "counters",
        args: [smartAccountClient.account.address],
      })) as bigint;

      // Construct call data
      const callData = encodeFunctionData({
        abi: CounterAbi,
        functionName: "count",
      });

      const hash = await smartAccountClient.sendUserOperation({ 
        calls: [
          {
            to: counterContract as Address,
            value: BigInt(0),
            data: callData,
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