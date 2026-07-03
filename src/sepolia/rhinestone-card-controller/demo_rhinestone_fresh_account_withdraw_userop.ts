import "dotenv/config";
import ora from "ora";
import {
  type Address,
  type Hex,
  encodeFunctionData,
  encodePacked,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const K1_DEFAULT_VALIDATOR = "0x00000072f286204bb934ed49d8969e86f7dec7b1" as Address;

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const cardAccountAddress = process.env.NEXUS_CARD_ACCOUNT_ADDRESS as Address;
const usdscAddress = (process.env.SEPOLIA_USDSC_ADDRESS ?? "0x7E426d026f604d1c47b50059752122d8ab1E2C28") as Address;
const withdrawAmountUsdsc = process.env.WITHDRAW_AMOUNT_USDSC ?? "100";
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!privateKey || !controllerValidatorAddress || !cardAccountAddress || !rhinestoneApiKey) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, NEXUS_CARD_ACCOUNT_ADDRESS, or RHINESTONE_API_KEY is not set"
  );
}

const TRANSFER_RECIPIENT = "0x2cf491602ad22944D9047282aBC00D3e52F56B37" as Address;

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

const chain = sepolia;
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
      apiKey: rhinestoneApiKey,
    });

    const userAccount = account.getAddress() as Address;
    spinner.succeed(`Nexus account (user): ${chalk.cyan(userAccount)}`);
    console.log("EOA (signer / controller):", signer.address);
    console.log("Card account:", cardAccountAddress);

    // Rhinestone intent orchestrator requires on-chain state — warm-up
    spinner.start("Checking deployment status...");
    const nexusDeployed = await account.isDeployed(chain);
    spinner.succeed(`Deployed: ${nexusDeployed}`);

    if (!nexusDeployed) {
      throw new Error(
        `User account ${userAccount} is not deployed. Run demo_rhinestone_fresh_account_activate.ts first.`
      );
    }

    const amount = parseUnits(withdrawAmountUsdsc, 6);

    // Non-sequential nonce — the card account tracks used nonces to prevent replay
    const nonce = BigInt(process.env.WITHDRAW_NONCE ?? "12345678");
    const expiration = Math.floor(Date.now() / 1000) + 3600;

    console.log(`\nWithdraw ${withdrawAmountUsdsc} USDSC → user account ${userAccount}`);
    console.log(`Nonce: ${nonce}, Expiration: ${expiration}`);

    // EIP-712 controller authorization
    // Domain confirmed via eip712Domain() on-chain: name="CardAccount", version="1"
    spinner.start("Signing EIP-712 WithdrawRequest as controller...");

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

    // Nexus EIP-1271: prefix ECDSA sig with the validator module address so the
    // controller Nexus account routes verification to the correct ECDSA validator.
    const controllerSig = encodePacked(
      ["address", "bytes"],
      [controllerValidatorAddress, ecdsaSig]
    );
    spinner.succeed(`Controller signature (prefixed): ${chalk.cyan(controllerSig.slice(0, 22))}...`);

    const callData = encodeFunctionData({
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
    spinner.start(`Sending withdraw + transfer via sendUserOperation...`);

    const result = await account.sendUserOperation({
      chain,
      calls: [
        { to: cardAccountAddress, value: 0n, data: callData },
        { to: usdscAddress, value: 0n, data: transferCallData },
      ],
    });

    console.log("\nUserOp hash:", result.hash);
    spinner.start("Waiting for execution...");

    const status = await account.waitForExecution(result);
    spinner.succeed(
      chalk.greenBright.bold(
        `Withdrew ${withdrawAmountUsdsc} USDSC and forwarded to ${TRANSFER_RECIPIENT}`
      )
    );
    console.log("Status:", status);
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
