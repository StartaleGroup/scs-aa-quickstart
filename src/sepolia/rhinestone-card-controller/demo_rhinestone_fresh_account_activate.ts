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
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";


const K1_DEFAULT_VALIDATOR = "0x00000072f286204bb934ed49d8969e86f7dec7b1" as `0x${string}`;

const privateKey = process.env.OWNER_PRIVATE_KEY;
const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const cardAccountFactoryAddress = process.env.CARD_ACCOUNT_FACTORY_ADDRESS as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!privateKey || !bundlerUrl || !cardAccountFactoryAddress || !rhinestoneApiKey) {
  throw new Error(
    "OWNER_PRIVATE_KEY, SEPOLIA_BUNDLER_URL, CARD_ACCOUNT_FACTORY_ADDRESS, or RHINESTONE_API_KEY is not set"
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
const publicClient = createPublicClient({ transport: http(bundlerUrl), chain });
const signer = privateKeyToAccount(privateKey as Hex);

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing Rhinestone Nexus account (type: startale, K1 validator)...");

    const account = await createRhinestoneAccount({
      account: { type: "startale" as const },
      owners: {
        type: "ecdsa",
        accounts: [signer],
        module: K1_DEFAULT_VALIDATOR,
      },
      apiKey: rhinestoneApiKey
    });

    const userAccount = account.getAddress() as Address;
    spinner.succeed(`Nexus account: ${chalk.cyan(userAccount)}`);
    console.log("EOA (signer):", signer.address);
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
    spinner.succeed(`Card account (counterfactual): ${chalk.cyan(cardAccountAddress)}`);

    // Idempotency — skip steps already done
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

    // Rhinestone's intent orchestrator simulates against on-chain state — the Nexus
    // account must be deployed before sendTransaction, otherwise simulation reverts.
    const nexusDeployed = await account.isDeployed(chain);
    if (!nexusDeployed) {
      spinner.start("Deploying Nexus account (sponsored)...");
      await account.deploy(chain, { sponsored: true });
      spinner.succeed(`Nexus account deployed: ${chalk.cyan(userAccount)}`);
    }

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

    spinner.start(`Sending sponsored transaction [${label}]...`);

    const result = await account.sendTransaction({
      chain,
      calls,
      sponsored: true,
    });

    console.log("\nIntent result:", result);
    spinner.start("Waiting for execution...");

    const status = await account.waitForExecution(result);
    spinner.succeed(chalk.greenBright.bold(`Card account activated: ${cardAccountAddress}`));
    console.log("Status:", status);
    console.log(`\nSet NEXUS_CARD_ACCOUNT_ADDRESS=${cardAccountAddress} in .env`);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
