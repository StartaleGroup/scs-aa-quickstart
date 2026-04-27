## AA Provider Benchmark — Soneium Mainnet

Benchmarks Pimlico, Alchemy, and Startale SCS bundlers across raw RPC latency and real on-chain transactions.

### Run locally

```bash
# Full run (Section A raw RPC + Section B real txs)
npx ts-node src/soneium-mainnet/benchmark.ts

# Skip raw RPC — only real transactions
npx ts-node src/soneium-mainnet/benchmark.ts --skip-raw

# Skip real txs — only raw RPC latency
npx ts-node src/soneium-mainnet/benchmark.ts --skip-sdk

# Native paymaster mode (uses Pimlico / Alchemy own paymasters)
npx ts-node src/soneium-mainnet/benchmark.ts --skip-raw --paymaster=native
```

### Run via CI (US West — San Jose, CA)

```bash
gh workflow run bundler-benchmark.yml --ref main --field mode=full
```

Or trigger manually from the GitHub Actions tab with mode: `full`, `skip-raw`, `skip-sdk`, or `native-paymaster`.

### Required `.env` vars

```
OWNER_PRIVATE_KEY
MAINNET_BUNDLER_URL
PAYMASTER_SERVICE_URL
PAYMASTER_ID
PIMLICO_API_KEY
ALCHEMY_API_KEY
COUNTER_CONTRACT_ADDRESS
PIMLICO_POLICY_ID       # native paymaster mode only
ALCHEMY_POLICY_ID       # native paymaster mode only
```
