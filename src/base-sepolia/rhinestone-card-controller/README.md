# Base Sepolia — Rhinestone Card Controller Demo

End-to-end card account flow on Base Sepolia using:
- **User AA**: Startale smart account (`@startale-scs/aa-sdk`, no paymaster)
- **Card account controller**: Rhinestone Nexus account (`type: "startale"`, Rhinestone-sponsored)

## Required env vars

```
OWNER_PRIVATE_KEY=
CONTROLLER_VALIDATOR_ADDRESS=        # ECDSA validator module installed on the controller account
RHINESTONE_API_KEY=
BASE_SEPOLIA_BUNDLER_URL=            # Alchemy / Pimlico Base Sepolia bundler endpoint
BASE_SEPOLIA_CARD_ACCOUNT_FACTORY_ADDRESS=
BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS=   # set after running activate script
REFUND_ACTOR_PRIVATE_KEY=            # EOA that receives settlements and refunds USDSC back (demo_refund_from_treasury.ts)
```

USDSC on Base Sepolia: `0x610e208ef737a7918202B4CDD554B0D89d5cEA01` (hardcoded in scripts)

---

## Scripts — run order

### 1. `demo_deploy_nexus_with_controller_validator.ts`

Deploys the **card account controller** — a Rhinestone Nexus account (`type: "startale"`) with the `CONTROLLER_VALIDATOR_ADDRESS` ECDSA validator installed. This account is the on-chain authority that can call `topUpToTarget` and `settleCardBalance` on card accounts.

Deployment is Rhinestone-sponsored (`deploy(chain, { sponsored: true })`). Idempotent — exits early if already deployed.

Print the address and set it as `BASE_SEPOLIA_CARD_ACCOUNT_CONTROLLER` for reference.

```bash
npx ts-node src/base-sepolia/rhinestone-card-controller/demo_deploy_nexus_with_controller_validator.ts
```

---

### 2. `demo_controller_send_test.ts`

Smoke-tests the controller account by sending a no-op (self-call, 0 ETH) via both execution paths:

1. `sendUserOperation` — direct ERC-4337 bundler path
2. `sendTransaction` — Rhinestone intent orchestrator path (sponsored)

Run this after deployment to confirm both paths work on Base Sepolia before proceeding.

```bash
npx ts-node src/base-sepolia/rhinestone-card-controller/demo_controller_send_test.ts
```

---

### 3. `demo_startale_user_aa_noop.ts`

Deploys the **user AA account** (Startale smart account, no paymaster) by sending a no-op UserOperation to itself. If the account is counterfactual, this UserOp includes deployment automatically.

Requires the user AA to be funded with Base Sepolia ETH for gas before running.

```bash
npx ts-node src/base-sepolia/rhinestone-card-controller/demo_startale_user_aa_noop.ts
```

---

### 4. `demo_startale_activate_card_account.ts`

Activates the card account for the user AA:

1. Simulates `makeNewCardAccount(userAccount, salt)` on the factory to predict the card account address
2. Checks idempotency (skips steps already done)
3. Calls `makeNewCardAccount` to deploy the card account clone
4. Calls `USDSC.approve(cardAccountAddress, maxUint256)` so the card account can pull tokens later

Both steps are batched into a single UserOperation. Idempotent — re-running skips already-completed steps.

After running, set `BASE_SEPOLIA_CARD_ACCOUNT_ADDRESS` in `.env` to the printed card account address.

```bash
npx ts-node src/base-sepolia/rhinestone-card-controller/demo_startale_activate_card_account.ts
```

---

### 5. `demo_deposit_from_user_account.ts`

The **controller account** calls `topUpToTarget` on the card account, which pulls just enough USDSC from the user AA account (via `transferFrom`) to bring the card account's balance up to a target standing balance — it computes and returns the top-up amount itself, rather than taking a fixed deposit amount.

Target standing balance = `CARD_MAX_BALANCE_USDSC` (max balance the card is allowed to hold) + `CARD_HELD_BALANCE_USDSC` (amount already held, e.g. pending authorizations).

Requires the user AA to hold USDSC and to have approved the card account (done in step 4).

Override via env vars: `CARD_MAX_BALANCE_USDSC` (default: `500`), `CARD_HELD_BALANCE_USDSC` (default: `20`).

```bash
CARD_MAX_BALANCE_USDSC=500 CARD_HELD_BALANCE_USDSC=20 npx ts-node src/base-sepolia/rhinestone-card-controller/demo_deposit_from_user_account.ts
```

---

### 6. `demo_settle_card_balance.ts`

The **controller account** calls `settleCardBalance` on the card account, transferring USDSC from the card account to a settlement recipient (simulating a merchant payout).

Override via env vars: `SETTLE_AMOUNT_USDSC` (default: `10`), `SETTLE_RECIPIENT`, `SETTLEMENT_UID` (auto-derived if not set).

```bash
SETTLE_AMOUNT_USDSC=10 npx ts-node src/base-sepolia/rhinestone-card-controller/demo_settle_card_balance.ts
```

---

### 7. `demo_withdraw_to_user_account.ts`

The **user AA account** calls `withdrawToUserAccount` on the card account, pulling USDSC back from the card account to the user AA. This requires an EIP-712 `Withdraw` signature from the controller (co-authorization).

Flow:
1. Signs an EIP-712 `Withdraw` message as the controller EOA
2. Prefixes the signature with `CONTROLLER_VALIDATOR_ADDRESS` for Nexus EIP-1271 routing
3. Batches `withdrawToUserAccount` + `USDSC.transfer` to a recipient in one UserOperation

Override via env vars: `WITHDRAW_AMOUNT_USDSC` (default: `100`), `WITHDRAW_NONCE` (must be unique per withdrawal — bump after each run).

```bash
WITHDRAW_NONCE=12345678 npx ts-node src/base-sepolia/rhinestone-card-controller/demo_withdraw_to_user_account.ts
```

---

### 8. `demo_refund_from_treasury.ts`

The **treasury/settlement EOA** (`REFUND_ACTOR_PRIVATE_KEY`, a plain key — no smart account) refunds USDSC back into the card account by calling `depositForRefund`, simulating money flowing back after a settlement (e.g. a merchant refund).

Flow:
1. Checks USDSC allowance from the treasury EOA to the card account; if insufficient, sends a one-time infinite `approve` (only needs to happen once per EOA)
2. Calls `depositForRefund` directly as a plain transaction (`transferFrom` pulls the USDSC from the treasury EOA)

No special caller gating — any address holding USDSC + allowance can call `depositForRefund`. Warns if `REFUND_ACTOR_PRIVATE_KEY` doesn't resolve to `SETTLE_RECIPIENT`, since this is meant to be the same actor that received the settlement payout in step 6.

Override via env vars: `REFUND_AMOUNT_USDSC` (default: `20`).

```bash
REFUND_AMOUNT_USDSC=20 npx ts-node src/base-sepolia/rhinestone-card-controller/demo_refund_from_treasury.ts
```

---

## Architecture summary

```
EOA (OWNER_PRIVATE_KEY)
 ├── controls → Controller Nexus account (type: startale, controllerValidatorAddress)
 │                └── calls topUpToTarget / settleCardBalance on Card Account
 └── controls → User AA account (Startale SDK, index: 0)
                  ├── owns → Card Account (deployed via factory)
                  └── calls withdrawToUserAccount on Card Account (with controller co-sig)

Treasury EOA (REFUND_ACTOR_PRIVATE_KEY, plain key, no smart account)
 └── receives settlements (SETTLE_RECIPIENT) and calls depositForRefund on Card Account

Card Account
 ├── CARD_ACCOUNT_CONTROLLER = Controller Nexus account address
 └── userAccount             = User AA account address
```

---

## Run order (full flow)

1. `demo_deploy_nexus_with_controller_validator.ts` — deploy controller Nexus account
2. `demo_controller_send_test.ts` — smoke-test controller execution paths
3. `demo_startale_user_aa_noop.ts` — deploy user AA account
4. `demo_startale_activate_card_account.ts` — activate card account + USDSC approval
5. `demo_deposit_from_user_account.ts` — top up card account to target standing balance
6. `demo_settle_card_balance.ts` — settle card balance to recipient
7. `demo_withdraw_to_user_account.ts` — withdraw remaining balance to user AA
8. `demo_refund_from_treasury.ts` — treasury refunds USDSC back into card account
