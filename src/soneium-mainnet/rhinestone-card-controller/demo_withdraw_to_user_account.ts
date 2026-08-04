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
import { soneium } from "viem/chains";
import { createSCSPaymasterClient, createSmartAccountClient, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.MAINNET_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const paymasterId = process.env.PAYMASTER_ID;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const cardAccountAddress = process.env.MAINNET_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = process.env.MAINNET_USDSC_ADDRESS as Address;
const withdrawAmountUsdsc = process.env.WITHDRAW_AMOUNT_USDSC ?? "0.1";
const withdrawNonce = process.env.WITHDRAW_NONCE;
// Optional — only forwards the withdrawn USDSC onward if explicitly set.
// Left unset, the withdrawn amount simply lands in the user AA account.
const forwardRecipient = process.env.WITHDRAW_FORWARD_RECIPIENT as Address | undefined;

if (!bundlerUrl || !paymasterUrl || !privateKey || !controllerValidatorAddress || !cardAccountAddress || !usdscAddress || !withdrawNonce) {
  throw new Error(
    "MAINNET_BUNDLER_URL, PAYMASTER_SERVICE_URL, OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, MAINNET_CARD_ACCOUNT_ADDRESS, MAINNET_USDSC_ADDRESS, or WITHDRAW_NONCE is not set"
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
    console.log("EOA (signer / controller):", signer.address);
    console.log("Card account:", cardAccountAddress);

    const amount = parseUnits(withdrawAmountUsdsc, 6);
    const nonce = BigInt(withdrawNonce);
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

    const calls: { to: Address; value: bigint; data: Hex }[] = [
      { to: cardAccountAddress, value: 0n, data: withdrawCallData },
    ];

    if (forwardRecipient) {
      console.log(`Forward ${withdrawAmountUsdsc} USDSC → ${forwardRecipient}`);
      calls.push({
        to: usdscAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [forwardRecipient, amount],
        }),
      });
    }

    spinner.start(`Sending withdraw${forwardRecipient ? " + transfer" : ""} via sendUserOperation...`);

    const hash = await smartAccountClient.sendUserOperation({ calls });

    console.log("\nUserOp hash:", chalk.cyan(hash));
    spinner.start("Waiting for receipt...");

    const receipt = await smartAccountClient.waitForUserOperationReceipt({ hash });
    spinner.succeed(
      chalk.greenBright.bold(
        forwardRecipient
          ? `Withdrew ${withdrawAmountUsdsc} USDSC and forwarded to ${forwardRecipient}`
          : `Withdrew ${withdrawAmountUsdsc} USDSC to user AA ${userAccount}`
      )
    );
    console.log("Tx hash:", receipt.receipt.transactionHash);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
