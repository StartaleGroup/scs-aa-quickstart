/**
 * AA Provider Benchmark — Soneium Mainnet (chain 1868)
 * Compares Pimlico · Alchemy · Startale SCS bundlers
 *
 * SECTION A — Raw RPC Latency (no wallet needed)
 *   A1. Gas price quote
 *   A2. eth_estimateUserOperationGas
 *   A3. eth_sendUserOperation (invalid sig → expected AA error)
 *
 * SECTION B — Real Transactions via Startale SDK
 *   Uses toStartaleSmartAccount + createSmartAccountClient
 *   All three providers run with SCS SPONSORSHIP_POSTPAID paymaster (sponsored)
 *   Reports: acceptance latency · inclusion time · fees paid · tx/userOp hashes
 *
 * Usage:
 *   npx ts-node src/soneium-mainnet/benchmark.ts [--skip-raw] [--skip-sdk] [--paymaster=native] [--json]
 *
 * Required env vars (in .env):
 *   OWNER_PRIVATE_KEY        — signer for smart account
 *   MAINNET_BUNDLER_URL      — Startale SCS bundler URL
 *   PAYMASTER_SERVICE_URL    — SCS paymaster service
 *   PAYMASTER_ID             — paymaster ID from SCS portal
 *   COUNTER_CONTRACT_ADDRESS — deployed counter (optional)
 *   PIMLICO_API_KEY          — Pimlico key (optional override)
 *   ALCHEMY_API_KEY          — Alchemy key (optional override)
 */

import "dotenv/config";
import chalk from "chalk";
import { http, custom, type Address, type Hex, createPublicClient, encodeFunctionData, formatEther } from "viem";
import { createPaymasterClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { soneium } from "viem/chains";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { Counter as CounterAbi } from "../abi/Counter";
import {
  createSCSPaymasterClient,
  createSmartAccountClient,
  toStartaleSmartAccount,
} from "@startale-scs/aa-sdk";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const N_RUNS   = 5;   // raw RPC iterations per test
const SDK_RUNS = 3;   // real transactions per provider
const TIMEOUT  = 10_000;
const EP_V07   = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

const SKIP_RAW        = process.argv.includes("--skip-raw");
const SKIP_SDK        = process.argv.includes("--skip-sdk");
const NATIVE_PAYMASTER = process.argv.includes("--paymaster=native");
const JSON_OUT        = process.argv.includes("--json");

// ─── ENV / KEYS ──────────────────────────────────────────────────────────────

const PIMLICO_KEY          = process.env.PIMLICO_API_KEY!;
const ALCHEMY_KEY          = process.env.ALCHEMY_API_KEY!;
const STARTALE_URL         = process.env.MAINNET_BUNDLER_URL ?? "";
const PAYMASTER_URL        = process.env.PAYMASTER_SERVICE_URL!;
const PAYMASTER_ID         = process.env.PAYMASTER_ID ?? "pm_1";
const PAYMASTER_ID_FALLBACK = process.env.PAYMASTER_ID_FALLBACK ?? "pm_2";
const PIMLICO_POLICY_ID    = process.env.PIMLICO_POLICY_ID ?? "";
const ALCHEMY_POLICY_ID    = process.env.ALCHEMY_POLICY_ID ?? "";
const PRIVATE_KEY          = process.env.OWNER_PRIVATE_KEY as Hex | undefined;
const COUNTER              = process.env.COUNTER_CONTRACT_ADDRESS as Address | undefined;

// ─── PIMLICO TRANSPORT ADAPTER ───────────────────────────────────────────────
// The @startale-scs/aa-sdk internally calls `rundler_maxPriorityFeePerGas` (Alchemy Rundler
// method) to fetch gas prices when building a UserOp. Pimlico's bundler exposes the same
// data under `pimlico_getUserOperationGasPrice`. This adapter rewrites the call on the fly
// so the SDK works with Pimlico without modification.

function pimlicoBundlerTransport(url: string) {
  return custom({
    async request({ method, params }: { method: string; params?: readonly unknown[] }) {
      let callMethod = method;
      let callParams: unknown[] = (params as unknown[]) ?? [];

      if (method === "rundler_maxPriorityFeePerGas") {
        callMethod = "pimlico_getUserOperationGasPrice";
        callParams  = [];
      }

      const res  = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: callMethod, params: callParams }),
      });
      const body = await res.json() as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (body.error) {
        const err = new Error(body.error.message) as Error & { code?: number };
        err.code = body.error.code;
        throw err;
      }

      // pimlico_getUserOperationGasPrice returns {slow,standard,fast} — extract the priority
      // fee from the standard tier to match the hex string that rundler_maxPriorityFeePerGas returns.
      if (method === "rundler_maxPriorityFeePerGas") {
        const r = body.result as { standard?: { maxPriorityFeePerGas: string } } | null;
        return r?.standard?.maxPriorityFeePerGas ?? "0x77359400";
      }

      return body.result;
    },
  });
}

// ─── PROVIDERS ───────────────────────────────────────────────────────────────

interface Provider {
  id: string;
  name: string;
  tech: string;
  url: string;
  gasMethod: string;
  nativePaymasterContext?: Record<string, unknown>;
}

const PROVIDERS: Provider[] = [
  {
    id:        "pimlico",
    name:      "Pimlico",
    tech:      "Alto (TypeScript)",
    url:       `https://api.pimlico.io/v2/soneium/rpc?apikey=${PIMLICO_KEY}`,
    gasMethod: "pimlico_getUserOperationGasPrice",
    nativePaymasterContext: PIMLICO_POLICY_ID ? { sponsorshipPolicyId: PIMLICO_POLICY_ID } : undefined,
  },
  {
    id:        "alchemy",
    name:      "Alchemy",
    tech:      "Rundler (Rust)",
    url:       `https://soneium-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    gasMethod: "rundler_maxPriorityFeePerGas",
    nativePaymasterContext: ALCHEMY_POLICY_ID ? { policyId: ALCHEMY_POLICY_ID } : undefined,
  },
  ...(STARTALE_URL ? [{
    id:        "startale",
    name:      "Startale SCS",
    tech:      "SCS Bundler",
    url:       STARTALE_URL,
    gasMethod: "eth_maxPriorityFeePerGas",
  }] : []),
];

const PROVIDER_COLOR: Record<string, (s: string) => string> = {
  pimlico:  chalk.magenta,
  alchemy:  chalk.cyan,
  startale: chalk.yellow,
};
const pc = (id: string, s: string) => (PROVIDER_COLOR[id] ?? chalk.white)(s);

// ─── DUMMY USEROP (Section A) ─────────────────────────────────────────────────

const DUMMY_USEROP = {
  sender:                        "0xc0ffee254729296a45a3885639AC7E10F9d54979",
  nonce:                         "0x0",
  factory:                       null,
  factoryData:                   null,
  callData:                      "0x",
  callGasLimit:                  "0x15F90",
  verificationGasLimit:          "0x15F90",
  preVerificationGas:            "0xBB8",
  maxFeePerGas:                  "0x77359400",
  maxPriorityFeePerGas:          "0x3B9ACA00",
  paymaster:                     null,
  paymasterVerificationGasLimit: null,
  paymasterPostOpGasLimit:       null,
  paymasterData:                 null,
  signature:                     "0x" + "ab".repeat(65),
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function rpcCall(url: string, method: string, params: unknown[] = []) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const t0    = performance.now();
  try {
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal:  ctrl.signal,
    });
    const body = await res.json() as { result?: unknown; error?: { message: string } };
    const ms   = Math.round(performance.now() - t0);
    clearTimeout(timer);
    if (body.error) return { ms, ok: false, result: null, error: body.error };
    return { ms, ok: true, result: body.result, error: null };
  } catch (e: unknown) {
    const ms = Math.round(performance.now() - t0);
    clearTimeout(timer);
    const msg = e instanceof Error
      ? (e.name === "AbortError" ? `TIMEOUT (>${TIMEOUT}ms)` : e.message)
      : String(e);
    return { ms, ok: false, result: null, error: { message: msg } };
  }
}

function stats(arr: number[]) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    min:    s[0],
    median: s[Math.floor(s.length / 2)],
    p95:    s[Math.floor(s.length * 0.95)] ?? s[s.length - 1],
    mean:   Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
    max:    s[s.length - 1],
    raw:    arr,
  };
}

function fmtStats(s: ReturnType<typeof stats>) {
  return `min=${String(s.min + "ms").padEnd(7)} median=${String(s.median + "ms").padEnd(7)} p95=${String(s.p95 + "ms").padEnd(7)} mean=${s.mean}ms`;
}

function hexToGwei(hex: string | null) {
  if (!hex) return null;
  try { return Number(BigInt(hex)) / 1e9; } catch { return null; }
}

function fmtGwei(n: number | null) {
  if (n === null) return "n/a";
  return n < 0.001 ? "<0.001 gwei" : n.toFixed(4) + " gwei";
}

function parseGasQuote(method: string, result: unknown): string {
  if (!result) return "no data";
  if (typeof result === "object" && result !== null && "standard" in result) {
    const r = result as { standard: { maxFeePerGas: string; maxPriorityFeePerGas: string } };
    return `maxFee=${fmtGwei(hexToGwei(r.standard.maxFeePerGas))}  prio=${fmtGwei(hexToGwei(r.standard.maxPriorityFeePerGas))}`;
  }
  if (typeof result === "string" && result.startsWith("0x")) {
    return `priorityFee=${fmtGwei(hexToGwei(result))}`;
  }
  return JSON.stringify(result).slice(0, 80);
}

function hr() { console.log(chalk.bold("─".repeat(72))); }
function section(title: string) { console.log(""); hr(); console.log(chalk.bold(`  ${title}`)); hr(); }

async function bench(provider: Provider, method: string, params: unknown[]) {
  const times: number[] = [];
  let last: Awaited<ReturnType<typeof rpcCall>> | undefined;
  process.stdout.write(`  ${pc(provider.id, provider.id.padEnd(12))}  `);
  for (let i = 0; i < N_RUNS; i++) {
    const r = await rpcCall(provider.url, method, params);
    times.push(r.ms);
    last = r;
    process.stdout.write(r.ok ? chalk.green("●") : chalk.red("●"));
  }
  process.stdout.write("  ");
  return { stats: stats(times), last: last! };
}

// ─── SECTION A: Raw RPC Latency ──────────────────────────────────────────────

async function runRawBenchmark() {
  section("SECTION A · Raw RPC Latency");

  const ALL: Record<string, Record<string, { stats: ReturnType<typeof stats>; last: Awaited<ReturnType<typeof rpcCall>> }>> = {};
  for (const p of PROVIDERS) ALL[p.id] = {};

  // A1: Gas price
  console.log(chalk.dim("\n  A1 · Gas Price Quote\n"));
  for (const p of PROVIDERS) {
    const { stats: s, last } = await bench(p, p.gasMethod, []);
    ALL[p.id].gasPrice = { stats: s, last };
    const quote = last.ok
      ? parseGasQuote(p.gasMethod, last.result)
      : chalk.red(last.error?.message?.slice(0, 70) ?? "error");
    console.log(`${fmtStats(s)}`);
    console.log(`  ${chalk.dim("└─")} ${chalk.dim(quote)}\n`);
  }

  // A2: estimateUserOperationGas
  console.log(chalk.dim("  A2 · eth_estimateUserOperationGas\n"));
  for (const p of PROVIDERS) {
    const { stats: s, last } = await bench(p, "eth_estimateUserOperationGas", [DUMMY_USEROP, EP_V07]);
    ALL[p.id].estimateGas = { stats: s, last };
    const detail = last.ok
      ? `callGasLimit=${(last.result as { callGasLimit?: string })?.callGasLimit}`
      : chalk.dim(`[expected err] ${(last.error?.message ?? "").slice(0, 70)}`);
    console.log(`${fmtStats(s)}`);
    console.log(`  ${chalk.dim("└─")} ${detail}\n`);
  }

  // A3: sendUserOperation (invalid sig)
  console.log(chalk.dim("  A3 · eth_sendUserOperation (invalid sig → expected AA error)\n"));
  for (const p of PROVIDERS) {
    const { stats: s, last } = await bench(p, "eth_sendUserOperation", [DUMMY_USEROP, EP_V07]);
    ALL[p.id].sendUserOp = { stats: s, last };
    const detail = last.ok
      ? chalk.green(`✓ accepted — hash=${String(last.result).slice(0, 20)}...`)
      : chalk.dim(`[expected err] ${(last.error?.message ?? "").slice(0, 70)}`);
    console.log(`${fmtStats(s)}`);
    console.log(`  ${chalk.dim("└─")} ${detail}\n`);
  }

  // Summary
  section("SECTION A · Summary (median ms)");
  const TESTS = [
    { key: "gasPrice",    label: "Gas price quote" },
    { key: "estimateGas", label: "estimateUserOperationGas" },
    { key: "sendUserOp",  label: "sendUserOperation" },
  ];
  const COL = 30, PCOL = 14;
  console.log(`\n  ${"".padEnd(COL)} ${PROVIDERS.map(p => pc(p.id, p.name.padEnd(PCOL))).join("")}`);
  console.log(`  ${"─".repeat(COL)} ${PROVIDERS.map(() => "─".repeat(PCOL)).join("")}`);
  for (const t of TESTS) {
    const medians = PROVIDERS.map(p => ALL[p.id]?.[t.key]?.stats?.median ?? Infinity);
    const minVal  = Math.min(...medians.filter(v => v < Infinity));
    process.stdout.write(`  ${t.label.padEnd(COL)} `);
    PROVIDERS.forEach((p) => {
      const m = ALL[p.id]?.[t.key]?.stats?.median;
      if (m == null) { process.stdout.write("—".padEnd(PCOL)); return; }
      const cell = `${m}ms`.padEnd(PCOL);
      process.stdout.write(m === minVal ? chalk.green.bold(cell) : pc(p.id, cell));
    });
    process.stdout.write("\n");
  }

  return ALL;
}

// ─── SECTION B: SDK Real Transactions ────────────────────────────────────────

interface SdkRun {
  ok: boolean;
  acceptMs?: number;
  inclusionMs?: number;
  totalMs: number;
  gasUsed?: bigint;
  gasCostWei?: bigint;
  userOpHash?: string;
  txHash?: string;
  error?: string;
}

async function runSdkBenchmark() {
  section("SECTION B · SDK Real Transactions (Startale Smart Account)");

  if (!PRIVATE_KEY) {
    console.log(chalk.yellow("  ⚠  OWNER_PRIVATE_KEY not set — skipping\n"));
    return null;
  }

  const chain  = soneium;
  const signer = privateKeyToAccount(PRIVATE_KEY);

  const publicClient = createPublicClient({ transport: http("https://rpc.soneium.org"), chain });

  const usePaymaster = !!(PAYMASTER_URL && PAYMASTER_ID);
  const scsPaymasterClient = usePaymaster
    ? createSCSPaymasterClient({ transport: http(PAYMASTER_URL) })
    : undefined;

  const paymasterMode: "native" | "scs" | "self-pay" = NATIVE_PAYMASTER
    ? "native"
    : usePaymaster ? "scs" : "self-pay";

  if (paymasterMode === "native") {
    if (!PIMLICO_POLICY_ID) console.log(chalk.yellow("  ⚠  PIMLICO_POLICY_ID not set — Pimlico will run self-pay"));
    if (!ALCHEMY_POLICY_ID) console.log(chalk.yellow("  ⚠  ALCHEMY_POLICY_ID not set — Alchemy will run self-pay"));
  }

  const account = await toStartaleSmartAccount({
    signer,
    chain,
    transport: http(),
    index: 0n,
  });

  const balance    = await publicClient.getBalance({ address: account.address });
  const useCounter = !!COUNTER;
  const callData   = useCounter
    ? encodeFunctionData({ abi: CounterAbi, functionName: "count" })
    : "0x" as Hex;

  console.log(`\n  Smart account : ${chalk.bold(account.address)}`);
  console.log(`  EOA signer    : ${signer.address}`);
  console.log(`  Balance       : ${formatEther(balance)} ETH`);
  console.log(`  Paymaster     : ${
    paymasterMode === "native"
      ? chalk.blue("native per-provider (--paymaster=native)")
      : paymasterMode === "scs"
        ? chalk.green(`${PAYMASTER_URL}  id=${PAYMASTER_ID} (fallback: ${PAYMASTER_ID_FALLBACK})`)
        : chalk.yellow("not configured — set PAYMASTER_SERVICE_URL + PAYMASTER_ID")
  }`);
  console.log(`  Self-pay ETH  : ${balance > 0n ? chalk.green(`${formatEther(balance)} ETH`) : chalk.yellow("0 — self-pay runs will fail")}`);

  if (paymasterMode === "self-pay" && balance === 0n) {
    console.log(chalk.red("\n  ✗ No ETH and no paymaster — fund the account or configure PAYMASTER_SERVICE_URL\n"));
    return null;
  }

  const sdkResults: Record<string, SdkRun[]> = {};

  for (const p of PROVIDERS) {
    sdkResults[p.id] = [];
    // Reset paymaster ID per provider so a fallback on one provider doesn't bleed into the next
    let activePaymasterId = PAYMASTER_ID;

    // In native mode, use provider-specific ERC-7677 paymaster clients
    const nativePaymasterClient = paymasterMode === "native" && p.id !== "startale" && p.nativePaymasterContext
      ? (p.id === "pimlico"
          ? createPimlicoClient({ transport: http(p.url), chain })
          : createPaymasterClient({ transport: http(p.url) }))
      : undefined;

    const gasModel = paymasterMode === "native"
      ? (p.id === "startale"
          ? chalk.green("SCS native")
          : p.nativePaymasterContext
            ? chalk.blue(`${p.name} native paymaster`)
            : chalk.yellow("no policy ID configured — self-pay"))
      : paymasterMode === "scs"
        ? chalk.green(`SCS SPONSORSHIP_POSTPAID → ${p.name} bundler`)
        : chalk.yellow("self-pay");
    console.log(`\n  ${pc(p.id, chalk.bold(p.name))}  (${chalk.dim(p.tech)})  gas: ${gasModel}`);

    for (let i = 0; i < SDK_RUNS; i++) {
      process.stdout.write(`    run ${i + 1}/${SDK_RUNS}  `);
      const t0 = performance.now();

      // Resolve paymaster client + context for this run
      const activePaymaster = paymasterMode === "native"
        ? (p.id === "startale" ? scsPaymasterClient : nativePaymasterClient)
        : scsPaymasterClient;

      const pmContext = paymasterMode === "native"
        ? (p.id === "startale"
            ? { calculateGasLimits: true, paymasterId: activePaymasterId }
            : p.nativePaymasterContext
              ? { ...p.nativePaymasterContext }
              : undefined)
        : paymasterMode === "scs"
          ? { calculateGasLimits: true, paymasterId: activePaymasterId }
          : undefined;

      // Pimlico bundler requires a transport adapter (see pimlicoBundlerTransport above)
      const bundlerTransport = p.id === "pimlico"
        ? pimlicoBundlerTransport(p.url)
        : http(p.url);

      const runClient = createSmartAccountClient({
        account,
        transport: bundlerTransport,
        client: publicClient,
        ...(activePaymaster && pmContext
          ? { paymaster: activePaymaster, paymasterContext: pmContext }
          : {}),
      });

      try {
        const hash = await runClient.sendUserOperation({
          calls: [{ to: (COUNTER ?? signer.address) as Address, value: 0n, data: callData }],
        });
        const tAccepted = performance.now();
        const acceptMs  = Math.round(tAccepted - t0);
        process.stdout.write(chalk.green(`✓ accepted (${acceptMs}ms)\n`));
        console.log(`      userOpHash : ${chalk.dim(hash)}`);
        process.stdout.write("      ");

        const receipt    = await runClient.waitForUserOperationReceipt({ hash, timeout: 20_000, pollingInterval: 1_000 });
        const tDone      = performance.now();
        const inclusionMs = Math.round(tDone - tAccepted);

        sdkResults[p.id].push({
          ok:           true,
          acceptMs,
          inclusionMs,
          totalMs:      Math.round(tDone - t0),
          gasUsed:      receipt.actualGasUsed,
          gasCostWei:   receipt.actualGasCost,
          userOpHash:   hash,
          txHash:       receipt.receipt.transactionHash,
        });

        console.log(chalk.green(`✓ included (${inclusionMs}ms)  fee=${formatEther(receipt.actualGasCost)} ETH`));
        console.log(`      txHash     : ${chalk.dim(receipt.receipt.transactionHash)}`);

      } catch (e: unknown) {
        const ms  = Math.round(performance.now() - t0);
        const msg = e instanceof Error ? e.message : String(e);

        if (paymasterMode === "scs" && msg.toLowerCase().includes("paymaster") && activePaymasterId !== PAYMASTER_ID_FALLBACK) {
          console.log(chalk.yellow(`  ⚠ pm_id=${activePaymasterId} rejected — retrying with ${PAYMASTER_ID_FALLBACK}`));
          activePaymasterId = PAYMASTER_ID_FALLBACK;
          i--;
          continue;
        }

        sdkResults[p.id].push({ ok: false, totalMs: ms, error: msg.slice(0, 120) });
        console.log(chalk.red(`✗ failed (${ms}ms)  ${msg.slice(0, 300)}`));
      }
    }
  }

  // SDK Summary
  section("SECTION B · Summary");
  const COL = 24, PCOL = 16;
  const METRICS = [
    { key: "acceptMs",    label: "Acceptance latency" },
    { key: "inclusionMs", label: "Inclusion latency" },
    { key: "totalMs",     label: "Total e2e latency" },
  ];
  console.log(`\n  ${"".padEnd(COL)} ${PROVIDERS.map(p => pc(p.id, p.name.padEnd(PCOL))).join("")}`);
  console.log(`  ${"─".repeat(COL)} ${PROVIDERS.map(() => "─".repeat(PCOL)).join("")}`);

  for (const m of METRICS) {
    process.stdout.write(`  ${m.label.padEnd(COL)} `);
    PROVIDERS.forEach((p) => {
      const runs = sdkResults[p.id] ?? [];
      const vals = runs.filter(r => r.ok && r[m.key as keyof SdkRun] != null)
                       .map(r => r[m.key as keyof SdkRun] as number);
      if (vals.length === 0) { process.stdout.write(chalk.dim("n/a".padEnd(PCOL))); return; }
      const med = [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
      process.stdout.write(pc(p.id, `${med}ms (med)`.padEnd(PCOL)));
    });
    process.stdout.write("\n");
  }

  // Fee row
  process.stdout.write(`  ${"Fee paid (median)".padEnd(COL)} `);
  PROVIDERS.forEach((p) => {
    const runs = sdkResults[p.id] ?? [];
    const fees = runs.filter(r => r.ok && r.gasCostWei != null).map(r => r.gasCostWei!);
    if (fees.length === 0) { process.stdout.write(chalk.dim("n/a".padEnd(PCOL))); return; }
    const sorted = [...fees].sort((a, b) => Number(a - b));
    const med = sorted[Math.floor(sorted.length / 2)];
    process.stdout.write(pc(p.id, `${formatEther(med)} ETH`.padEnd(PCOL)));
  });
  process.stdout.write("\n");

  // Success rate row
  process.stdout.write(`  ${"Success rate".padEnd(COL)} `);
  PROVIDERS.forEach((p) => {
    const runs = sdkResults[p.id] ?? [];
    const rate = runs.length === 0 ? "—" : `${runs.filter(r => r.ok).length}/${runs.length}`;
    process.stdout.write(pc(p.id, rate.padEnd(PCOL)));
  });
  process.stdout.write("\n");

  // Full hash listing per provider
  section("SECTION B · Transaction Hashes");
  for (const p of PROVIDERS) {
    const runs = sdkResults[p.id] ?? [];
    const ok   = runs.filter(r => r.ok);
    console.log(`\n  ${pc(p.id, chalk.bold(p.name))}  ${ok.length}/${runs.length} successful`);
    if (ok.length === 0) {
      const first = runs[0];
      console.log(chalk.red(`    ✗ ${first?.error ?? "all runs failed"}`));
      continue;
    }
    ok.forEach((run, idx) => {
      console.log(`    run ${idx + 1}`);
      console.log(`      userOpHash : ${chalk.cyan(run.userOpHash ?? "n/a")}`);
      console.log(`      txHash     : ${chalk.cyan(run.txHash ?? "n/a")}`);
      console.log(`      fee        : ${formatEther(run.gasCostWei ?? 0n)} ETH  |  accept=${run.acceptMs}ms  inclusion=${run.inclusionMs}ms`);
    });
  }

  return sdkResults;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
${chalk.bold("╔══════════════════════════════════════════════════════════════════════╗")}
${chalk.bold("║  AA Provider Benchmark  ·  Soneium Mainnet (chain 1868)              ║")}
${chalk.bold("╚══════════════════════════════════════════════════════════════════════╝")}

  Providers  : ${PROVIDERS.map(p => pc(p.id, p.name)).join("  ·  ")}
  Raw runs   : ${N_RUNS} per test
  SDK runs   : ${SDK_RUNS} real txns per provider
  EntryPoint : v0.7  (${chalk.dim(EP_V07)})
`);

  if (PROVIDERS.length === 0) {
    console.log(chalk.red("  No providers configured."));
    process.exit(1);
  }

  const rawResults = SKIP_RAW ? null : await runRawBenchmark();
  const sdkResults = SKIP_SDK ? null : await runSdkBenchmark();

  if (JSON_OUT) {
    console.log("\n--- JSON ---");
    console.log(JSON.stringify({ raw: rawResults, sdk: sdkResults }, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v, 2));
  }

  console.log(`\n${chalk.dim("  Done.\n")}`);
}

main().catch(e => { console.error(chalk.red("\nFatal: " + (e as Error).message)); process.exit(1); });
