/**
 * Demo catalog: scans `src/<network>/**` for runnable scripts and derives,
 * for each one, the network it targets, a human title, a one-line
 * description and the `process.env.*` variables it reads.
 *
 * Everything is derived statically from the source files, so the catalog
 * can never drift from the code. Used by:
 *   - tools/run.ts     (interactive runner, `npm start`)
 *   - tools/doctor.ts  (env pre-flight, `npm run doctor`)
 *   - tools/readme.ts  (README table, `npm run catalog`)
 *
 * Usage: npx ts-node tools/catalog.ts [--json]
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const ROOT = path.resolve(__dirname, "..");
export const SRC_DIR = path.join(ROOT, "src");
export const ENV_FILE = path.join(ROOT, ".env");
export const ENV_TEMPLATE = path.join(ROOT, ".env_template");

/** Directories under src/ that are libraries or scratch space, not demos. */
const NON_DEMO_DIRS = new Set(["abi", "types"]);

export interface NetworkInfo {
  /** Directory name under src/. */
  dir: string;
  /** Display name. */
  label: string;
  /** Mainnet demos move real funds. */
  mainnet: boolean;
  chainId?: number;
}

export const NETWORKS: Record<string, NetworkInfo> = {
  "startale-minato": {
    dir: "startale-minato",
    label: "Soneium Minato (testnet)",
    mainnet: false,
    chainId: 1946,
  },
  "soneium-mainnet": {
    dir: "soneium-mainnet",
    label: "Soneium Mainnet",
    mainnet: true,
    chainId: 1868,
  },
  "optimism-sepolia": {
    dir: "optimism-sepolia",
    label: "OP Sepolia (testnet)",
    mainnet: false,
    chainId: 11155420,
  },
  "optimism-mainnet": { dir: "optimism-mainnet", label: "OP Mainnet", mainnet: true, chainId: 10 },
  temp: { dir: "temp", label: "Scratch / work in progress", mainnet: false },
};

export interface Demo {
  /** Path relative to repo root, e.g. src/startale-minato/demo_basic_userop.ts */
  file: string;
  /** Short id used on the command line, e.g. startale-minato/demo_basic_userop */
  id: string;
  network: NetworkInfo;
  title: string;
  description: string;
  /** Sorted, de-duplicated env var names read via process.env. */
  env: string[];
  /** Scripts flagged as WIP/experimental in their own header. */
  wip: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** All `process.env.X`, `process.env["X"]` and `process.env['X']` reads in a file. */
export function extractEnvVars(source: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) names.add(m[1]);
  }
  return [...names].sort();
}

/** First comment block at the top of the file, flattened to one line. */
function leadingComment(source: string): string | undefined {
  const head = source.slice(0, 2000).trimStart();
  const block = head.match(/^\/\*\*?([\s\S]*?)\*\//);
  if (block) {
    // First paragraph only: stop at the first blank line inside the block.
    const lines: string[] = [];
    for (const raw of block[1].split("\n")) {
      const l = raw.replace(/^\s*\*\s?/, "").trim();
      if (!l) {
        if (lines.length) break;
        continue;
      }
      if (l.startsWith("@") || /^[─\-=]{3,}$/.test(l)) continue;
      lines.push(l);
      if (lines.length === 2) break;
    }
    return lines.length ? lines.join(" ") : undefined;
  }
  const lines: string[] = [];
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("//")) break;
    const text = line
      .replace(/^\/\/\s?/, "")
      .replace(/^[─\-=]+$/, "")
      .trim();
    if (text && text.split(/\s+/).length > 1) lines.push(text);
  }
  return lines.length ? lines.join(" ") : undefined;
}

const HINTS: Array<[RegExp, string]> = [
  [/benchmark/, "Latency and cost benchmark across bundler providers"],
  [/prefetch/, "Measures how much pre-fetching nonce/gas data cuts userOp latency"],
  [/stress/, "Fires many userOps to stress the bundler and paymaster"],
  [/parallel/, "Sends several userOps in parallel from one account"],
  [
    /sess?i?on.*crosschain|crosschain.*sess?i?on/,
    "Smart Session key executing a cross-chain transfer",
  ],
  [/crosschain/, "Cross-chain transfer from a smart account"],
  [/session.*erc20.*scoped/, "Smart Session key limited to a scoped ERC-20 transfer"],
  [/session_key_use/, "Creates a Smart Session key and executes a userOp with it"],
  [/sess?i?on/, "Smart Sessions (session keys) demo"],
  [/recovery.*addowner/i, "Account recovery module: add a new owner"],
  [/recovery.*swapowner/i, "Account recovery module: swap the owner"],
  [/recovery/, "Account recovery module demo"],
  [/install_modules/, "Installs validator/executor modules on a smart account"],
  [/7702.*self_auth/, "EIP-7702 delegation with self-signed authorization, no SDK"],
  [/7702.*without_sdk/, "EIP-7702 delegation built by hand, without the SDK"],
  [
    /7702_sdk/,
    "EIP-7702 via the SDK helper (getEip7702Authorization): EOA becomes a Startale smart account",
  ],
  [/7702/, "EIP-7702: EOA signs the delegation itself, then sends a sponsored userOp"],
  [/erc20_pay/, "Pays userOp gas in an ERC-20 token via the token paymaster"],
  [/basic_userop_without_pm/, "Basic userOp paid from the account itself, no paymaster"],
  [/basic_userop/, "Basic sponsored userOp (counter increment) via the SCS paymaster"],
];

function describe(file: string, source: string): string {
  const fromHeader = leadingComment(source);
  if (fromHeader && fromHeader.length > 12 && !/^wip$/i.test(fromHeader)) {
    return fromHeader.length > 140 ? `${fromHeader.slice(0, 137)}...` : fromHeader;
  }
  const name = path.basename(file, ".ts").toLowerCase();
  for (const [re, text] of HINTS) if (re.test(name)) return text;
  return humanize(name);
}

export function humanize(name: string): string {
  return name
    .replace(/^demo_/, "")
    .replace(/\.ts$/, "")
    .split(/[_\-]+/)
    .filter(Boolean)
    .map((w) => {
      const upper: Record<string, string> = {
        userop: "userOp",
        userops: "userOps",
        erc20: "ERC-20",
        usdc: "USDC",
        sdk: "SDK",
        pm: "paymaster",
        aa: "AA",
        7702: "7702",
      };
      return upper[w] ?? w;
    })
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}

export function loadCatalog(): Demo[] {
  if (!fs.existsSync(SRC_DIR)) return [];
  const demos: Demo[] = [];
  for (const abs of walk(SRC_DIR)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    const parts = rel.split("/");
    if (parts.length < 3) continue; // src/<network>/<file>
    const netDir = parts[1];
    if (NON_DEMO_DIRS.has(netDir)) continue;
    const source = fs.readFileSync(abs, "utf8");
    const network = NETWORKS[netDir] ?? { dir: netDir, label: netDir, mainnet: false };
    const id = rel.replace(/^src\//, "").replace(/\.ts$/, "");
    demos.push({
      file: rel,
      id,
      network,
      title: humanize(path.basename(abs)),
      description: describe(abs, source),
      env: extractEnvVars(source),
      wip: /^\s*\/\/\s*WIP/im.test(source.slice(0, 300)) || netDir === "temp",
    });
  }
  const order = Object.keys(NETWORKS);
  return demos.sort((a, b) => {
    const na = order.indexOf(a.network.dir);
    const nb = order.indexOf(b.network.dir);
    if (na !== nb) return (na === -1 ? 99 : na) - (nb === -1 ? 99 : nb);
    return a.id.localeCompare(b.id);
  });
}

/** Parse KEY=value lines of a dotenv-style file; values are not needed, only presence. */
export function readEnvKeys(file: string): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  if (!fs.existsSync(file)) return keys;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    keys.set(m[1], value.length > 0);
  }
  return keys;
}

/** Every env var referenced by at least one demo, with the demos that use it. */
export function envUsage(demos: Demo[]): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const d of demos) for (const v of d.env) usage.set(v, [...(usage.get(v) ?? []), d.id]);
  return new Map([...usage.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

if (require.main === module) {
  const demos = loadCatalog();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(demos, null, 2));
  } else {
    for (const d of demos)
      console.log(`${d.id.padEnd(60)} ${d.env.length} env vars  ${d.description}`);
    console.log(
      `\n${demos.length} demos across ${new Set(demos.map((d) => d.network.dir)).size} networks`,
    );
  }
}
