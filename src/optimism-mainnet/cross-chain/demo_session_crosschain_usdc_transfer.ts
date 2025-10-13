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
  parseUnits,
  erc20Abi,
} from "viem";
import {
  createBundlerClient,
} from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { optimism, base } from "viem/chains";
import {
  CreateSessionDataParams,
  createSCSPaymasterClient,
  createSmartAccountClient,
  SessionData,
  smartSessionCreateActions,
  smartSessionUseActions,
  toStartaleSmartAccount
} from "@startale-scs/aa-sdk";
import { getSmartSessionsValidator, SmartSessionMode } from "@rhinestone/module-sdk";
import { isSessionEnabled } from "@rhinestone/module-sdk";
import { toSmartSessionsValidator } from "@startale-scs/aa-sdk";

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
const bundlerUrl = process.env.OPTIMISM_MAINNET_BUNDLER_URL; // Pimlico bundler URL for Optimism
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL; // Pimlico paymaster URL
const paymasterId = process.env.PAYMASTER_ID; // Paymaster ID from SCS dashboard
const privateKey = process.env.OWNER_PRIVATE_KEY;
const sessionPrivateKey = process.env.SESSION_SIGNER_PRIVATE_KEY; // Optional: specify session owner key

// Cross-chain configuration
const OPTIMISM_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address; // USDC on Optimism
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address; // USDC on Base
const LIFI_DIAMOND_OPTIMISM = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address; // LiFi Diamond on Optimism

if (!bundlerUrl || !paymasterUrl || !paymasterId || !privateKey) {
  throw new Error("OPTIMISM_MAINNET_BUNDLER_URL or PAYMASTER_SERVICE_URL or OWNER_PRIVATE_KEY is not set");
}

const chain = optimism;
const signer = privateKeyToAccount(privateKey as Hex);
const sessionSigner = privateKeyToAccount((sessionPrivateKey ?? generatePrivateKey()) as Hex);

const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(bundlerUrl),
});

const paymasterClient = createSCSPaymasterClient({
  transport: http(paymasterUrl) 
});

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

  const eoaAddress = signer.address;
  console.log("EOA Address:", eoaAddress);

  const sessionSignerAddress = sessionSigner.address;
  console.log("Session Signer Address:", sessionSignerAddress);

  try {
    const scsPaymasterContext = { calculateGasLimits: true, paymasterId: paymasterId };
    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer: signer,
        chain: chain,
        transport: http(),
        index: BigInt(21334)
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      paymaster: paymasterClient,
      paymasterContext: scsPaymasterContext,
    });

    const smartAccountAddress = await smartAccountClient.account.getAddress();
    console.log("Smart Account Address:", smartAccountAddress);

    // Create smart sessions module
    const sessionsModule = toSmartSessionsValidator({
      account: smartAccountClient.account,
      signer: sessionSigner,
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
        sessionPublicKey: sessionSigner.address,
        actionPoliciesInfo: [
          // Permission for LiFi Diamond contract interaction on Optimism
          {
            contractAddress: LIFI_DIAMOND_OPTIMISM,
            functionSelector: '0x30c48952' as Hex, // We'll use sudo mode for LiFi Diamond calls
            sudo: true // Allow any function call to LiFi Diamond
          },
          // // Permission for USDC approve calls (needed for cross-chain transfers)
          {
            contractAddress: OPTIMISM_USDC,
            functionSelector: '0x095ea7b3' as Hex, // approve function selector
            sudo: true,
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
      sessionPublicKey: sessionSigner.address,
      moduleData: {
        permissionIds: createSessionsResponse.permissionIds,
        action: createSessionsResponse.action,
        mode: SmartSessionMode.USE,
        sessions: createSessionsResponse.sessions
      }
    };

    const result = await bundlerClient.waitForUserOperationReceipt({
      hash: createSessionsResponse.userOpHash,
    });
    console.log("Session Creation Result:", result.receipt.transactionHash);
    spinner.succeed(chalk.greenBright.bold.underline("Cross-chain session created successfully"));

    const isEnabled = await isSessionEnabled({
      client: smartAccountClient.account.client as any,
      account: {
        type: "erc7579-implementation",
        address: smartAccountClient.account.address,
        deployedOnChains: [chain.id]
      },
      permissionId: sessionData.moduleData.permissionIds[0]
    });
    console.log("Session Enabled:", isEnabled);

    // Create session-enabled smart account client
    const smartSessionAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer: sessionSigner,
        accountAddress: sessionData.granter,
        chain: chain,
        transport: http()
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      paymaster: paymasterClient,
    });

    const usePermissionsModule = toSmartSessionsValidator({
      account: smartSessionAccountClient.account,
      signer: sessionSigner,
      moduleData: sessionData.moduleData
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
