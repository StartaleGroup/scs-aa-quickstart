import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const cardAccountAddress = process.env.BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = "0x610e208ef737a7918202B4CDD554B0D89d5cEA01" as Address;
const bundlerUrl = process.env.BASE_SEPOLIA_BUNDLER_URL;
const withdrawAmountUsdsc = process.env.WITHDRAW_AMOUNT_USDSC ?? "500";

const TRANSFER_RECIPIENT = "0x2cf491602ad22944D9047282aBC00D3e52F56B37" as Address;

if (!privateKey || !controllerValidatorAddress || !cardAccountAddress || !bundlerUrl) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS, or BASE_SEPOLIA_BUNDLER_URL is not set"
  );
}

const CARD_ACCOUNT_ABI = [
  {
    name: "withdrawToUserAccount",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "tokenAmount",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
      {
        name: "authorization",
        type: "tuple",
        components: [
          { name: "controllerSig", type: "bytes" },
          { name: "nonce", type: "uint256" },
          { name: "expiration", type: "uint48" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const chain = baseSepolia;
const publicClient = createPublicClient({ transport: http(), chain });
const signer = privateKeyToAccount(privateKey as Hex);

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
    });

    const userAccount = smartAccountClient.account.address as Address;
    spinner.succeed(`User AA: ${chalk.cyan(userAccount)}`);
    console.log("EOA (signer / controller):", signer.address);
    console.log("Card account:", cardAccountAddress);

    const amount = parseUnits(withdrawAmountUsdsc, 6);
    const nonce = BigInt(process.env.WITHDRAW_NONCE ?? "12345678");
    const expiration = Math.floor(Date.now() / 1000) + 3600;

    console.log(`\nWithdraw ${withdrawAmountUsdsc} USDSC → user AA ${userAccount}`);
    console.log(`Nonce: ${nonce}, Expiration: ${expiration}`);

    // EIP-712 controller authorization — domain confirmed via eip712Domain() on-chain
    spinner.start("Signing EIP-712 Withdraw as controller...");

    const ecdsaSig = await signer.signTypedData({
      domain: {
        name: "CardAccount",
        version: "1",
        chainId: chain.id,
        verifyingContract: cardAccountAddress,
      },
      types: {
        Withdraw: [
          { name: "userAccount", type: "address" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "expires", type: "uint48" },
        ],
      },
      primaryType: "Withdraw",
      message: {
        userAccount,
        token: usdscAddress,
        amount,
        nonce,
        expires: expiration,
      },
    });

    // Nexus EIP-1271: prefix with validator module address so the controller
    // Nexus account routes verification to the correct ECDSA validator.
    const controllerSig = encodePacked(
      ["address", "bytes"],
      [controllerValidatorAddress, ecdsaSig]
    );
    spinner.succeed(`Controller signature (prefixed): ${chalk.cyan(controllerSig.slice(0, 22))}...`);

    const withdrawCallData = encodeFunctionData({
      abi: CARD_ACCOUNT_ABI,
      functionName: "withdrawToUserAccount",
      args: [
        { token: usdscAddress, amount },
        { controllerSig, nonce, expiration },
      ],
    });

    const transferCallData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [TRANSFER_RECIPIENT, amount],
    });

    console.log(`Forward ${withdrawAmountUsdsc} USDSC → ${TRANSFER_RECIPIENT}`);
    spinner.start("Sending withdraw + transfer via sendUserOperation...");

    const hash = await smartAccountClient.sendUserOperation({
      calls: [
        { to: cardAccountAddress, value: 0n, data: withdrawCallData },
        { to: usdscAddress, value: 0n, data: transferCallData },
      ],
    });

    console.log("\nUserOp hash:", chalk.cyan(hash));
    spinner.start("Waiting for receipt...");

    const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash });
    spinner.succeed(
      chalk.greenBright.bold(
        `Withdrew ${withdrawAmountUsdsc} USDSC and forwarded to ${TRANSFER_RECIPIENT}`
      )
    );
    console.log("Tx hash:", receipt.receipt.transactionHash);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
