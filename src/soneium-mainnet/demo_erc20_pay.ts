import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  toHex,
  erc20Abi,
  maxUint256,
} from "viem";
import {
  type EntryPointVersion,
  createBundlerClient,
  entryPoint07Address,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";
// import { Counter as CounterAbi } from "../abi/Counter";

import { createSCSPaymasterClient, createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";

import cliTable = require("cli-table3");
import chalk from "chalk";


const bundlerUrl = process.env.MAINNET_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
// const counterContract = process.env.COUNTER_CONTRACT_ADDRESS as Address;
const tokenAddress = process.env.ASTR_MAINNET_ADDRESS;
const paymasterAddress = process.env.TOKEN_PAYMASTER_PROD_ADDRESS as Address;

if (!bundlerUrl || !paymasterUrl || !privateKey) {
  throw new Error("BUNDLER_RPC or PAYMASTER_SERVICE_URL or PRIVATE_KEY is not set");
}

const chain = soneium;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const scsPaymasterClient = createSCSPaymasterClient({
  transport: http(paymasterUrl),
});

const signer = privateKeyToAccount(privateKey as Hex);

// Note: It is advised to always use calculateGasLimits true.

// Grab the paymasterId from the paymaster dashboard.
const scsContext = { calculateGasLimits: true, token: tokenAddress }

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
          chain,
          transport: http(),
          index: BigInt(10983)
        }),
        transport: http(bundlerUrl),
        client: publicClient,
        paymaster: scsPaymasterClient,
        paymasterContext: scsContext,
      })

      const address = smartAccountClient.account.address;
      console.log("address", address);

      /// Steps to Use Token Paymaster
      /// 1. Prepare User Operation
      /// 2. Get Quote [ getTokenPaymasterQuotes ]
      /// 3. Send User Operation with chosen quote and required approval amount as custom approval amount [ sendTokenPaymasterUserOp]
      /// Note: When we use sendTokenPaymasterUserOp it appends the approval internally
      /// We can also do this manually by providing max approval and batching from client side (as it is done in the commented code)

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

      const preparedUserOp = await smartAccountClient.prepareUserOperation({
        calls: [
          {
            to: "0x2cf491602ad22944D9047282aBC00D3e52F56B37",
            value: BigInt(0),
            data: "0x",
          }
        ]
      })

      const quotes = await scsPaymasterClient.getTokenPaymasterQuotes({ userOp: preparedUserOp, chainId: toHex(chain.id) })
      console.log("quotes", quotes);

      // Manually appending max approval and using paymaster client, without using calls to get fee quotes and the decorator sendTokenPaymasterUserOp 

      // const hash = await smartAccountClient.sendUserOperation({ 
      //   calls: [
      //     {
      //       to: "0x2cf491602ad22944D9047282aBC00D3e52F56B37",
      //       value: BigInt(0),
      //       data: "0x",
      //     },
      //     {
      //       to: tokenAddress as Address,
      //       value: BigInt(0),
      //       data: encodeFunctionData({
      //           abi: erc20Abi,
      //           functionName: "approve",
      //           args: [paymasterAddress, maxUint256]
      //       })
      //     }
      //   ],
      // }); 
      // const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash }); 
      // console.log("receipt", receipt);

      // Notice: Before this please make sure to send sfee tokens to counterfactual smart account address.
      // Note: This will only work for prod paymaster url as in the sdk only prod paymaster address is supported.

      const hash = await smartAccountClient.sendTokenPaymasterUserOp({
        calls: [
          {
            to: "0x2cf491602ad22944D9047282aBC00D3e52F56B37",
            value: BigInt(0),
            data: "0x",
          }
        ],
        feeTokenAddress: tokenAddress as Address,
        // You can either match by ASTR token address or use the one you know from response. 2nd element in array in this case (Mainnet current supported tokens)
        customApprovalAmount: BigInt(quotes.feeQuotes[1].requiredAmount)
      })
      console.log("hash", hash);

      const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash }); 
      console.log("receipt", receipt);
    } catch (error) {
      spinner.fail(chalk.red(`Error: ${(error as Error).message}`));  
    }
    process.exit(0);
}

main();
