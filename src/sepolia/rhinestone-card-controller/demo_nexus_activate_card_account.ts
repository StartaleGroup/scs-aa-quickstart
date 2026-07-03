import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  keccak256,
  toHex,
  maxUint256,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const cardAccountFactoryAddress = process.env.CARD_ACCOUNT_FACTORY_ADDRESS as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;

if (!bundlerUrl || !privateKey || !cardAccountFactoryAddress) {
  throw new Error(
    "SEPOLIA_BUNDLER_URL, OWNER_PRIVATE_KEY, or CARD_ACCOUNT_FACTORY_ADDRESS is not set"
  );
}

const CARD_ACCOUNT_FACTORY_ABI = [
  {
    name: "makeNewCardAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "userAccount", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "clone", type: "address" }],
  },
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const chain = sepolia;
const publicClient = createPublicClient({ transport: http(), chain });
const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(bundlerUrl),
});
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing user smart account...");

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer,
        chain,
        transport: http(),
        index: BigInt(3),
      }),
      transport: http(bundlerUrl),
      client: publicClient,
    });

    const userAccount = smartAccountClient.account.address;
    spinner.succeed(`User account: ${chalk.cyan(userAccount)}`);
    console.log("EOA:", signer.address);
    console.log("CardAccountFactory:", cardAccountFactoryAddress);
    console.log("USDSC:", usdscAddress);

    const salt = keccak256(toHex(userAccount)) as Hex;

    spinner.start("Predicting card account address...");
    const { result: cardAccountAddress } = await publicClient.simulateContract({
      address: cardAccountFactoryAddress,
      abi: CARD_ACCOUNT_FACTORY_ABI,
      functionName: "makeNewCardAccount",
      args: [userAccount, salt as `0x${string}`],
      account: userAccount,
    });
    spinner.succeed(`Card account: ${chalk.cyan(cardAccountAddress)}`);

    // Check current activation state
    const [code, currentAllowance] = await Promise.all([
      publicClient.getCode({ address: cardAccountAddress }),
      publicClient.readContract({
        address: usdscAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [userAccount, cardAccountAddress],
      }),
    ]);

    const isDeployed = !!code && code !== "0x";
    const isApproved = currentAllowance === maxUint256;

    console.log("Card account deployed:", isDeployed);
    console.log("USDSC approved:", isApproved);

    if (isDeployed && isApproved) {
      spinner.succeed(chalk.greenBright.bold("Card account already activated — nothing to do"));
      console.log(`\nSet NEXUS_CARD_ACCOUNT_ADDRESS=${cardAccountAddress} in .env`);
      process.exit(0);
    }

    // Build batch calls
    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    if (!isDeployed) {
      calls.push({
        to: cardAccountFactoryAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: CARD_ACCOUNT_FACTORY_ABI,
          functionName: "makeNewCardAccount",
          args: [userAccount, salt as `0x${string}`],
        }),
      });
    }

    if (!isApproved) {
      calls.push({
        to: usdscAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [cardAccountAddress, maxUint256],
        }),
      });
    }

    const label =
      !isDeployed && !isApproved
        ? "makeNewCardAccount + USDSC.approve"
        : !isDeployed
        ? "makeNewCardAccount"
        : "USDSC.approve";

    spinner.start(`Sending activation UserOp [${label}]...`);

    const opHash = await smartAccountClient.sendUserOperation({ calls });
    console.log("\nUserOp hash:", opHash);

    spinner.start("Waiting for receipt...");
    const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    console.log("Tx hash:", result.receipt.transactionHash);

    spinner.succeed(
      chalk.greenBright.bold(`Card account activated: ${cardAccountAddress}`)
    );
    console.log(`\nSet NEXUS_CARD_ACCOUNT_ADDRESS=${cardAccountAddress} in .env`);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
