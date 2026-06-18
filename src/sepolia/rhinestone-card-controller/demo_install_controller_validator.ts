import "dotenv/config";
import ora from "ora";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createSCSPaymasterClient, createSmartAccountClient, ModuleMeta, toStartaleSmartAccount } from "@startale-scs/aa-sdk";
import chalk from "chalk";

const bundlerUrl = process.env.SEPOLIA_BUNDLER_URL;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
const privateKey = process.env.OWNER_PRIVATE_KEY;
const paymasterId = process.env.PAYMASTER_ID;
const controllerValidatorAddress = process.env.CONTROLLER_VALIDATOR_ADDRESS as Address;

if (!bundlerUrl || !paymasterUrl || !privateKey || !controllerValidatorAddress) {
  throw new Error("SEPOLIA_BUNDLER_URL, PAYMASTER_SERVICE_URL, OWNER_PRIVATE_KEY, or CONTROLLER_VALIDATOR_ADDRESS is not set");
}

const chain = sepolia;
const publicClient = createPublicClient({
  transport: http(),
  chain,
});

const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(bundlerUrl),
});

const scsPaymasterClient = createSCSPaymasterClient({
  transport: http(paymasterUrl),
});

const signer = privateKeyToAccount(privateKey as Hex);

const scsContext = { calculateGasLimits: true, paymasterId: paymasterId };

const main = async () => {
  const spinner = ora({ spinner: "bouncingBar" });

  try {
    spinner.start("Initializing smart account...");

    const smartAccountClient = createSmartAccountClient({
      account: await toStartaleSmartAccount({
        signer: signer,
        chain: chain,
        transport: http(),
        index: BigInt(0),
      }),
      transport: http(bundlerUrl),
      client: publicClient,
      // paymaster: scsPaymasterClient,
      // paymasterContext: scsContext,
    });

    const address = smartAccountClient.account.address;
    spinner.succeed(`Smart account: ${address}`);
    console.log("EOA:", signer.address);

    // abi.encode(threshold, owners) — 1 owner, threshold 1
    const initData = encodeAbiParameters(
      parseAbiParameters("uint256, address[]"),
      [BigInt(1), [signer.address]]
    );

    console.log("initData", initData);

    const controllerValidator = {
      module: controllerValidatorAddress,
      initData,
      deInitData: "0x" as Hex,
      additionalContext: "0x" as Hex,
      type: "validator" as const,
    };

    (controllerValidator as any).address = controllerValidatorAddress;

    console.log("controllerValidator", controllerValidator);

    const isInstalled = await smartAccountClient.isModuleInstalled({
      module: controllerValidator as unknown as ModuleMeta,
    });
    console.log("ControllerValidator already installed:", isInstalled);

    if (!isInstalled) {
      spinner.start("Installing ControllerValidator...");
      const opHash = await smartAccountClient.installModule({
        module: controllerValidator as any,
      });
      console.log("UserOp hash:", opHash);

      const result = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
      console.log("Tx hash:", result.receipt.transactionHash);
      spinner.succeed(chalk.greenBright.bold("ControllerValidator installed successfully"));
    } else {
      spinner.succeed(chalk.greenBright.bold("ControllerValidator already installed"));
    }
  } catch (error) {
    spinner.fail(chalk.red(`Error: ${(error as Error).message}`));
  }
  process.exit(0);
};

main();
