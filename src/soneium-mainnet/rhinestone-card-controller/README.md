# Soneium Mainnet — Rhinestone Card Controller Demo

Minimal end-to-end flow on Soneium mainnet to stand up a card account:
- **User AA**: Startale smart account (`@startale-scs/aa-sdk`, SCS paymaster-sponsored)
- **Card account controller**: Rhinestone Nexus account (`type: "startale"`, Rhinestone-sponsored)

This is a scoped-down version of `src/base-sepolia/rhinestone-card-controller` — deploy the controller, activate one card account for the user AA, then deposit / settle / withdraw. A refund-from-treasury script is not included yet (add it the same way if/when needed, following the base-sepolia version).

**This runs against real mainnet contracts and a real paymaster — no faucet, real funds/gas policy applies.**

## Required env vars

```
OWNER_PRIVATE_KEY=
CONTROLLER_VALIDATOR_ADDRESS=          # ECDSA validator module installed on the controller account (same address across chains)
RHINESTONE_API_KEY=
MAINNET_BUNDLER_URL=                   # Soneium mainnet bundler endpoint
PAYMASTER_SERVICE_URL=                 # Startale SCS paymaster
PAYMASTER_ID=
MAINNET_CARD_ACCOUNT_FACTORY_ADDRESS=
MAINNET_USDSC_ADDRESS=                 # USDSC token address on Soneium mainnet
MAINNET_CARD_ACCOUNT_ADDRESS=          # set after running the activate script

# Deposit (step 5)
CARD_MAX_BALANCE_USDSC=                # default: 1 — max balance the card is allowed to hold
CARD_HELD_BALANCE_USDSC=                # default: 0 — amount already held (e.g. pending authorizations)

# Settle (step 6)
SETTLE_RECIPIENT=                      # required — no hardcoded fallback on mainnet
SETTLE_AMOUNT_USDSC=                    # default: 0.5
SETTLEMENT_UID=                        # optional — auto-derived if unset

# Withdraw (step 7)
WITHDRAW_AMOUNT_USDSC=                  # default: 0.1
WITHDRAW_NONCE=                        # required — must be unique per withdrawal, bump after each run
WITHDRAW_FORWARD_RECIPIENT=            # optional — if unset, withdrawn USDSC just lands in the user AA

# Controller key rotation / extra signer (optional)
CONTROLLER_SIGNER=                     # address or uncompressed pubkey — sole owner of a fresh controller (demo_deploy_controller_for_signer.ts)
DEPLOYER_PRIVATE_KEY=                  # optional gas payer for that deploy, defaults to OWNER_PRIVATE_KEY
NEW_CONTROLLER_SIGNER=                 # address or uncompressed pubkey (0x04...) to add as owner (demo_controller_add_owner.ts)
NEW_CONTROLLER_SIGNER_PRIVATE_KEY=     # key of that signer (*_new_signer.ts scripts)
MAINNET_CARD_ACCOUNT_CONTROLLER=       # deployed controller address (*_new_signer.ts scripts)
```

Unlike base-sepolia, the user AA here is sponsored by the Startale SCS paymaster (`PAYMASTER_SERVICE_URL` / `PAYMASTER_ID`) rather than self-funding gas — matches the pattern already used by the other soneium-mainnet scripts (`demo_install_controller_validator.ts`, `demo_basic_userop.ts`).

---

## Scripts — run order

### 1. `demo_deploy_nexus_with_controller_validator.ts`

Deploys the **card account controller** — a Rhinestone Nexus account (`type: "startale"`) with the `CONTROLLER_VALIDATOR_ADDRESS` ECDSA validator installed. This account is the on-chain authority that can call `topUpToTarget` and `settleCardBalance` on card accounts.

Deployment is Rhinestone-sponsored (`deploy(chain, { sponsored: true })`). Idempotent — exits early if already deployed.

```bash
npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_deploy_nexus_with_controller_validator.ts
```

---

### 2. `demo_controller_send_test.ts`

Smoke-tests the controller account by sending a no-op (self-call, 0 ETH) via both execution paths:

1. `sendUserOperation` — direct ERC-4337 bundler path
2. `sendTransaction` — Rhinestone intent orchestrator path (sponsored)

Run this after deployment to confirm both paths work on Soneium mainnet before proceeding.

```bash
npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_controller_send_test.ts
```

---

### 3. `demo_startale_user_aa_noop.ts`

Deploys the **user AA account** (Startale smart account, SCS paymaster-sponsored) by sending a no-op UserOperation to itself. If the account is counterfactual, this UserOp includes deployment automatically.

```bash
npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_startale_user_aa_noop.ts
```

---

### 4. `demo_startale_activate_card_account.ts`

Activates the card account for the user AA:

1. Simulates `makeNewCardAccount(userAccount, salt)` on the factory to predict the card account address
2. Checks idempotency (skips steps already done)
3. Calls `makeNewCardAccount` to deploy the card account clone
4. Calls `USDSC.approve(cardAccountAddress, maxUint256)` so the card account can pull tokens later

Both steps are batched into a single UserOperation. Idempotent — re-running skips already-completed steps.

After running, set `MAINNET_CARD_ACCOUNT_ADDRESS` in `.env` to the printed card account address.

```bash
npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_startale_activate_card_account.ts
```

---

### 5. `demo_deposit_from_user_account.ts`

The **controller account** calls `topUpToTarget` on the card account, which pulls just enough USDSC from the user AA account (via `transferFrom`) to bring the card account's balance up to a target standing balance.

Target standing balance = `CARD_MAX_BALANCE_USDSC` (default: `1`) + `CARD_HELD_BALANCE_USDSC` (default: `0`). Defaults are small on purpose — this pulls real mainnet USDSC. Requires the user AA to hold USDSC (e.g. the 1-2 USDSC you send it) and to have approved the card account (done in step 4).

```bash
npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_deposit_from_user_account.ts
```

---

### 6. `demo_settle_card_balance.ts`

The **controller account** calls `settleCardBalance` on the card account, transferring USDSC from the card account to a settlement recipient (simulating a merchant payout).

`SETTLE_RECIPIENT` is required — there's no hardcoded fallback address like base-sepolia, since this moves real USDSC.

```bash
SETTLE_RECIPIENT=0xYourRecipient SETTLE_AMOUNT_USDSC=0.5 npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_settle_card_balance.ts
```

---

### 7. `demo_withdraw_to_user_account.ts`

The **user AA account** calls `withdrawToUserAccount` on the card account, pulling USDSC back from the card account to the user AA. This requires an EIP-712 `Withdraw` signature from the controller (co-authorization). Sent via `sendUserOperation`, SCS paymaster-sponsored.

`WITHDRAW_NONCE` is required (no default) — must be unique per withdrawal, bump it each run. By default the withdrawn USDSC just lands in the user AA; set `WITHDRAW_FORWARD_RECIPIENT` if you also want it forwarded onward in the same UserOperation.

```bash
WITHDRAW_NONCE=1 WITHDRAW_AMOUNT_USDSC=0.1 npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_withdraw_to_user_account.ts
```

---

## Controller signer management (optional)

The ControllerValidator keeps a per-account owner set with a threshold (`addOwner`, `removeOwner`, `setThreshold`). All are `msg.sender`-scoped, so the controller account calls them on the validator itself. This allows adding an extra signer (e.g. a KMS key, or a staging key) or rotating the key (add new → verify → `removeOwner` old).

### `demo_controller_add_owner.ts`

Signs with the current `OWNER_PRIVATE_KEY` and calls `addOwner(NEW_CONTROLLER_SIGNER)` on the ControllerValidator via `sendTransaction` (sponsored). Prints owners/threshold before and after. Idempotent — skips if the signer is already an owner. **Check the printed controller address matches the deployed mainnet controller before it sends.**

```bash
NEW_CONTROLLER_SIGNER=0x... npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_controller_add_owner.ts
```

### `demo_controller_remove_owner.ts`

Signs with `OWNER_PRIVATE_KEY` and calls `removeOwner(prevOwner, owner)` for each address in `OWNERS_TO_REMOVE` (comma-separated), batched in one `sendTransaction` (sponsored). `prevOwner` is derived from `getOwners` order (sentinel `0x…01` for the first entry). Aborts if a target isn't an owner, if the signer isn't an owner, or if the removal would drop below the threshold. Warns if you remove the signing key itself.

```bash
OWNERS_TO_REMOVE=0xOldOwner1,0xOldOwner2 npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_controller_remove_owner.ts
```

### `demo_controller_send_test_new_signer.ts` / `demo_deposit_from_user_account_new_signer.ts`

Same as scripts 2 and 5, but signed by `NEW_CONTROLLER_SIGNER_PRIVATE_KEY`. Rhinestone derives the account address from the owner set, so these pin the account with `initData: { address: MAINNET_CARD_ACCOUNT_CONTROLLER }` — otherwise the SDK would compute a different, undeployed address. The deposit keeps the small mainnet defaults (`CARD_MAX_BALANCE_USDSC=1`, `CARD_HELD_BALANCE_USDSC=0`).

```bash
npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_controller_send_test_new_signer.ts
npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_deposit_from_user_account_new_signer.ts
```

### `demo_deploy_controller_for_signer.ts`

Deploys a **fresh** controller account whose only owner is `CONTROLLER_SIGNER` — for a signer whose key you don't hold (e.g. KMS). Unlike the `*_new_signer.ts` scripts, the resulting account is the one that signer derives naturally, so code using it needs no `initData.address` override.

- The address only depends on the owner **address**, so the SDK is given an address-only stub account (signing throws)
- Both SDK deploy paths need an owner signature, so instead a plain tx to the (permissionless) Startale factory's `createAccount(initData, salt)` is sent from `DEPLOYER_PRIVATE_KEY` (defaults to `OWNER_PRIVATE_KEY`) — the deployer only pays gas and gets no rights over the account
- Simulates the factory call first and aborts unless it returns the SDK-derived address; prints owners/threshold after. Idempotent

The deployer EOA needs native ETH for gas. A new controller is a new address — existing card accounts still point at the old `CARD_ACCOUNT_CONTROLLER`.

```bash
CONTROLLER_SIGNER=0xKmsSignerAddress npx ts-node src/soneium-mainnet/rhinestone-card-controller/demo_deploy_controller_for_signer.ts
```

---

## Architecture summary

```
EOA (OWNER_PRIVATE_KEY)
 ├── controls → Controller Nexus account (type: startale, controllerValidatorAddress)
 │                └── calls topUpToTarget / settleCardBalance on Card Account
 └── controls → User AA account (Startale SDK, index: 100n, SCS paymaster)
                  ├── owns → Card Account (deployed via factory)
                  └── calls withdrawToUserAccount on Card Account (with controller co-sig)
```

---

## Run order (full flow)

1. `demo_deploy_nexus_with_controller_validator.ts` — deploy controller Nexus account
2. `demo_controller_send_test.ts` — smoke-test controller execution paths
3. `demo_startale_user_aa_noop.ts` — deploy user AA account
4. `demo_startale_activate_card_account.ts` — activate card account + USDSC approval
5. Send 1-2 USDSC to the user AA address (external transfer, outside these scripts)
6. `demo_deposit_from_user_account.ts` — top up card account to target standing balance
7. `demo_settle_card_balance.ts` — settle card balance to recipient
8. `demo_withdraw_to_user_account.ts` — withdraw remaining balance to user AA
