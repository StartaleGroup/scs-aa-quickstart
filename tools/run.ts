/**
 * Interactive demo runner (`npm start`).
 *
 * Pick a network, pick a demo, see the env pre-flight for exactly that
 * script, confirm, run. Mainnet demos ask for an explicit "yes" because
 * they spend real funds.
 *
 * Non-interactive:
 *   npm start -- startale-minato/demo_basic_userop   # run one demo by id
 *   npm start -- demo_basic_userop                    # suffix match is fine when unique
 *   npm start -- --list                               # print the catalog and exit
 *   npm start -- <id> --yes                           # skip the confirmation
 *   npm start -- <id> --force                         # run even if env vars are missing
 */
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { type Demo, ENV_FILE, NETWORKS, loadCatalog, readEnvKeys } from "./catalog";
import { checkDemo, printDemoReport } from "./doctor";
import { bold, cyan, dim, green, red, yellow } from "./ui";

/**
 * Line-buffered prompt. Lines are queued as they arrive so piped input
 * (`printf '1\\n5\\ny\\n' | npm start`) works as well as a TTY, and EOF
 * resolves pending questions with "" instead of hanging.
 */
class Prompt {
  private queue: string[] = [];
  private waiting: Array<(line: string) => void> = [];
  private closed = false;
  readonly rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.queue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiting.splice(0)) w("");
    });
  }

  ask(question: string): Promise<string> {
    process.stdout.write(question);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued.trim());
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => this.waiting.push((line) => resolve(line.trim())));
  }

  close(): void {
    this.rl.close();
  }
}

async function pick<T>(
  prompt: Prompt,
  title: string,
  items: T[],
  render: (item: T) => string,
): Promise<T | undefined> {
  console.log(`\n${bold(title)}`);
  items.forEach((item, i) => console.log(`  ${cyan(String(i + 1).padStart(2))}  ${render(item)}`));
  console.log(`  ${cyan(" q")}  quit`);
  for (;;) {
    const answer = await prompt.ask("\n> ");
    if (answer.toLowerCase() === "q" || answer === "") return undefined;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    console.log(red(`Enter a number between 1 and ${items.length}, or q.`));
  }
}

function findDemo(demos: Demo[], query: string): Demo | undefined {
  const exact = demos.find((d) => d.id === query || d.file === query);
  if (exact) return exact;
  const suffix = demos.filter((d) => d.id.endsWith(`/${query}`) || d.id.endsWith(query));
  if (suffix.length === 1) return suffix[0];
  if (suffix.length > 1) {
    console.error(red(`"${query}" is ambiguous:`));
    for (const d of suffix) console.error(`  ${d.id}`);
  } else {
    console.error(red(`Unknown demo "${query}".`));
  }
  return undefined;
}

function runDemo(demo: Demo): Promise<number> {
  console.log(`\n${dim("$")} npx ts-node ${demo.file}\n`);
  return new Promise((resolve) => {
    const child = spawn("npx", ["ts-node", demo.file], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(red(`failed to start ts-node: ${err.message}`));
      resolve(1);
    });
  });
}

function printList(demos: Demo[]): void {
  let net = "";
  for (const d of demos) {
    if (d.network.dir !== net) {
      net = d.network.dir;
      console.log(
        `\n${bold(cyan(d.network.label))}${d.network.mainnet ? yellow("  [mainnet]") : ""}`,
      );
    }
    console.log(`  ${d.id.padEnd(58)} ${dim(d.description)}`);
  }
  console.log();
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const demos = loadCatalog();
  if (demos.length === 0) {
    console.error(red("No demos found under src/."));
    return 2;
  }
  if (args.includes("--list")) {
    printList(demos);
    return 0;
  }
  const yes = args.includes("--yes") || args.includes("-y");
  const force = args.includes("--force");
  const query = args.find((a) => !a.startsWith("-"));
  const present = readEnvKeys(ENV_FILE);

  let demo: Demo | undefined;
  const prompt = new Prompt();
  try {
    if (query) {
      demo = findDemo(demos, query);
      if (!demo) {
        console.error(dim("Use the full id, or run: npm start -- --list"));
        return 2;
      }
    } else {
      const nets = Object.values(NETWORKS).filter((n) =>
        demos.some((d) => d.network.dir === n.dir),
      );
      const net = await pick(prompt, "Which network?", nets, (n) => {
        const count = demos.filter((d) => d.network.dir === n.dir).length;
        return `${n.label.padEnd(30)} ${dim(`${count} demos`)}${n.mainnet ? yellow("  real funds") : ""}`;
      });
      if (!net) return 0;
      const inNet = demos.filter((d) => d.network.dir === net.dir);
      demo = await pick(prompt, `Which demo on ${net.label}?`, inNet, (d) => {
        const { ready } = checkDemo(d, present);
        const flag = ready ? green("ready  ") : red("blocked");
        return `${flag} ${d.title.padEnd(36)} ${dim(d.description)}`;
      });
      if (!demo) return 0;
    }

    console.log();
    const ready = printDemoReport(demo, present);
    if (!ready && !force) {
      console.log(
        dim("\nFill the missing values in .env (see .env_template) or re-run with --force."),
      );
      return 1;
    }
    if (!yes) {
      const warning = demo.network.mainnet
        ? yellow(" This is a MAINNET script and will spend real funds.")
        : "";
      const answer = await prompt.ask(`\nRun ${bold(demo.id)}?${warning} [y/N] `);
      if (!/^y(es)?$/i.test(answer)) {
        console.log(dim("aborted"));
        return 0;
      }
    }
  } finally {
    prompt.close();
  }
  return runDemo(demo);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(String(err?.stack ?? err)));
    process.exit(1);
  },
);
