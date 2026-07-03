# Sepolia Card Account Demos

End-to-end demos of the ERC-7579 card account system on Sepolia. Two flows are covered depending on which smart account acts as the **card controller** — the account that can deposit from and settle balances on a user's card account.

Both flows share the same card account factory and USDSC token. The difference is the validator module used on the controller account and the SDK used to send UserOps.

---

## Prerequisites

All scripts require a funded EOA (`OWNER_PRIVATE_KEY`) and the env vars listed in `.env_template`. No paymaster is used — fund the relevant smart account counterfactual address with Sepolia ETH before running.

---

## Flow 1 — Startale AA as Card Controller

Uses the **Startale AA SDK** and **Startale bundler**. The card controller is a Startale smart account at index 0, the user account is at index 1.

```
src/sepolia/startale-card-controller/
```

### Run order

**Step 1 — Basic UserOp (smoke test)**
```bash
npx ts-node src/sepolia/startale-card-controller/demo_basic_userop.ts
```
Verifies the Startale AA is set up and can send a simple UserOp. No card account logic.

---

**Step 2 — Install ControllerValidator**
```bash
npx ts-node src/sepolia/startale-card-controller/demo_install_controller_validator.ts
```
Installs the ControllerValidator module on the Startale AA (index 0). Required before the card account can call ERC-1271 on the controller for signature verification.

---

**Step 3 — Activate card account** _(deploy + approve in one UserOp)_
```bash
npx ts-node src/sepolia/startale-card-controller/demo_activate_card_account.ts
```
Sent from the **user account (index 1)**. Predicts the deterministic card account address, then batches:
1. `CardAccountFactory.makeNewCardAccount(userAccount, salt)` — deploys the clone
2. `USDSC.approve(cardAccount, maxUint256)` — grants the card account permission to pull tokens

Copy the printed `CARD_ACCOUNT_ADDRESS` into `.env`.

> `demo_make_card_account.ts` and `demo_card_account_usdc_approval.ts` are the individual steps if you need to run them separately.

---

**Step 4 — Deposit**
```bash
npx ts-node src/sepolia/startale-card-controller/demo_deposit_from_user_account.ts
# override amount (default 500 USDSC):
DEPOSIT_AMOUNT_USDSC=100 npx ts-node src/sepolia/startale-card-controller/demo_deposit_from_user_account.ts
```
Sent from the **card controller (index 0)**. Calls `depositFromUserAccount(TokenAmount)` on the card account — pulls USDSC from the user account into the card account via the earlier approval.

---

**Step 5 — Settle**
```bash
npx ts-node src/sepolia/startale-card-controller/demo_settle_card_balance.ts
# override amount (default 10 USDSC):
SETTLE_AMOUNT_USDSC=5 npx ts-node src/sepolia/startale-card-controller/demo_settle_card_balance.ts
```
Sent from the **card controller (index 0)**. Calls `settleCardBalance(recipient, TokenAmount, uid)` — transfers USDSC from the card account to the settlement recipient (Startale treasury by default).

---

## Flow 2 — Rhinestone Nexus as Card Controller

Uses the **Rhinestone SDK** and **Pimlico bundler**. The card controller is a Rhinestone Nexus account with **ControllerValidator** installed as its validator module. The user account is still a Startale AA (index 1) that holds USDSC and activates the card account.

The ControllerValidator validates UserOps from the Nexus via `validateUserOp` (standard ECDSA threshold check on the owner EOA). It also exposes `isValidSignatureWithSender` for card accounts to call ERC-1271 on the controller — restricted to addresses created by the card account factory.

```
src/sepolia/rhinestone-card-controller/
```

### Run order

**Step 1 — Deploy Nexus with ControllerValidator**
```bash
npx ts-node src/sepolia/rhinestone-card-controller/demo_deploy_nexus_with_controller_validator.ts
```
Deploys a Rhinestone Nexus account with ControllerValidator set as the validator module (instead of the default OwnableValidator). Uses Pimlico as bundler (whitelists Rhinestone contracts — the Startale bundler rejects the Rhinestone Registry storage access). Prints the Nexus address — this is your card controller.

---

**Step 2 — Smoke test (optional)**
```bash
npx ts-node src/sepolia/rhinestone-card-controller/demo_nexus_send_userop.ts
```
Sends a 0-value self-send UserOp from the Nexus to confirm ControllerValidator's `validateUserOp` is working end-to-end before touching the card account.

---

**Step 3 — Activate card account** _(deploy + approve in one UserOp)_
```bash
npx ts-node src/sepolia/rhinestone-card-controller/demo_nexus_activate_card_account.ts
```
Sent from the **user account (Startale AA, index 3)** — a fresh account not used in Flow 1 to avoid the factory's one-card-account-per-user restriction. Batches `makeNewCardAccount` + `USDSC.approve` in one UserOp. The factory (set to the new impl) stores the Nexus address as the card controller inside the clone.

Copy the printed `NEXUS_CARD_ACCOUNT_ADDRESS` into `.env`.

> Requires the factory to be pointing to the updated card impl that stores the Nexus as controller. Switch back to the original impl to run Flow 1 again.

---

**Step 4 — Deposit**
```bash
npx ts-node src/sepolia/rhinestone-card-controller/demo_nexus_deposit_from_user_account.ts
# override amount (default 500 USDSC):
DEPOSIT_AMOUNT_USDSC=100 npx ts-node src/sepolia/rhinestone-card-controller/demo_nexus_deposit_from_user_account.ts
```
Sent from the **Nexus (card controller)**. Calls `depositFromUserAccount` on the card account via `account.sendUserOperation` — signed through the ControllerValidator.

---

**Step 5 — Settle**
```bash
npx ts-node src/sepolia/rhinestone-card-controller/demo_nexus_settle_card_balance.ts
# override amount (default 10 USDSC):
SETTLE_AMOUNT_USDSC=5 npx ts-node src/sepolia/rhinestone-card-controller/demo_nexus_settle_card_balance.ts
```
Sent from the **Nexus (card controller)**. Calls `settleCardBalance` on the card account via `account.sendUserOperation` — signed through the ControllerValidator.

---

## Utility — Rhinestone ↔ Startale Address Parity Check

```bash
npx ts-node src/sepolia/demo_rhinestone_startale_parity.ts
```

Derives the counterfactual Startale smart account address from both SDKs using the same EOA and confirms they match. Useful for verifying SDK compatibility before running the full flows.

The configs that produce the same address:

| SDK | Config |
|-----|--------|
| Startale SDK | `index: 0n`, `executors: [{ module: INTENT_EXECUTOR, data: '0x' }]` |
| Rhinestone SDK | `account: { type: 'startale' }`, `owners: { type: 'ecdsa', module: K1_DEFAULT_VALIDATOR }` |

> **Note:** Rhinestone SDK's `type: "ecdsa"` owners without an explicit `module` do **not** default to K1 — they use a different validator and produce a different address. Always pass `module: K1_DEFAULT_VALIDATOR` explicitly for parity.

---

## Key env vars

| Variable | Used by |
|---|---|
| `SEPOLIA_BUNDLER_URL` | All Startale AA scripts |
| `PIMLICO_API_KEY` | All Rhinestone scripts |
| `CONTROLLER_VALIDATOR_ADDRESS` | Both flows |
| `CARD_ACCOUNT_FACTORY_ADDRESS` | Both flows |
| `CARD_ACCOUNT_ADDRESS` | Flow 1 deposit/settle |
| `NEXUS_CARD_ACCOUNT_ADDRESS` | Flow 2 deposit/settle |
| `SEPOLIA_USDSC_ADDRESS` | All card account scripts |
