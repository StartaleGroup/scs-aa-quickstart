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
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";
import { createSCSPaymasterClient, createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.MAINNET_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const paymasterId = process.env.PAYMASTER_ID;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const cardAccountFactoryAddress = process.env.MAINNET_CARD_ACCOUNT_FACTORY_ADDRESS as Address;
const usdscAddress = process.env.MAINNET_USDSC_ADDRESS as Address;

if (!bundlerUrl || !paymasterUrl || !privateKey || !cardAccountFactoryAddress || !usdscAddress) {
  throw new Error(
    "MAINNET_BUNDLER_URL, PAYMASTER_SERVICE_URL, OWNER_PRIVATE_KEY, MAINNET_CARD_ACCOUNT_FACTORY_ADDRESS, or MAINNET_USDSC_ADDRESS is not set"
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

const chain = soneium;
const publicClient = createPublicClient({ transport: http(), chain });
const signer = privateKeyToAccount(privateKey as Hex);

const scsPaymasterClient = createSCSPaymasterClient({ transport: http(paymasterUrl) });
const scsContext = { calculateGasLimits: true, paymasterId };

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Startale user AA account...");

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer,
        chain,
        transport: http(),
        index: 100n,
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      paymaster: scsPaymasterClient,
      paymasterContext: scsContext,
    });

    const userAccount = smartAccountClient.account.address as Address;
    spinner.succeed(`User AA: ${chalk.cyan(userAccount)}`);
    console.log("EOA (signer):", signer.address);
    console.log("CardAccountFactory:", cardAccountFactoryAddress);
    console.log("USDSC:", usdscAddress);

    const salt = keccak256(toHex(userAccount + usdscAddress + usdscAddress)) as Hex;

    spinner.start("Predicting card account address...");
    const { result: cardAccountAddress } = await publicClient.simulateContract({
      address: cardAccountFactoryAddress,
      abi: CARD_ACCOUNT_FACTORY_ABI,
      functionName: "makeNewCardAccount",
      args: [userAccount, salt],
      account: userAccount,
    });
    spinner.succeed(`Card account (counterfactual): ${chalk.cyan(cardAccountAddress)}`);

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
      console.log(`\nSet MAINNET_CARD_ACCOUNT_ADDRESS=${cardAccountAddress} in .env`);
      process.exit(0);
    }

    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    if (!isDeployed) {
      calls.push({
        to: cardAccountFactoryAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: CARD_ACCOUNT_FACTORY_ABI,
          functionName: "makeNewCardAccount",
          args: [userAccount, salt],
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

    spinner.start(`Sending UserOperation [${label}]...`);

    const hash = await smartAccountClient.sendUserOperation({ calls });

    console.log("UserOp hash:", chalk.cyan(hash));
    spinner.start("Waiting for receipt...");

    const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash });
    spinner.succeed(chalk.greenBright.bold(`Card account activated: ${chalk.cyan(cardAccountAddress)}`));
    console.log("Tx hash:", receipt.receipt.transactionHash);
    console.log(`\nSet MAINNET_CARD_ACCOUNT_ADDRESS=${cardAccountAddress} in .env`);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
