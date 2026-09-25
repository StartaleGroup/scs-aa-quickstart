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
// Comma-separated owners to remove — addresses or uncompressed public keys (0x04...)
const ownersToRemoveInput = process.env.OWNERS_TO_REMOVE;

if (!privateKey || !controllerValidatorAddress || !rhinestoneApiKey || !ownersToRemoveInput) {
  throw new Error(
    "OWNER_PRIVATE_KEY, CONTROLLER_VALIDATOR_ADDRESS, RHINESTONE_API_KEY, or OWNERS_TO_REMOVE is not set"
  );
}

const resolveSignerAddress = (input: string): Address => {
  if (isAddress(input)) return getAddress(input);
  if (/^0x04[0-9a-fA-F]{128}$/.test(input)) return publicKeyToAddress(input as Hex);
  throw new Error(`Invalid owner "${input}" — must be an address or an uncompressed public key`);
};

// Head of the validator's owner linked list — prevOwner for the first entry
const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;

const CONTROLLER_VALIDATOR_ABI = [
  {
    name: "removeOwner",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "owner", type: "address" },
    ],
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
  { name: "LinkedList_InvalidEntry", type: "error", inputs: [{ name: "entry", type: "address" }] },
  { name: "NotInitialized", type: "error", inputs: [{ name: "smartAccount", type: "address" }] },
] as const;

const chain = soneium;
const publicClient = createPublicClient({ transport: http(), chain });
const signer = privateKeyToAccount(privateKey as Hex);
const ownersToRemove = [
  ...new Set(
    ownersToRemoveInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(resolveSignerAddress)
  ),
];

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
  return { owners: owners.map((o) => getAddress(o)), threshold };
};

const main = async () => {
  console.log(chalk.bold("\n=== Controller account: removeOwner on ControllerValidator (Soneium Mainnet) ===\n"));
  console.log("Signer (EOA):", chalk.cyan(signer.address));
  console.log("Owners to remove:", ownersToRemove);
  console.log("ControllerValidator:", chalk.cyan(controllerValidatorAddress));

  // Built with the original owner so the SDK derives the existing controller address
  const account = await createRhinestoneAccount({
    account: { type: "startale" as const, version: "1.0.0" as const },
    owners: {
      type: "ecdsa",
      accounts: [signer],
      module: controllerValidatorAddress,
    },
    apiKey: rhinestoneApiKey,
  });

  const address = account.getAddress();
  console.log("Controller account:", chalk.cyan(address));

  if (!(await account.isDeployed(chain))) {
    throw new Error("Controller account is not deployed");
  }

  const before = await readOwnerState(address);
  console.log("\nOwners (before):", before.owners);
  console.log("Threshold:", before.threshold.toString());

  if (!before.owners.includes(signer.address)) {
    throw new Error(`Signer ${signer.address} is not an owner of this controller`);
  }

  const missing = ownersToRemove.filter((o) => !before.owners.includes(o));
  if (missing.length) {
    throw new Error(`Not current owners: ${missing.join(", ")}`);
  }

  const remaining = before.owners.filter((o) => !ownersToRemove.includes(o));
  if (BigInt(remaining.length) < before.threshold) {
    throw new Error(
      `Would leave ${remaining.length} owner(s), below threshold ${before.threshold} — aborting`
    );
  }
  if (ownersToRemove.includes(signer.address)) {
    console.log(
      chalk.yellow(
        "\n⚠ Removing the signing key itself — this script (and others using OWNER_PRIVATE_KEY) can no longer act on this controller afterwards."
      )
    );
  }

  // prevOwner is the entry before the target in list order; walk a local copy so
  // each removal in the batch uses the list as it will be after the previous ones
  const list = [...before.owners];
  const calls = ownersToRemove.map((owner) => {
    const idx = list.indexOf(owner);
    const prevOwner = idx === 0 ? SENTINEL : list[idx - 1];
    list.splice(idx, 1);
    console.log(`removeOwner(prev: ${prevOwner}, owner: ${owner})`);
    return {
      to: controllerValidatorAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: CONTROLLER_VALIDATOR_ABI,
        functionName: "removeOwner",
        args: [prevOwner, owner],
      }),
    };
  });

  console.log(chalk.bold("\nSending removeOwner via sendTransaction (intent path, sponsored)..."));
  const result = await account.sendTransaction({ chain, calls, sponsored: true });
  console.log("Intent result:", result);
  const status = await account.waitForExecution(result);
  console.log("Status:", status);

  const after = await readOwnerState(address);
  console.log("\nOwners (after):", after.owners);
  console.log("Threshold:", after.threshold.toString());

  const stillThere = ownersToRemove.filter((o) => after.owners.includes(o));
  if (stillThere.length) {
    console.log(chalk.red(`\n✖ Still owners after execution: ${stillThere.join(", ")}`));
  } else {
    console.log(chalk.greenBright.bold(`\n✔ Removed ${ownersToRemove.length} owner(s)`));
  }
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
