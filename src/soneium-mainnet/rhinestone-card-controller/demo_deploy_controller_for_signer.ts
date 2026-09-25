import "dotenv/config";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  formatEther,
  getAddress,
  isAddress,
  parseAbi,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress, toAccount } from "viem/accounts";
import { soneium } from "viem/chains";
import { createRhinestoneAccount } from "@rhinestone/sdk";
import chalk from "chalk";

// Deploys a fresh controller account whose only owner is CONTROLLER_SIGNER — a signer we
// don't hold the key for (e.g. KMS). Address derivation only needs the owner address, and the
// factory is permissionless, so any funded EOA can deploy it without the owner signing.
const controllerSignerInput = process.env.CONTROLLER_SIGNER;
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.OWNER_PRIVATE_KEY;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;
const rhinestoneApiKey = process.env.RHINESTONE_API_KEY;

if (!controllerSignerInput || !deployerPrivateKey || !controllerValidatorAddress || !rhinestoneApiKey) {
  throw new Error(
    "CONTROLLER_SIGNER, DEPLOYER_PRIVATE_KEY (or OWNER_PRIVATE_KEY), CONTROLLER_VALIDATOR_ADDRESS, or RHINESTONE_API_KEY is not set"
  );
}

const resolveSignerAddress = (input: string): Address => {
  if (isAddress(input)) return getAddress(input);
  if (/^0x04[0-9a-fA-F]{128}$/.test(input)) return publicKeyToAddress(input as Hex);
  throw new Error(
    "CONTROLLER_SIGNER must be an address or an uncompressed public key (0x04 + 64 bytes)"
  );
};

const CONTROLLER_VALIDATOR_ABI = parseAbi([
  "function getOwners(address account) view returns (address[])",
  "function threshold(address account) view returns (uint256)",
]);
const FACTORY_ABI = parseAbi(["function createAccount(bytes,bytes32) returns (address)"]);

const chain = soneium;
const publicClient = createPublicClient({ transport: http(), chain });
const deployer = privateKeyToAccount(deployerPrivateKey as Hex);
const walletClient = createWalletClient({ account: deployer, transport: http(), chain });
const controllerSigner = resolveSignerAddress(controllerSignerInput);

// Address-only stand-in for the real signer: enough to derive the account address and init
// data. Signing is never needed here — fail loudly if the SDK ever tries.
const noSign = async (): Promise<Hex> => {
  throw new Error("Signer key not available — address-only account cannot sign");
};
const signerStub = toAccount({
  address: controllerSigner,
  signMessage: noSign,
  signTypedData: noSign,
  signTransaction: noSign,
});

const printOwners = async (account: Address) => {
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
  console.log("Owners:", owners);
  console.log("Threshold:", threshold.toString());
};

const main = async () => {
  console.log(chalk.bold("\n=== Deploy controller account for an external signer (Soneium Mainnet) ===\n"));
  console.log("Controller signer (owner):", chalk.cyan(controllerSigner));
  console.log("Deployer (gas payer only):", chalk.cyan(deployer.address));
  console.log("ControllerValidator:", chalk.cyan(controllerValidatorAddress));

  // Same config as the other controller scripts, so the signer derives this address naturally
  const account = await createRhinestoneAccount({
    account: { type: "startale" as const, version: "1.0.0" as const },
    owners: {
      type: "ecdsa",
      accounts: [signerStub],
      module: controllerValidatorAddress,
    },
    apiKey: rhinestoneApiKey,
  });

  const address = account.getAddress();
  console.log("\nCounterfactual controller address:", chalk.cyan(address));

  if (await publicClient.getCode({ address })) {
    console.log(chalk.yellow("Already deployed — nothing to do."));
    await printOwners(address);
    return;
  }

  const { factory, factoryData } = account.getInitData();
  console.log("Factory:", factory);

  // Simulate first: the factory must produce the same address the SDK derived
  const { data: returnData } = await publicClient.call({
    account: deployer.address,
    to: factory,
    data: factoryData,
  });
  if (!returnData) throw new Error("Factory simulation returned no data");
  const simulated = decodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: "createAccount",
    data: returnData,
  });
  if (simulated.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`Factory would deploy ${simulated}, expected ${address} — aborting`);
  }
  console.log(chalk.green("Simulation OK — factory returns the expected address"));

  const balance = await publicClient.getBalance({ address: deployer.address });
  console.log("Deployer balance:", formatEther(balance), "ETH");

  console.log(chalk.bold("\nSending createAccount from deployer EOA..."));
  const txHash = await walletClient.sendTransaction({ to: factory, data: factoryData });
  console.log("Tx hash:", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`Deployment tx reverted: ${txHash}`);

  if (!(await publicClient.getCode({ address }))) {
    throw new Error(`No code at ${address} after deployment`);
  }
  console.log(chalk.greenBright.bold(`\n✔ Controller deployed at ${address}`));
  await printOwners(address);
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
