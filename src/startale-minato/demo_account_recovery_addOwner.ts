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
  encodePacked,
  toHex,
  hashMessage,
  verifyMessage,
  hexToBytes,
  keccak256,
  concat,
  toBytes,
  createWalletClient,
  recoverAddress,
} from "viem";
import {
  type EntryPointVersion,
  createBundlerClient,
  entryPoint07Address,
  getUserOperationHash
} from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { soneiumMinato } from "viem/chains";
import { Counter as CounterAbi } from "../abi/Counter";

import { createSCSPaymasterClient, CreateSessionDataParams, createSmartAccountClient, SessionData, smartSessionCreateActions, smartSessionUseActions, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import { getOwnableValidator, getOwnableValidatorOwners, getSmartSessionsValidator, getSocialRecoveryMockSignature, getSocialRecoveryValidator, GLOBAL_CONSTANTS, SmartSessionMode } from "@rhinestone/module-sdk";
import { isSessionEnabled } from "@rhinestone/module-sdk";
import { toSmartSessionsValidator } from "@startale-scs/aa-sdk";

import type Table from "cli-table3";
import CliTable from "cli-table3";
import chalk from "chalk";
import { OwnableValidatorAbi } from "../abi/OwnableValidator";


const bundlerUrl = process.env.MINATO_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const counterContract = process.env.COUNTER_CONTRACT_ADDRESS as Address;
const paymasterId = process.env.PAYMASTER_ID;

const guardian1Pk = process.env.SIGNER_1_PRIVATE_KEY;
const guardian2Pk = process.env.SIGNER_2_PRIVATE_KEY;

const ecdsaValidatorAddress = process.env.ECDSA_VALIDATOR_ADDRESS;
const ownableValidatorAddress = process.env.OWNABLE_VALIDATOR_ADDRESS;

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

// /**
//  * Mimics Solidity's ECDSA.toEthSignedMessageHash(bytes32)
//  */
// function toEthSignedMessageHash32(messageHash: `0x${string}`): `0x${string}` {
//   const prefix = toBytes('\x19Ethereum Signed Message:\n32'); // Uint8Array
//   const msgBytes = toBytes(messageHash); // Uint8Array of 32 bytes
//   return keccak256(concat([prefix, msgBytes]));
// }

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
          index: BigInt(19266819)
        }),
        transport: http(bundlerUrl),
        client: publicClient, // Must pass the client
        paymaster: scsPaymasterClient,
        paymasterContext: scsContext,
      })

      const address = smartAccountClient.account.address;
      console.log("address", address);

      // Todo: Deploy fresh counter address which is also available on Mainnet
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
      console.log("receipt tx hash", receipt.receipt.transactionHash);


      const guardian1 = privateKeyToAccount(
        guardian1Pk as Hex,
      ) // the key corresponding to the first guardian
       
      const guardian2 = privateKeyToAccount(
        guardian2Pk as Hex, 
      ) // the key corresponding to the second guardian

      console.log("guardian1", guardian1.address);
      console.log("guardian2", guardian2.address);
       
      // Both guardians can sign as the threshold is 1
      const socialRecovery = getSocialRecoveryValidator({
         threshold: 1,
         guardians: [guardian1.address, guardian2.address],
      })

      const ownableValidator = getOwnableValidator({
        threshold: 1,
        owners: [guardian1.address],
      })
      // from v0.3.0
      console.log("ownableValidator address", ownableValidator.address);

      // This needs to be used in case we're swapping owner on default validator module.
      // Note: Deployed without isModuleInstalled check. as Smart account implementation does not return true for default validator module.
      // socialRecovery.address = "0x09B28fA4C069de40225c08C4a80D362E172266b6";

      console.log("socialRecovery module address", socialRecovery.address);

      const isAccountRecoveryModuleInstalled = await smartAccountClient.isModuleInstalled({
        module: socialRecovery
      })
      console.log("isAccountRecoveryModuleInstalled", isAccountRecoveryModuleInstalled);

      if(!isAccountRecoveryModuleInstalled) {

        const opHash = await smartAccountClient.installModule({
            module: socialRecovery
          })
    
          console.log("Operation hash: ", opHash);
    
          const result = await bundlerClient.waitForUserOperationReceipt({
            hash: opHash,
          })
          console.log("Operation result: ", result.receipt.transactionHash);
    
        spinner.succeed(chalk.greenBright.bold.underline("Account Recovery Module installed successfully"));

      } else {
        spinner.succeed(chalk.greenBright.bold.underline("Account Recovery Module already installed"));
      } 

      const isOwnableValidatorInstalled = await smartAccountClient.isModuleInstalled({
        module: ownableValidator
      })
      console.log("isOwnableValidatorInstalled", isOwnableValidatorInstalled);

      if(!isOwnableValidatorInstalled) {
        const opHash = await smartAccountClient.installModule({
          module: ownableValidator
        })
        console.log("Operation hash: ", opHash);

        const result = await bundlerClient.waitForUserOperationReceipt({
          hash: opHash,
        })
        console.log("Operation result: ", result.receipt.transactionHash);

        spinner.succeed(chalk.greenBright.bold.underline("Ownable Validator installed successfully"));
      } else {
        spinner.succeed(chalk.greenBright.bold.underline("Ownable Validator already installed"));
      }
      
      // Let us write recovery flow now...
      // We need instance of the module from sdk similar to toSmartSessionsValidator.
      // We need to extend the client with account recovery specific actions and passing the module.


      // This only needs to be used in case we're swapping owner on default validator module.
      // socialRecovery.address = "0x09B28fA4C069de40225c08C4a80D362E172266b6";
      // socialRecovery.module = "0x09B28fA4C069de40225c08C4a80D362E172266b6";
      // Otherwise default address from Rhinestone works
      smartAccountClient.account.setModule(socialRecovery as any);

      // Now it uses internal helper
      const nonceNew = await smartAccountClient.account.getNonce({});

      console.log("Nonce for Recovery validator: (fixed)", nonceNew);

      const addOwnerData = encodeFunctionData({
        abi: OwnableValidatorAbi,
        functionName: "addOwner",
        args: [guardian2.address], // can be any other eoa
      });

      const calls = [
        {
          to: ownableValidatorAddress,
          target: ownableValidatorAddress,
          value: BigInt(0),
          data: addOwnerData,
          callData: addOwnerData,
        },
      ];
      console.log("Calls to add owner to the ownable validator: ", calls);

      const userOpParams = {
        account: smartAccountClient.account,
        calls,
        nonce: nonceNew,
        signature: getSocialRecoveryMockSignature({
          threshold: 1,
        }),
      };
      let userOperation = await smartAccountClient.prepareUserOperation(userOpParams);

      console.log("Prepared User operation: ", userOperation);

      const userOperationMain = {
        nonce: userOperation.nonce,
        sender: userOperation.sender,
        callData: userOperation.callData,
        callGasLimit: userOperation.callGasLimit,
        maxFeePerGas: userOperation.maxFeePerGas,
        maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas,
        paymasterData: userOperation.paymasterData,
        paymaster: userOperation.paymaster,
        signature: userOperation.signature,
        paymasterPostOpGasLimit: userOperation.paymasterPostOpGasLimit!,
        paymasterVerificationGasLimit: userOperation.paymasterVerificationGasLimit!,
        verificationGasLimit: userOperation.verificationGasLimit!,
        preVerificationGas: userOperation.preVerificationGas!,
        factory: userOperation.factory,
        factoryData: userOperation.factoryData
      }

      const userOpHashToSign = getUserOperationHash({
        chainId: chain.id,
        entryPointAddress: entryPoint07Address,
        entryPointVersion: "0.7",
        userOperation: userOperationMain,
      });

      console.log("User operation hash to sign: ", userOpHashToSign);

      // const expected = toEthSignedMessageHash32(userOpHashToSign);
      // console.log("expected", expected);
      // console.log("hashed message", hashMessage(userOpHashToSign));

      // Must sign raw here.
      const signature = await guardian2.signMessage({ message: { raw: userOpHashToSign } })


      // Alternative if on-chain contract can do plain ECDSA.recover()
      // const signature = await sign({
      //   hash: userOpHashToSign,
      //   privateKey: guardian1Pk as Hex,
      // });

      // Only used for debugging
      // const recovered = await recoverAddress({
      //   hash: userOpHashToSign,
      //   signature,
      // });

      // console.log("Recovered: ", recovered);

      const finalSig = encodePacked(
            Array(1).fill('bytes'),
            Array(1).fill(signature),
      )

      
      userOperationMain.signature = finalSig;
      // console.log("User operation: ", userOperation);

      console.log(" toHex(userOperation.nonce!)", toHex(userOperation.nonce!));

      const finalUserOpHex = {
        ...userOperationMain,
        paymasterPostOpGasLimit: toHex(userOperationMain.paymasterPostOpGasLimit!),
        paymasterVerificationGasLimit: toHex(userOperationMain.paymasterVerificationGasLimit!),
        nonce: toHex(userOperationMain.nonce!),
        signature: finalSig, 
      }

      console.log("Final user operation hex: ", finalUserOpHex);

      const ownersBefore = (await publicClient.readContract({
        address: ownableValidatorAddress as Address,
        abi: OwnableValidatorAbi,
        functionName: 'getOwners',
        args: [smartAccountClient.account.address],
      })) as Address[]

      console.log("Owners before: ", ownersBefore);
  
      const userOpHash = await fetch(bundlerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_sendUserOperation",
            params: [finalUserOpHex, entryPoint07Address],
        }),
    }).then(res => res.json());


    if (userOpHash.error) {
        console.error("❌ Error sending UserOperation:", userOpHash.error);
        return;
    }


    console.log("✅ UserOperation sent! Hash:", userOpHash);

    const receiptMined = await smartAccountClient.waitForUserOperationReceipt({ hash: userOpHash.result });
    

    await new Promise(resolve => setTimeout(resolve, 5000));

    const ownersAfter = (await publicClient.readContract({
      address: ownableValidatorAddress as Address,
      abi: OwnableValidatorAbi,
      functionName: 'getOwners',
      args: [smartAccountClient.account.address],
    })) as Address[]
    
    console.log("Owners after: ", ownersAfter);

    const isOwner = ownersAfter.includes(guardian2.address);
    console.log("Is guardian2 an owner? (has been added through recovery)", isOwner);

    const isGuardian1Owner = ownersAfter.includes(guardian1.address);
    console.log("Is guardian1 an owner? (was already an owner)", isGuardian1Owner);


    } catch (error) {
      spinner.fail(chalk.red(`Error: ${(error as Error).message}`));  
    }
    process.exit(0);
}

main();