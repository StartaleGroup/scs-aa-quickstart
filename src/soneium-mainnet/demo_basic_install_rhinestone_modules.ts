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
  createBundlerClient,
  entryPoint07Address
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";

import { createSCSPaymasterClient, createSmartAccountClient, toOwnableModule, toStartaleSmartAccount, RHINESTONE_INTENT_EXECUTOR_ADDRESS, RHINESTONE_SMART_SESSION_EMISSARY_ADDRESS, getOwnableValidator } from "@startale-scs/aa-sdk";
import { RhinestoneSDK } from "@rhinestone/sdk";

import cliTable = require("cli-table3");
import chalk from "chalk";

const bundlerUrl = process.env.MAINNET_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
const paymasterId = process.env.PAYMASTER_ID;
// const counterContract = process.env.COUNTER_CONTRACT_ADDRESS as Address;

if (!bundlerUrl || !paymasterUrl || !privateKey) {
  throw new Error("BUNDLER_RPC or PAYMASTER_SERVICE_URL or PRIVATE_KEY is not set");
}
if (!rhinestoneApiKey) {
  throw new Error("RHINESTONE_API_KEY is not set");
}

const chain = soneium;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const scsPaymasterClient = createSCSPaymasterClient({
  transport: http(paymasterUrl) as any
});

const bundlerClient = createBundlerClient({
  client: publicClient as any,
  transport: http(bundlerUrl) as any,
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

      // ── Rhinestone address-parity check ──────────────────────────────────────
      // Both SDKs must derive the same counterfactual address for the same signer.
      const startaleAccount = await toStartaleSmartAccount({
        chain: chain as any,
        transport: http() as any,
        signer: signer as any,
        index: 0n,
        // rhinestoneCompatible: {sessionsEnabled: true},
      });
      const startaleAddress = await startaleAccount.getAddress();

      const rhinestone = new RhinestoneSDK({ apiKey: rhinestoneApiKey as string });
      const rhinestoneAccount = await rhinestone.createAccount({
        account: { type: "startale" },
        owners: { type: "ecdsa", accounts: [signer] },
        experimental_sessions: { enabled: true },
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
      // if (!addressesMatch) throw new Error("Address parity check failed");
      // ─────────────────────────────────────────────────────────────────────────

      const smartAccountClient = createSmartAccountClient({
          account: await toStartaleSmartAccount({ 
               signer: signer as any, 
               chain: chain as any,
               transport: http() as any,
               index: BigInt(0),
               // rhinestoneCompatible: {sessionsEnabled: true},
          }),
          transport: http(bundlerUrl) as any,
          client: publicClient as any,
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

      // const hash = await smartAccountClient.sendUserOperation({ 
      //   calls: [
      //     {
      //       to: "0x2cf491602ad22944D9047282aBC00D3e52F56B37",
      //       value: BigInt(0),
      //       data: "0x",
      //     },
      //   ],
      // }); 
      // const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash }); 
      // console.log("receipt", receipt);


      // ── Module installation ───────────────────────────────────────────────
      // 1. Ownable Validator
      const ownableValidator = getOwnableValidator({
        threshold: 1,
        owners: [signer.address],
      });
      const isOwnableValidatorInstalled = await smartAccountClient.isModuleInstalled({
        module: ownableValidator as any,
      });
      console.log("isOwnableValidatorInstalled", isOwnableValidatorInstalled);
      if (!isOwnableValidatorInstalled) {
        const opHash = await smartAccountClient.installModule({ module: ownableValidator as any });
        console.log("installOwnableValidator opHash:", opHash);
        const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
        console.log("installOwnableValidator tx:", result.receipt.transactionHash);
        spinner.succeed(chalk.greenBright.bold("Ownable Validator installed"));
      } else {
        spinner.succeed(chalk.greenBright.bold("Ownable Validator already installed"));
      }

      // 2. Smart Session Emissary (validator)
      const smartSessionEmissary = {
        address: RHINESTONE_SMART_SESSION_EMISSARY_ADDRESS,
        initData: "0x" as Hex,
        deInitData: "0x" as Hex,
        additionalContext: "0x" as Hex,
        type: "validator" as const,
      };
      const isEmissaryInstalled = await smartAccountClient.isModuleInstalled({
        module: smartSessionEmissary as any,
      });
      console.log("isSmartSessionEmissaryInstalled", isEmissaryInstalled);
      if (!isEmissaryInstalled) {
        const opHash = await smartAccountClient.installModule({ module: smartSessionEmissary as any });
        console.log("installSmartSessionEmissary opHash:", opHash);
        const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
        console.log("installSmartSessionEmissary tx:", result.receipt.transactionHash);
        spinner.succeed(chalk.greenBright.bold("Smart Session Emissary installed"));
      } else {
        spinner.succeed(chalk.greenBright.bold("Smart Session Emissary already installed"));
      }

      // 3. Intent Executor (executor)
      const intentExecutor = {
        address: RHINESTONE_INTENT_EXECUTOR_ADDRESS,
        initData: "0x" as Hex,
        deInitData: "0x" as Hex,
        additionalContext: "0x" as Hex,
        type: "executor" as const,
      };
      const isIntentExecutorInstalled = await smartAccountClient.isModuleInstalled({
        module: intentExecutor as any,
      });
      console.log("isIntentExecutorInstalled", isIntentExecutorInstalled);
      if (!isIntentExecutorInstalled) {
        const opHash = await smartAccountClient.installModule({ module: intentExecutor as any });
        console.log("installIntentExecutor opHash:", opHash);
        const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
        console.log("installIntentExecutor tx:", result.receipt.transactionHash);
        spinner.succeed(chalk.greenBright.bold("Intent Executor installed"));
      } else {
        spinner.succeed(chalk.greenBright.bold("Intent Executor already installed"));
      }
      // ─────────────────────────────────────────────────────────────────────

    } catch (error) {
      spinner.fail(chalk.red(`Error: ${(error as Error).message}`));  
    }
    process.exit(0);
}

main();
