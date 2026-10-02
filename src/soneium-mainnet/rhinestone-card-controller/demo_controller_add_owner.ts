import "dotenv/config";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  isAddress,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import { soneium } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

const privateKey = process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;
// New signer to add as an owner on the ControllerValidator — accepts an address
// or an uncompressed secp256k1 public key (0x04...)
const newSignerInput = process.env.NEW_CONTROLLER_SIGNER;

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey || !newSignerInput) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, or NEW_CONTROLLER_SIGNER is not set"
  );
}

const resolveSignerAddress = (input: string): Address => {
  if (isAddress(input)) return getAddress(input);
  if (/^0x04[0-9a-fA-F]{128}$/.test(input)) return publicKeyToAddress(input as Hex);
  throw new Error(
    "NEW_CONTROLLER_SIGNER must be an address or an uncompressed public key (0x04 + 64 bytes)"
  );
};

const CONTROLLER_VALIDATOR_ABI = [
  {
    name: "addOwner",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [],
  },
  {
    name: "getOwners",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "ownersArray", type: "address[]" }],
  },
  {
    name: "threshold",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { name: "CannotRemoveOwner", type: "error", inputs: [] },
  { name: "InvalidOwner", type: "error", inputs: [{ name: "owner", type: "address" }] },
  { name: "InvalidThreshold", type: "error", inputs: [] },
  { name: "MaxOwnersReached", type: "error", inputs: [] },
  {
    name: "LinkedList_EntryAlreadyInList",
    type: "error",
    inputs: [{ name: "entry", type: "address" }],
  },
  { name: "NotInitialized", type: "error", inputs: [{ name: "smartAccount", type: "address" }] },
] as const;

const chain = soneium;
const publicClient = createPublicClient({ transport: http(), chain });
const signer = privateKeyToAccount(privateKey as Hex);
const newSigner = resolveSignerAddress(newSignerInput);

const readOwnerState = async (account: Address) => {
  const [owners, threshold] = await Promise.all([
    publicClient.readContract({
      address: controllerValidatorAddress,
      abi: CONTROLLER_VALIDATOR_ABI,
      functionName: "getOwners",
      args: [account],
    }),
    publicClient.readContract({
      address: controllerValidatorAddress,
      abi: CONTROLLER_VALIDATOR_ABI,
      functionName: "threshold",
      args: [account],
    }),
  ]);
  return { owners, threshold };
};

const main = async () => {
  console.log(chalk.bold("\n=== Controller account: addOwner on ControllerValidator (Soneium Mainnet) ===\n"));
  console.log("Current signer (EOA):", chalk.cyan(signer.address));
  console.log("New signer:", chalk.cyan(newSigner));
  console.log("ControllerValidator:", chalk.cyan(controllerValidatorAddress));

  // Built with the original owner so the SDK derives the existing controller address
  const account = await createRhinestoneAccount({
    account: { type: "startale" as const },
    owners: {
      type: "ecdsa",
      accounts: [signer],
      module: controllerValidatorAddress,
    },
    apiKey: rhinestoneApiKey,
  });

  const address = account.getAddress();
  console.log("Controller account:", chalk.cyan(address));

  const deployed = await account.isDeployed(chain);
  if (!deployed) {
    throw new Error("Controller account is not deployed — run demo_deploy_nexus_with_controller_validator.ts first");
  }

  const before = await readOwnerState(address);
  console.log("\nOwners (before):", before.owners);
  console.log("Threshold:", before.threshold.toString());

  if (before.owners.some((o) => o.toLowerCase() === newSigner.toLowerCase())) {
    console.log(chalk.yellow("\nNew signer is already an owner — nothing to do."));
    return;
  }

  // addOwner is msg.sender-scoped: the controller account calls the validator on itself
  const callData = encodeFunctionData({
    abi: CONTROLLER_VALIDATOR_ABI,
    functionName: "addOwner",
    args: [newSigner],
  });

  console.log(chalk.bold("\nSending addOwner via sendTransaction (intent path, sponsored)..."));
  const result = await account.sendTransaction({
    chain,
    calls: [{ to: controllerValidatorAddress, value: 0n, data: callData }],
    sponsored: true,
  });
  console.log("Intent result:", result);
  const status = await account.waitForExecution(result);
  console.log("Status:", status);

  const after = await readOwnerState(address);
  console.log("\nOwners (after):", after.owners);
  console.log("Threshold:", after.threshold.toString());

  if (after.owners.some((o) => o.toLowerCase() === newSigner.toLowerCase())) {
    console.log(chalk.greenBright.bold(`\n✔ Added ${newSigner} as a controller owner`));
    console.log(`Set MAINNET_CARD_ACCOUNT_CONTROLLER=${address} for the *_new_signer scripts`);
  } else {
    console.log(chalk.red("\n✖ New signer not found in owners after execution"));
  }
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
