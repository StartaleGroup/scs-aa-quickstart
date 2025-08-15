import "dotenv/config";
import ora from "ora";
import axios from "axios";
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
import { optimism, base } from "viem/chains";
import { createPimlicoClient } from "permissionless/clients/pimlico";

import { CreateSessionDataParams, createSmartAccountClient, ParamCondition, SessionData, smartSessionCreateActions, smartSessionUseActions, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import { getSmartSessionsValidator, SmartSessionMode } from "@rhinestone/module-sdk";
import { isSessionEnabled } from "@rhinestone/module-sdk";
import { toSmartSessionsValidator } from "@startale-scs/aa-sdk";

import type Table from "cli-table3";
import CliTable from "cli-table3";
import chalk from "chalk";

// LiFi API Types
interface LiFiRoute {
  transactionRequest: {
    to: Address;
    data: Hex;
    value?: string;
    gasLimit?: string;
  };
  tool: string;
  fromChainId: number;
  toChainId: number;
}

interface LiFiQuoteRequest {
  fromChain: number;
  toChain: number;
  fromToken: Address;
  toToken: Address;
  fromAmount: string;
  fromAddress: Address;
  toAddress: Address;
  slippage?: number;
  allowBridges?: string[];
  allowSwappers?: string[];
}

// Environment variables
const bundlerUrl = process.env.PIMLICO_BUNDLER_URL; // Pimlico bundler URL for Optimism
const privateKey = process.env.OWNER_PRIVATE_KEY;

// Cross-chain configuration
const OPTIMISM_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address; // USDC on Optimism
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address; // USDC on Base
const LIFI_DIAMOND_OPTIMISM = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address; // LiFi Diamond on Optimism
const LIFI_DIAMOND_BASE = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address; // LiFi Diamond on Base

if (!bundlerUrl || !privateKey) {
  throw new Error("MINATO_BUNDLER_URL or OWNER_PRIVATE_KEY is not set");
}

const chain = optimism;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(bundlerUrl),
});

const pimlicoUrl = bundlerUrl;
const pimlicoClient = createPimlicoClient({
  transport: http(pimlicoUrl),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
});

const signer = privateKeyToAccount(privateKey as Hex);


// LiFi API functions
const getLiFiRoute = async (
  fromChain: number,
  toChain: number,
  fromToken: Address,
  toToken: Address,
  amount: string,
  userAddress: Address
): Promise<LiFiRoute> => {
  const params = {
    fromChain: fromChain.toString(),
    toChain: toChain.toString(),
    fromToken,
    toToken,
    fromAmount: amount,
    fromAddress: userAddress,
    slippage: '0.01', // 1% slippage
  };

  try {
    console.log('LiFi Quote Request Params:', JSON.stringify(params, null, 2));
    const response = await axios.get('https://li.quest/v1/quote', {
      params
    });
    // Uncomment to see the full response
    // console.log('LiFi Quote Response:', JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('Error getting LiFi route:');
    if (axios.isAxiosError(error)) {
      console.error('Status:', error.response?.status);
      console.error('Status Text:', error.response?.statusText);
      console.error('Response Data:', JSON.stringify(error.response?.data, null, 2));
      console.error('Request URL:', error.config?.url);
      console.error('Request Params:', error.config?.params);
    } else {
      console.error('Non-Axios Error:', error);
    }
    throw new Error(`Failed to get cross-chain route from LiFi: ${error}`);
  }
};

const checkBridgeStatus = async (
  bridge: string,
  fromChain: number,
  toChain: number,
  txHash: string
): Promise<any> => {
  try {
    const response = await axios.get(
      `https://li.quest/v1/status?bridge=${bridge}&fromChain=${fromChain}&toChain=${toChain}&txHash=${txHash}`
    );
    return response.data;
  } catch (error) {
    console.error('Error checking bridge status:', error);
    return null;
  }
};

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  const tableConfig = {
    colWidths: [30, 60],
    wordWrap: true,
    wrapOnWordBoundary: false,
  };

  try {
    const tableBefore = new CliTable(tableConfig);

    const eoaAddress = signer.address;
    console.log("EOA Address:", eoaAddress);

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer: signer as any,
        chain: chain as any,
        transport: http() as any,
        index: BigInt(21334)
      }),
      transport: http(bundlerUrl) as any,
      client: publicClient as any,
      // paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => {
          return (await pimlicoClient.getUserOperationGasPrice()).fast
        },
      },
    });

    const smartAccountAddress = await smartAccountClient.account.getAddress();
    console.log("Smart Account Address:", smartAccountAddress);

    // Generate session owner for cross-chain operations
    const sessionOwner = privateKeyToAccount(generatePrivateKey());
    console.log("Session Owner Address:", sessionOwner.address);

    // Create smart sessions module
    const sessionsModule = toSmartSessionsValidator({
      account: smartAccountClient.account,
      signer: sessionOwner as any,
    });
    // V1 address override for testing
    sessionsModule.address = "0x00000000008bDABA73cD9815d79069c247Eb4bDA";
    sessionsModule.module = "0x00000000008bDABA73cD9815d79069c247Eb4bDA";

    const smartSessionsToInstall = getSmartSessionsValidator({});
    // V1 address override for testing
    smartSessionsToInstall.address = "0x00000000008bDABA73cD9815d79069c247Eb4bDA";
    smartSessionsToInstall.module = "0x00000000008bDABA73cD9815d79069c247Eb4bDA";

    const isInstalledBefore = await smartAccountClient.isModuleInstalled({
      module: sessionsModule
    });
    console.log("Smart Sessions Module Installed:", isInstalledBefore);

    if (!isInstalledBefore) {
      spinner.start("Installing Smart Sessions Module...");
      const installModuleHash = await smartAccountClient.installModule({
        module: smartSessionsToInstall
      });
      console.log("Install Module Hash:", installModuleHash);

      const result = await bundlerClient.waitForUserOperationReceipt({
        hash: installModuleHash,
      });
      console.log("Install Operation Result:", result.receipt.transactionHash);
      spinner.succeed(chalk.greenBright.bold.underline("Smart Sessions Module installed successfully"));
    } else {
      spinner.succeed(chalk.greenBright.bold.underline("Smart Sessions Module already installed"));
    }

    const startaleAccountSessionClient = smartAccountClient.extend(
      smartSessionCreateActions(sessionsModule)
    );

    // Session permissions for cross-chain USDC transfers
    const sessionRequestedInfo: CreateSessionDataParams[] = [
      {
        sessionPublicKey: sessionOwner.address,
        // sessionValidUntil: 1753705571000, // Far future timestamp
        actionPoliciesInfo: [
          // Permission for LiFi Diamond contract interaction on Optimism
          {
            contractAddress: LIFI_DIAMOND_OPTIMISM,
            functionSelector: '0x30c48952' as Hex, // We'll use sudo mode for LiFi Diamond calls
            sudo: true // Allow any function call to LiFi Diamond
          },
          // // Permission for LiFi Diamond contract interaction on Base
          // {
          //   contractAddress: LIFI_DIAMOND_BASE,
          //   functionSelector: '0x' as Hex,
          //   sudo: true
          // },
          // // Permission for USDC approve calls (needed for cross-chain transfers)
          {
            contractAddress: OPTIMISM_USDC,
            functionSelector: '0x095ea7b3' as Hex, // approve function selector
            sudo: true,
            // rules: [
            //   {
            //     condition: ParamCondition.EQUAL,
            //     offsetIndex: 0, // spender parameter (LiFi Diamond)
            //     isLimited: false,
            //     ref: LIFI_DIAMOND_OPTIMISM,
            //     usage: {
            //       limit: 0n,
            //       used: 0n
            //     }
            //   },
            //   {
            //     condition: ParamCondition.LESS_THAN,
            //     offsetIndex: 1, // amount parameter
            //     isLimited: true,
            //     ref: parseUnits("1000", 6), // Max 1000 USDC per approval
            //     usage: {
            //       limit: parseUnits("10000", 6), // Total limit 10,000 USDC
            //       used: 0n
            //     }
            //   }
            // ]
          }
        ]
      }
    ];

    console.log("Creating session with cross-chain permissions...");

    spinner.start("Creating session permissions...");
    const createSessionsResponse = await startaleAccountSessionClient.grantPermission({
      sessionRequestedInfo
    });
    
    const sessionData: SessionData = {
      granter: smartAccountClient.account.address,
      description: `Cross-chain USDC transfer session via LiFi`,
      sessionPublicKey: sessionOwner.address,
      moduleData: {
        permissionIds: createSessionsResponse.permissionIds,
        action: createSessionsResponse.action,
        mode: SmartSessionMode.USE,
        sessions: createSessionsResponse.sessions
      }
    };

    const cachedSessionData = stringify(sessionData);
    console.log("Session Data Created");

    const result = await bundlerClient.waitForUserOperationReceipt({
      hash: createSessionsResponse.userOpHash,
    });
    console.log("Session Creation Result:", result.receipt.transactionHash);
    spinner.succeed(chalk.greenBright.bold.underline("Cross-chain session created successfully"));

    // Now demonstrate cross-chain USDC transfer using the session
    const parsedSessionData = JSON.parse(cachedSessionData) as SessionData;

    const isEnabled = await isSessionEnabled({
      client: smartAccountClient.account.client as any,
      account: {
        type: "erc7579-implementation",
        address: smartAccountClient.account.address,
        deployedOnChains: [chain.id]
      },
      permissionId: parsedSessionData.moduleData.permissionIds[0]
    });
    console.log("Session Enabled:", isEnabled);

    // Create session-enabled smart account client
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
      // paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => {
          return (await pimlicoClient.getUserOperationGasPrice()).fast
        },
      },
    });

    const usePermissionsModule = toSmartSessionsValidator({
      account: smartSessionAccountClient.account,
      signer: sessionOwner as any,
      moduleData: parsedSessionData.moduleData
    });
    // V1 address override for testing
    usePermissionsModule.address = "0x00000000008bDABA73cD9815d79069c247Eb4bDA";
    usePermissionsModule.module = "0x00000000008bDABA73cD9815d79069c247Eb4bDA";

    const useSmartSessionAccountClient = smartSessionAccountClient.extend(
      smartSessionUseActions(usePermissionsModule)
    );

    // Check USDC balance before transfer
    spinner.start("Checking USDC balance...");
    const usdcBalance = await publicClient.readContract({
      address: OPTIMISM_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [smartAccountAddress],
    }) as bigint;
    
    console.log("USDC Balance:", (Number(usdcBalance) / 1e6).toFixed(2), "USDC");
    spinner.succeed(`Current USDC balance: ${(Number(usdcBalance) / 1e6).toFixed(2)} USDC`);

    if (usdcBalance < parseUnits("1", 6)) {
      throw new Error("Insufficient USDC balance. Need at least 1 USDC for transfer.");
    }

    // Get cross-chain route from LiFi
    spinner.start("Getting cross-chain route from LiFi...");
    const transferAmount = parseUnits("1", 6); // 1 USDC
    
    const route = await getLiFiRoute(
      optimism.id, // From Optimism
      base.id, // To Base
      OPTIMISM_USDC,
      BASE_USDC,
      transferAmount.toString(),
      smartAccountAddress
    );

    console.log("LiFi Route:", {
      tool: route.tool,
      from: `Chain ${route.fromChainId}`,
      to: `Chain ${route.toChainId}`,
      contract: route.transactionRequest.to
    });
    spinner.succeed("Cross-chain route obtained from LiFi");

    // Check current USDC allowance
    const currentAllowance = await publicClient.readContract({
      address: OPTIMISM_USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [smartAccountAddress, route.transactionRequest.to],
    }) as bigint;
    
    console.log("Current USDC allowance for LiFi contract:", (Number(currentAllowance) / 1e6).toFixed(6), "USDC");
    console.log("Transfer amount needed:", (Number(transferAmount) / 1e6).toFixed(6), "USDC");
    console.log("LiFi contract address:", route.transactionRequest.to);

    // Prepare the calls for UserOp
    const calls = [];
    
    // Always approve with a generous amount (or reset and approve if needed)
    const approvalAmount = transferAmount * 2n; // Approve 2x the transfer amount to be safe
    
    // If there's existing allowance, we might need to reset it first (some tokens require this)
    if (currentAllowance > 0n && currentAllowance < approvalAmount) {
      console.log("Resetting existing allowance to 0...");
      const resetApproveCallData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [route.transactionRequest.to, 0n]
      });
      
      calls.push({
        to: OPTIMISM_USDC,
        data: resetApproveCallData
      });
    }
    
    // Now approve the required amount
    console.log("Approving", (Number(approvalAmount) / 1e6).toFixed(6), "USDC for LiFi contract");
    const approveCallData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [route.transactionRequest.to, approvalAmount]
    });
    
    calls.push({
      to: OPTIMISM_USDC,
      data: approveCallData
    });

    // Then execute the LiFi cross-chain transaction
    calls.push({
      to: route.transactionRequest.to,
      data: route.transactionRequest.data,
      value: route.transactionRequest.value ? BigInt(route.transactionRequest.value) : 0n
    });

    console.log("UserOp will execute", calls.length, "calls:");
    calls.forEach((call, i) => {
      let description = "Unknown call";
      
      // Identify the call type
      if (call.to === OPTIMISM_USDC) {
        if (call.data.startsWith("0x095ea7b3")) { // approve function selector
          description = `Approve USDC spending by ${route.transactionRequest.to}`;
        }
      } else if (call.to === route.transactionRequest.to) {
        description = `Execute LiFi bridge transaction (${route.tool})`;
      }
      
      console.log(`  ${i + 1}. TO: ${call.to}`);
      console.log(`     DATA: ${call.data.slice(0, 20)}...`);
      if (call.value === undefined) {
        console.log("     VALUE: 0 ETH");
      }
      console.log(`     VALUE: ${call.value} ETH`);
      console.log(`     DESCRIPTION: ${description}`);
      console.log("");
    });

    // Execute cross-chain transfer using session permissions
    spinner.start("Executing cross-chain USDC transfer...");

    const userOpHash = await useSmartSessionAccountClient.usePermission({
      calls
    });
    console.log("Cross-chain Transfer UserOp Hash:", userOpHash);

    const transferResult = await bundlerClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });

    console.log("Cross-chain Transfer Result:", transferResult.receipt.transactionHash);
    spinner.succeed(chalk.greenBright.bold.underline("Cross-chain USDC transfer initiated successfully"));

    // Monitor bridge status
    spinner.start("Monitoring bridge status...");
    let bridgeComplete = false;
    let attempts = 0;
    const maxAttempts = 10;

    // Store the chain IDs from our original request since route might not have them
    const sourceChainId = optimism.id;
    const targetChainId = base.id;

    while (!bridgeComplete && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
      
      const status = await checkBridgeStatus(
        route.tool,
        sourceChainId,
        targetChainId,
        transferResult.receipt.transactionHash
      );
      
      if (status && status.status === 'DONE') {
        bridgeComplete = true;
        spinner.succeed(chalk.greenBright.bold.underline("Cross-chain bridge completed successfully"));
        console.log("Destination Transaction:", status.receiving?.txHash);
      } else if (status && status.status === 'FAILED') {
        spinner.fail(chalk.red("Cross-chain bridge failed"));
        console.log("Bridge Status:", status);
        break;
      } else {
        console.log(`Bridge status: ${status?.status || 'PENDING'} (Attempt ${attempts + 1}/${maxAttempts})`);
      }
      
      attempts++;
    }

    if (!bridgeComplete && attempts >= maxAttempts) {
      spinner.warn(chalk.yellow("Bridge monitoring timeout - check manually"));
    }

  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
    console.error("Full error:", error);
  }
  process.exit(0);
};

main();