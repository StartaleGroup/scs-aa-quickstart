import "dotenv/config";
import { http, type Address, type Hex, createPublicClient, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { soneiumMinato } from "viem/chains";
import { Counter as CounterAbi } from "../abi/Counter";
import {
  createSCSPaymasterClient,
  createSmartAccountClient,
  toStartaleSmartAccount,
  ENTRY_POINT_ADDRESS,
} from "@startale-scs/aa-sdk";

const bundlerUrl = process.env.MINATO_BUNDLER_URL!;
const paymasterUrl = process.env.PAYMASTER_SERVICE_URL!;
const privateKey = process.env.OWNER_PRIVATE_KEY!;
const counterContract = process.env.COUNTER_CONTRACT_ADDRESS as Address;
const paymasterId = process.env.PAYMASTER_ID;

const chain = soneiumMinato;
const publicClient = createPublicClient({ transport: http(), chain });
const scsPaymasterClient = createSCSPaymasterClient({ transport: http(paymasterUrl) });
const signer = privateKeyToAccount(privateKey as Hex);

const callData = encodeFunctionData({ abi: CounterAbi, functionName: "count" });
const calls = [{ to: counterContract, value: 0n, data: callData }];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (name: string) => `\n${"=".repeat(55)}\n  ${name}\n${"=".repeat(55)}`;

const fetchStub = () =>
  scsPaymasterClient.getPaymasterStubData({
    chainId: chain.id,
    entryPointAddress: ENTRY_POINT_ADDRESS as Address,
    context: { calculateGasLimits: false, paymasterId },
    sender: "0x0000000000000000000000000000000000000000",
    callData: "0x" as Hex,
    nonce: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
  });

const main = async () => {
  const account = await toStartaleSmartAccount({
    signer,
    chain,
    transport: http(),
    index: BigInt(2132),
  });
  console.log("Smart Account:", account.address);

  // ── SCENARIO 0: prefetch stub + gas estimation ─────────────────
  // BEFORE CLICK: pm_getPaymasterStubData + eth_estimateUserOperationGas
  // AT CLICK:     pm_getPaymasterData + eth_sendUserOperation          (2 RPCs)
  // ───────────────────────────────────────────────────────────────
  console.log(label("Scenario 0 — prefetch stub + gas estimation"));

  console.log("[prefetch] Fetching stub + estimating gas...");
  const prefetchStart0 = Date.now();

  const stub0 = await fetchStub();

  const prefetchClient0 = createSmartAccountClient({
    account,
    transport: http(bundlerUrl),
    client: publicClient,
    paymaster: {
      getPaymasterStubData: async () => stub0,
      getPaymasterData: (p: any) => scsPaymasterClient.getPaymasterData(p),
    },
    paymasterContext: { calculateGasLimits: false, paymasterId },
  });

  const preparedOp = await prefetchClient0.prepareUserOperation({ calls });
  const prefetchDuration0 = Date.now() - prefetchStart0;

  console.log("[prefetch] Done in          :", prefetchDuration0, "ms");
  console.log("[prefetch] callGasLimit     :", preparedOp.callGasLimit);
  console.log("[prefetch] verificationGas  :", preparedOp.verificationGasLimit);
  console.log("[prefetch] preVerification  :", preparedOp.preVerificationGas);

  console.log("\n[waiting 2s — simulating user thinking...]\n");
  await sleep(2000);

  console.log("[click] Sending userOp with cached gas...");
  const clickStart0 = Date.now();
  let clickDuration0 = 0;

  try {
    const client0 = createSmartAccountClient({
      account,
      transport: http(bundlerUrl),
      client: publicClient,
      paymaster: {
        getPaymasterStubData: async () => {
          console.log("  [paymaster] stub  → cache");
          return stub0;
        },
        getPaymasterData: async (p: any) => {
          console.log("  [paymaster] data  → signing...");
          return scsPaymasterClient.getPaymasterData(p);
        },
      },
      paymasterContext: { calculateGasLimits: false, paymasterId },
    });
    const hash0 = await client0.sendUserOperation({
      calls,
      callGasLimit: preparedOp.callGasLimit,
      verificationGasLimit: preparedOp.verificationGasLimit,
      preVerificationGas: preparedOp.preVerificationGas,
    });
    const receipt0 = await client0.waitForUserOperationReceipt({ hash: hash0 });
    clickDuration0 = Date.now() - clickStart0;
    console.log("\nUserOp hash :", hash0);
    console.log("Tx hash     :", receipt0.receipt.transactionHash);
    console.log("Status      :", receipt0.success ? "success" : "failed");
    console.log("Click time  :", clickDuration0, "ms");
  } catch (e: any) {
    clickDuration0 = Date.now() - clickStart0;
    console.error("\nScenario 0 failed:", e.message?.split("\n")[0]);
    console.log("Click time  :", clickDuration0, "ms (failed)");
  }

  // ── SCENARIO 1: prefetch stub only ─────────────────────────────
  // BEFORE CLICK: pm_getPaymasterStubData
  // AT CLICK:     eth_estimateUserOperationGas + pm_getPaymasterData + eth_sendUserOperation  (3 RPCs)
  // ───────────────────────────────────────────────────────────────
  console.log(label("Scenario 1 — prefetch stub only"));

  console.log("[prefetch] Fetching stub...");
  const prefetchStart1 = Date.now();
  const stub1 = await fetchStub();
  const prefetchDuration1 = Date.now() - prefetchStart1;
  console.log("[prefetch] Done in:", prefetchDuration1, "ms");

  console.log("\n[waiting 2s — simulating user thinking...]\n");
  await sleep(2000);

  console.log("[click] Sending userOp...");
  const clickStart1 = Date.now();
  let clickDuration1 = 0;

  try {
    const client1 = createSmartAccountClient({
      account,
      transport: http(bundlerUrl),
      client: publicClient,
      paymaster: {
        getPaymasterStubData: async () => {
          console.log("  [paymaster] stub  → cache");
          return stub1;
        },
        getPaymasterData: async (p: any) => {
          console.log("  [paymaster] data  → signing...");
          return scsPaymasterClient.getPaymasterData(p);
        },
      },
      paymasterContext: { calculateGasLimits: false, paymasterId },
    });
    const hash1 = await client1.sendUserOperation({ calls });
    const receipt1 = await client1.waitForUserOperationReceipt({ hash: hash1 });
    clickDuration1 = Date.now() - clickStart1;
    console.log("\nUserOp hash :", hash1);
    console.log("Tx hash     :", receipt1.receipt.transactionHash);
    console.log("Status      :", receipt1.success ? "success" : "failed");
    console.log("Click time  :", clickDuration1, "ms");
  } catch (e: any) {
    clickDuration1 = Date.now() - clickStart1;
    console.error("\nScenario 1 failed:", e.message?.split("\n")[0]);
    console.log("Click time  :", clickDuration1, "ms (failed)");
  }

  // ── SCENARIO 2: no prefetch — baseline ─────────────────────────
  // AT CLICK: pm_getPaymasterStubData + eth_estimateUserOperationGas + pm_getPaymasterData + eth_sendUserOperation  (4 RPCs)
  // ───────────────────────────────────────────────────────────────
  console.log(label("Scenario 2 — no prefetch (baseline)"));

  console.log("[click] Sending userOp...");
  const clickStart2 = Date.now();
  let clickDuration2 = 0;

  try {
    const client2 = createSmartAccountClient({
      account,
      transport: http(bundlerUrl),
      client: publicClient,
      paymaster: scsPaymasterClient,
      paymasterContext: { calculateGasLimits: true, paymasterId },
    });
    const hash2 = await client2.sendUserOperation({ calls });
    const receipt2 = await client2.waitForUserOperationReceipt({ hash: hash2 });
    clickDuration2 = Date.now() - clickStart2;
    console.log("\nUserOp hash :", hash2);
    console.log("Tx hash     :", receipt2.receipt.transactionHash);
    console.log("Status      :", receipt2.success ? "success" : "failed");
    console.log("Click time  :", clickDuration2, "ms");
  } catch (e: any) {
    clickDuration2 = Date.now() - clickStart2;
    console.error("\nScenario 2 failed:", e.message?.split("\n")[0]);
    console.log("Click time  :", clickDuration2, "ms (failed)");
  }

  // ── SUMMARY ─────────────────────────────────────────────────────
  console.log(label("Summary — Soneium Minato"));
  console.log(`Scenario 0  prefetch: ${prefetchDuration0}ms  |  click: ${clickDuration0}ms  (2 RPCs)`);
  console.log(`Scenario 1  prefetch: ${prefetchDuration1}ms  |  click: ${clickDuration1}ms  (3 RPCs)`);
  console.log(`Scenario 2  no prefetch            |  click: ${clickDuration2}ms  (4 RPCs, baseline)`);
  console.log(`\nS0 vs S2 click saving: ~${clickDuration2 - clickDuration0}ms`);
  console.log(`S1 vs S2 click saving: ~${clickDuration2 - clickDuration1}ms`);

  process.exit(0);
};

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
