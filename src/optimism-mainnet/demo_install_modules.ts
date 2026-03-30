import "dotenv/config";
import ora from "ora";
import {
  http,
  type Hex,
  createPublicClient
} from "viem";
import {
  createBundlerClient,
  entryPoint07Address
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { optimism } from "viem/chains";

import { createSmartAccountClient, toStartaleSmartAccount, RHINESTONE_INTENT_EXECUTOR_ADDRESS, RHINESTONE_SMART_SESSION_EMISSARY_ADDRESS, getOwnableValidator } from "@startale-scs/aa-sdk";
import { RhinestoneSDK } from "@rhinestone/sdk";
import { createPimlicoClient } from "permissionless/clients/pimlico";

import cliTable = require("cli-table3");
import chalk from "chalk";

const pimlicoApiKey = process.env.PIMLICO_API_KEY;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!pimlicoApiKey || !privateKey) {
  throw new Error("PIMLICO_API_KEY or OWNER_PRIVATE_KEY is not set");
}
if (!rhinestoneApiKey) {
  throw new Error("RHINESTONE_API_KEY is not set");
}

const pimlicoUrl = `https://api.pimlico.io/v2/optimism/rpc?apikey=${pimlicoApiKey}`;

const chain = optimism;
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

const bundlerClient = createBundlerClient({
  client: publicClient as any,
  transport: http(pimlicoUrl),
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

      // ── Rhinestone address-parity check ──────────────────────────────────────
      // Both SDKs must derive the same counterfactual address for the same signer.
      const startaleAccount = await toStartaleSmartAccount({
        chain: chain as any,
        transport: http() as any,
        signer: signer as any,
        index: 0n,
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
      // ─────────────────────────────────────────────────────────────────────────

      const smartAccountClient = createSmartAccountClient({
          account: await toStartaleSmartAccount({
               signer: signer as any,
               chain: chain as any,
               transport: http() as any,
               index: BigInt(0),
          }),
          transport: http(pimlicoUrl) as any,
          client: publicClient as any,
          paymaster: pimlicoClient,
          userOperation: {
            estimateFeesPerGas: async () => {
              return (await pimlicoClient.getUserOperationGasPrice()).fast;
            },
          }
      })

      const address = smartAccountClient.account.address;
      console.log("address", address);

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
