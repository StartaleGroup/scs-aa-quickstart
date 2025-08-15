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
  parseUnits,
  erc20Abi,
} from "viem";
import {
  type EntryPointVersion,
  createBundlerClient,
  entryPoint07Address
} from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { soneiumMinato } from "viem/chains";


import { createSCSPaymasterClient, CreateSessionDataParams, createSmartAccountClient, ParamCondition, SessionData, smartSessionCreateActions, smartSessionUseActions, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import { getSmartSessionsValidator, SmartSessionMode } from "@rhinestone/module-sdk";
import { isSessionEnabled } from "@rhinestone/module-sdk";
import { toSmartSessionsValidator } from "@startale-scs/aa-sdk";

import CliTable from "cli-table3";
import chalk from "chalk";


const bundlerUrl = process.env.MINATO_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const erc20TokenContract = process.env.ASTR_MINATO_ADDRESS as Address;
const fixedReceiver = process.env.FIXED_RECEIVER_ADDRESS as Address;
const maliciousReceiver = process.env.MALICIOUS_RECEIVER_ADDRESS as Address;
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
  transport: http(paymasterUrl) as any,
});

const signer = privateKeyToAccount(privateKey as Hex);

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
             signer: signer as any, 
             chain: chain as any,
             transport: http() as any,
             index: BigInt(894117881)
        }),
        transport: http(bundlerUrl) as any,
        client: publicClient as any,
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
        signer: sessionOwner as any,
      })
      // V1 address override for testing
      sessionsModule.address = "0x00000000008bDABA73cD9815d79069c247Eb4bDA"
      sessionsModule.module = "0x00000000008bDABA73cD9815d79069c247Eb4bDA"

      // Imported from @rhinestone/module-sdk. If we were to update the address, we can export this from startale-scs/aa-sdk
      const smartSessionsToInstall = getSmartSessionsValidator({})
      // V1 address override for testing
      smartSessionsToInstall.address = "0x00000000008bDABA73cD9815d79069c247Eb4bDA"
      smartSessionsToInstall.module = "0x00000000008bDABA73cD9815d79069c247Eb4bDA"

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
         // sessionValidUntil: 1753705571,
         actionPoliciesInfo: [
           {
             contractAddress: erc20TokenContract, // ASTR minato address
             functionSelector: '0xa9059cbb' as Hex, // function selector for erc20 transfer
             rules: [
              {
                condition: ParamCondition.EQUAL,
                offsetIndex: 0,
                isLimited: false,
                ref: fixedReceiver,
                usage: {
                  limit: 0n,
                  used: 0n
                }
              },
              {
                condition: ParamCondition.LESS_THAN,
                offsetIndex: 1, // amount parameter
                isLimited: true,
                ref: parseUnits("8", 18), // 8 ASTR per tx
                usage: {
                  limit: parseUnits("80", 18), // 80 ASTR total
                  used: 0n
                }
              }
             ]
             // If rules are provided Universal Action policy is created and attached.
             // If rules are not provided then sudo policy only for this "action"(contract and selector) is created.
             // sudo: true
           }
          ]
        }
      ]

      console.log("sessionRequestedInfo", sessionRequestedInfo);

      const createSessionsResponse = await startaleAccountSessionClient.grantPermission({
        sessionRequestedInfo
      })
      console.log("createSessionsResponse", createSessionsResponse.sessions[0].actions[0].actionPolicies);

      const sessionData: SessionData = {
        granter: smartAccountClient.account.address,
        description: `Session to transfer ASTR for ${erc20TokenContract}`,
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

    console.log("parsedSessionData.moduleData", parsedSessionData.moduleData);
    console.log("parsedSessionData permissionId", parsedSessionData.moduleData.permissionIds[0]);


    const smartSessionAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({ 
           signer: sessionOwner as any, 
           accountAddress: sessionData.granter,
           chain: chain as any,
           transport: http() as any
      }),
      transport: http(bundlerUrl) as any,
      client: publicClient as any,
      mock: true,
      paymaster: scsPaymasterClient,
      paymasterContext: scsContext,
    })

    const usePermissionsModule = toSmartSessionsValidator({
      account: smartSessionAccountClient.account,
      signer: sessionOwner as any,
      moduleData: parsedSessionData.moduleData
    })
    // V1 address override for testing
    usePermissionsModule.address = "0x00000000008bDABA73cD9815d79069c247Eb4bDA"
    usePermissionsModule.module = "0x00000000008bDABA73cD9815d79069c247Eb4bDA"

    const useSmartSessionAccountClient = smartSessionAccountClient.extend(
      smartSessionUseActions(usePermissionsModule)
    )

    // Construct call data


    // If you try to send to any other receiver or the amount is greater than the limit, it would fail.
    const transferCallData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [fixedReceiver, parseUnits("2", 18)]
    });

    const userOpHash = await useSmartSessionAccountClient.usePermission({
      calls: [
        {
          to: erc20TokenContract,
          data: transferCallData
        }
      ]
    })
    console.log("userOpHash", userOpHash);

    const resultOfUsedSession = await bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });

    console.log("Operation result: ", resultOfUsedSession.receipt.transactionHash);
    spinner.succeed(chalk.greenBright.bold.underline("Session used successfully"));

    // We can also revoke the session now by using cached permissionId


    } catch (error) {
      spinner.fail(chalk.red(`Error: ${(error as Error).message}`));  
    }
    process.exit(0);
}

main();