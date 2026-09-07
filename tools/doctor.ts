/**
 * Env doctor: tells you, before you run anything, which demos are ready to
 * run with your current `.env` and exactly which variables each of the
 * others is still missing. Also keeps `.env_template` honest.
 *
 * Usage:
 *   npx ts-node tools/doctor.ts                 # readiness of every demo vs .env
 *   npx ts-node tools/doctor.ts <demo-id>       # one demo, e.g. startale-minato/demo_basic_userop
 *   npx ts-node tools/doctor.ts --template      # .env_template vs what the scripts read (CI-friendly)
 *
 * Exit code is 1 when the selected demo is not runnable, or when
 * `--template` finds drift, so the check can gate CI.
 */
import { type Demo, ENV_FILE, ENV_TEMPLATE, envUsage, loadCatalog, readEnvKeys } from "./catalog";
import { EMPTY, MISSING, OK, bold, cyan, dim, green, red, yellow } from "./ui";

export type VarState = "ok" | "empty" | "missing";

export function envState(present: Map<string, boolean>, name: string): VarState {
  if (!present.has(name)) return process.env[name] ? "ok" : "missing";
  return present.get(name) ? "ok" : "empty";
}

export function checkDemo(demo: Demo, present: Map<string, boolean>) {
  const states = demo.env.map((name) => ({ name, state: envState(present, name) }));
  return { demo, states, ready: states.every((s) => s.state === "ok") };
}

function badge(state: VarState): string {
  return state === "ok" ? OK : state === "empty" ? EMPTY : MISSING;
}

export function printDemoReport(demo: Demo, present: Map<string, boolean>): boolean {
  const { states, ready } = checkDemo(demo, present);
  console.log(`${bold(demo.id)}  ${dim(demo.description)}`);
  if (states.length === 0) console.log(`  ${dim("reads no environment variables")}`);
  for (const s of states) console.log(`  ${badge(s.state).padEnd(20)} ${s.name}`);
  console.log(
    ready ? green("  ready to run") : red("  not runnable yet: fill the variables above in .env"),
  );
  return ready;
}

export function printOverview(demos: Demo[], present: Map<string, boolean>): void {
  let currentNet = "";
  let readyCount = 0;
  for (const demo of demos) {
    if (demo.network.dir !== currentNet) {
      currentNet = demo.network.dir;
      const tag = demo.network.mainnet ? yellow(" [mainnet, real funds]") : "";
      console.log(`\n${bold(cyan(demo.network.label))}${tag}`);
    }
    const { states, ready } = checkDemo(demo, present);
    if (ready) readyCount++;
    const missing = states.filter((s) => s.state !== "ok").map((s) => s.name);
    const status = ready ? OK : `${MISSING} ${dim(missing.join(", "))}`;
    console.log(
      `  ${(ready ? green("ready  ") : red("blocked")).padEnd(18)} ${demo.id.padEnd(58)} ${ready ? "" : status}`,
    );
  }
  console.log(`\n${readyCount}/${demos.length} demos runnable with the current .env`);
  if (!present.size) console.log(dim("(no .env found: copy .env_template to .env and fill it in)"));
}

/** Compare .env_template against what the demos actually read. */
export function templateDrift(demos: Demo[]) {
  const template = readEnvKeys(ENV_TEMPLATE);
  const used = envUsage(demos);
  const missingFromTemplate = [...used.keys()].filter((k) => !template.has(k));
  const unusedInTemplate = [...template.keys()].filter((k) => !used.has(k));
  return { missingFromTemplate, unusedInTemplate, used };
}

function printTemplateReport(demos: Demo[]): boolean {
  const { missingFromTemplate, unusedInTemplate, used } = templateDrift(demos);
  console.log(bold(".env_template vs variables read by the demos\n"));
  if (missingFromTemplate.length) {
    console.log(red("Read by a demo but absent from .env_template:"));
    for (const k of missingFromTemplate)
      console.log(`  ${k.padEnd(45)} ${dim(used.get(k)?.join(", ") ?? "")}`);
  } else {
    console.log(green("Every variable the demos read is present in .env_template."));
  }
  if (unusedInTemplate.length) {
    console.log(
      `\n${yellow("In .env_template but not read by any demo (probably safe to drop):")}`,
    );
    for (const k of unusedInTemplate) console.log(`  ${k}`);
  }
  return missingFromTemplate.length === 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const demos = loadCatalog();
  if (args.includes("--template")) {
    process.exit(printTemplateReport(demos) ? 0 : 1);
  }
  const present = readEnvKeys(ENV_FILE);
  const target = args.find((a) => !a.startsWith("-"));
  if (target) {
    const demo = demos.find(
      (d) => d.id === target || d.file === target || d.id.endsWith(`/${target}`),
    );
    if (!demo) {
      console.error(red(`Unknown demo "${target}". Run "npm run list" to see the ids.`));
      process.exit(2);
    }
    process.exit(printDemoReport(demo, present) ? 0 : 1);
  }
  printOverview(demos, present);
}
