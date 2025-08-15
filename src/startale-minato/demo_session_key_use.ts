import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  stringify,
  PublicClient,
} from "viem";
import {
  type EntryPointVersion,
  createBundlerClient,
  entryPoint07Address
} from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { soneiumMinato } from "viem/chains";
import { Counter as CounterAbi } from "../abi/Counter";

import { createSCSPaymasterClient, CreateSessionDataParams, createSmartAccountClient, SessionData, smartSessionCreateActions, smartSessionUseActions, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import { getSmartSessionsValidator, SmartSessionMode } from "@rhinestone/module-sdk";
import { isSessionEnabled } from "@rhinestone/module-sdk";
import { toSmartSessionsValidator } from "@startale-scs/aa-sdk";

import type Table from "cli-table3";
import CliTable from "cli-table3";
import chalk from "chalk";


const bundlerUrl = process.env.MINATO_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const counterContract = process.env.COUNTER_CONTRACT_ADDRESS as Address;
const paymasterId = process.env.PAYMASTER_ID;

if (!bundlerUrl || !paymasterUrl || !privateKey) {
  throw new Error("BUNDLER_RPC or PAYMASTER_SERVICE_URL or PRIVATE_KEY is not set");
}

const chain = soneiumMinato;
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

const entryPoint = {
  address: entryPoint07Address as Address,
  version: "0.7" as EntryPointVersion,
};

// Review:
// Note: we MUST use calculateGasLimits true otherwise we get verificationGasLimit too low
const scsContext = { calculateGasLimits: true, paymasterId: paymasterId }

const main = async () => {
    const spinner = ora({ spinner: "bouncingBar" });
  
    const tableConfig = {
      colWidths: [30, 60], // Requires fixed column widths
      wordWrap: true,
      wrapOnWordBoundary: false,
    };
  
    try {
      // spinner.start("Initializing smart account...");
      const tableBefore = new CliTable(tableConfig);

      const eoaAddress = signer.address;
      console.log("eoaAddress", eoaAddress); 

      const smartAccountClient = createSmartAccountClient({
        account: await toStartaleSmartAccount({ 
             signer: signer, 
             chain,
             transport: http(),
             index: BigInt(8941976)
        }),
        transport: http(bundlerUrl),
        client: publicClient,
        paymaster: scsPaymasterClient,
        paymasterContext: scsContext,
      })

      const address = await smartAccountClient.account.getAddress();
      console.log("address", address);

      // Note: Can keep fixed session owner
      const sessionOwner = privateKeyToAccount(generatePrivateKey())
      console.log("session owner address ", sessionOwner.address);

      // Create a smart sessions module for the user's account
      const sessionsModule = toSmartSessionsValidator({
        account: smartAccountClient.account,
        signer: sessionOwner,
      })

      const smartSessionsToInstall = getSmartSessionsValidator({})

      const isInstalledBefore = await smartAccountClient.isModuleInstalled({
        module: sessionsModule
      })
      console.log("isInstalledBefore", isInstalledBefore);

      if(!isInstalledBefore) {
        const installModuleHash = await smartAccountClient.installModule({
          module: smartSessionsToInstall //sessionsModule.moduleInitData
        });
        console.log("installModuleHash", installModuleHash);

        const result = await bundlerClient.waitForUserOperationReceipt({
            hash: installModuleHash,
          })
        console.log("Operation result: ", result.receipt.transactionHash);
    
        spinner.succeed(chalk.greenBright.bold.underline("Smart Sessions Module installed successfully"));
      } else {
        spinner.succeed(chalk.greenBright.bold.underline("Smart Sessions Module already installed"));
      }

      const startaleAccountSessionClient = smartAccountClient.extend(
        smartSessionCreateActions(sessionsModule)
      )

      const sessionRequestedInfo: CreateSessionDataParams[] = [
        {
         sessionPublicKey: sessionOwner.address, // session key signer
         actionPoliciesInfo: [
           {
             contractAddress: counterContract, // counter address
             functionSelector: '0x06661abd' as Hex, // function selector for increment count
             // If rules are provided Universal Action policy is created and attached.
             // If rules are not provided then sudo policy only for this "action"(contract and selector) is created.
             // sudo: true
           }
          ]
        }
      ]

      const createSessionsResponse = await startaleAccountSessionClient.grantPermission({
        sessionRequestedInfo
      })
      console.log("createSessionsResponse", createSessionsResponse);

      const sessionData: SessionData = {
        granter: smartAccountClient.account.address,
        description: `Session to increment a counter for ${counterContract}`,
        sessionPublicKey: sessionOwner.address,
        moduleData: {
          permissionIds: createSessionsResponse.permissionIds,
          action: createSessionsResponse.action,
          mode: SmartSessionMode.USE,
          sessions: createSessionsResponse.sessions
        }
      }

      const cachedSessionData = stringify(sessionData);
      console.log("cachedSessionData", cachedSessionData);

      const result = await bundlerClient.waitForUserOperationReceipt({
        hash: createSessionsResponse.userOpHash,
      })
      console.log("Operation result: ", result.receipt.transactionHash);
      spinner.succeed(chalk.greenBright.bold.underline("Session created successfully with granted permissions"));

      const counterStateBefore = (await publicClient.readContract({
        address: counterContract,
        abi: CounterAbi,
        functionName: "counters",
        args: [smartAccountClient.account.address],
      })) as bigint;
      console.log("counterStateBefore", counterStateBefore);

    // Now we will make use of Granted permissions

    const parsedSessionData = JSON.parse(cachedSessionData) as SessionData;
    console.log("parsedSessionData", parsedSessionData);

    const isEnabled = await isSessionEnabled({
      client: smartAccountClient.account.client as any,
      account: {
        type: "erc7579-implementation",
        address: smartAccountClient.account.address,
        deployedOnChains: [chain.id]
      },
      permissionId: parsedSessionData.moduleData.permissionIds[0]
    })
    console.log("is session Enabled", isEnabled);


    const smartSessionAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({ 
           signer: sessionOwner, 
           accountAddress: sessionData.granter,
           chain: chain,
           transport: http()
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      mock: true,
      paymaster: scsPaymasterClient,
      paymasterContext: scsContext,
    })

    const usePermissionsModule = toSmartSessionsValidator({
      account: smartSessionAccountClient.account,
      signer: sessionOwner ,
      moduleData: parsedSessionData.moduleData
    })

    const useSmartSessionAccountClient = smartSessionAccountClient.extend(
      smartSessionUseActions(usePermissionsModule)
    )

    // Construct call data
    const callData = encodeFunctionData({
      abi: CounterAbi,
      functionName: "count",
    });

    const userOpHash = await useSmartSessionAccountClient.usePermission({
      calls: [
        {
          to: counterContract,
          data: callData
        }
      ]
    })
    console.log("userOpHash", userOpHash);

    const resultOfUsedSession = await bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });

    console.log("Operation result: ", resultOfUsedSession.receipt.transactionHash);
    spinner.succeed(chalk.greenBright.bold.underline("Session used successfully"));

    const counterStateAfter = (await publicClient.readContract({
      address: counterContract,
      abi: CounterAbi,
      functionName: "counters",
      args: [smartAccountClient.account.address],
    })) as bigint;
    console.log("counterStateAfter", counterStateAfter);

    } catch (error) {
      spinner.fail(chalk.red(`Error: ${(error as Error).message}`));  
    }
    process.exit(0);
}

main();