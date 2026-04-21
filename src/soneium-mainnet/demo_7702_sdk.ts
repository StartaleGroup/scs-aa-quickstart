import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  createWalletClient,
  SignedAuthorizationList,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneium, soneiumMinato } from "viem/chains";
import { Counter as CounterAbi } from "../abi/Counter";
import { createSCSPaymasterClient, createSmartAccountClient, getEip7702Authorization, toStartaleSmartAccount } from "@startale-scs/aa-sdk";

import cliTable = require("cli-table3");
import chalk from "chalk";
import { verifyAuthorization } from "viem/utils";

const bundlerUrl = process.env.MAINNET_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const implementationAddress = process.env.STARTALE_ACCOUNT_IMPLEMENTATION_ADDRESS as Address;
const paymasterId = process.env.PAYMASTER_ID;

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

// Note: It is advised to always use calculateGasLimits true.
// Grab the paymasterId from the paymaster dashboard.
const scsContext = { calculateGasLimits: true, paymasterId: paymasterId }


export const getAuthorizationListFromDirectAuths = (
  authorizations: any[]
): SignedAuthorizationList | undefined => {
  const authList = authorizations
    .map((auth) => {
      if (!auth) return null

      const address =
        "address" in auth && auth.address
          ? auth.address
          : auth.contractAddress

      if (!address) return null

      return {
        address,
        chainId: auth.chainId,
        nonce: auth.nonce,
        r: auth.r,
        s: auth.s,
        v: auth.v,
        yParity: auth.yParity
      }
    })
    .filter(Boolean) as SignedAuthorizationList

  return authList.length ? authList : undefined
}

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

      const walletClient = createWalletClient({
        account: signer,
        chain,
        transport: http()
      })

      const authUsingSdk = await getEip7702Authorization(walletClient);
      console.log("authUsingSdk", authUsingSdk)

      const authorization = await walletClient.signAuthorization({
        // account: signer,
        /**
        * Whether the EIP-7702 Transaction will be executed by the EOA (signing this Authorization) or another Account.
        *
        * By default, it will be assumed that the EIP-7702 Transaction will
        * be executed by another Account.
        */
        // chainId is optional. can set to specific network or 0
        // chainId: 0, // If single authorization signature needs to be valid across all supported-7702 chains
        // Review: /** Nonce of the EOA to delegate to. */
        // sending authorization (type4 tx) will also increase the nonce by 1 if execute = self. so it must be current nonce + 1. luckily we have helper arg above.
        // nonce: await publicClient.getTransactionCount({
        //   address: eoaAddress,
        // }),
        // address: implementationAddress,
        contractAddress: implementationAddress,
      })

      console.log("authorization ", authorization)

      const verified = await verifyAuthorization({
        authorization: authorization,
        address: eoaAddress 
      })
      console.log("verified ", verified)

      const multipleAuths = []
      multipleAuths.push(authorization)

      // const authList = getAuthorizationListFromDirectAuths(multipleAuths)
      // console.log(authList)

      // 3 ways
      // a. either give pre-auth (send separate type4 tx yourself... maybe sdk method delegateTo?) and just send accountAddress overridden with eoa who is already SA now
      // b. take auth from user (signature..whole authorization object) and pass it as eip7702Auth when creating account  along with overriden SA address = eoa address
      // Above is only once.. if you still give it doesn't matter once eoa is already SA
      // c. pass eip7702Account so that we explicitly know we have to take authorization internally and then use that authorization to send type4 tx.  
 
      const smartAccountClient = createSmartAccountClient({
          account: await toStartaleSmartAccount({ 
               signer: signer, 
               chain: chain,
               transport: http(),
               accountAddress: eoaAddress, // smart acocunt address = eoa address
               // first way
               eip7702Auth: authorization, // You can use authorization and authUsingSdk interchangeably.
               // eip7702Account: signer,
          }),
          transport: http(bundlerUrl),
          client: publicClient,
          paymaster: scsPaymasterClient ,
          paymasterContext: scsContext ,
      })

      const isDelegatedBefore = await smartAccountClient.account.isDelegated();
      console.log("isDelegatedBefore", isDelegatedBefore);

      // 1. If I provide authorization here it should check if the account has already been delegated.
      // 2. If account is inited with eip7702Auth or eip7702Signer(eip7702Account) and if account is not already delegated then I should not have to pass authorization in sendUserOperation


        const hash = await smartAccountClient.sendUserOperation({ 
          calls: [
            {
                to: "0x2cf491602ad22944D9047282aBC00D3e52F56B37",
                value: BigInt(0),
                data: "0x",
              },
          ],
          // No need to pass anything else separately
        }); 
        const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash }); 
        console.log("receipt", receipt);

        const isDelegated = await smartAccountClient.account.isDelegated();
        console.log("isDelegated", isDelegated);

        // Optional undelegate to make sure we are undelegated if we want to keep running same path with same EOA without replacing private key.
        // const tx = await smartAccountClient.account.unDelegate();
        // console.log("tx", tx);
        // const unDelegateReceipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        // console.log("unDelegateReceipt", unDelegateReceipt);

        // const isDelegatedAfter = await smartAccountClient.account.isDelegated();
        // console.log("isDelegatedAfter", isDelegatedAfter);
    } catch (error) {
      spinner.fail(chalk.red(`Error: ${(error as Error).message}`));  
    }
    process.exit(0);
}

main();