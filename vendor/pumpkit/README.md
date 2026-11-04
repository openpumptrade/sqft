# pumpkit

The Solana / pump.fun pieces every launch of ours reuses, pulled out of the engines that run them in
production (BLAST, ETF, TUNGBANK, PUMPDRAW, THE KITCHEN, LABRAT…) into plain, componentized functions.

Plain ESM JavaScript, no build step. Every tool takes a `ctx` first and plain values after. Nothing reads
`process.env` except `createContext()` defaults — that is what made the per-project copies hard to lift out.

```js
import { createContext, keypairFromSecret, claimCreatorFees, buyMeasured, burnDelta } from "pumpkit";

const ctx = createContext({ rpcUrl: process.env.RPC_URL, slippagePct: 5 });
const wallet = keypairFromSecret(process.env.PRIVATE_KEY);

const { claimedRaw } = await claimCreatorFees(ctx, { wallet });                       // creator fees → wallet
const buy = await buyMeasured(ctx, { wallet, mint, lamports: claimedRaw });            // curve / PumpSwap / Jupiter
await burnDelta(ctx, { wallet, mint, balanceBeforeRaw: buy.balanceBeforeRaw });        // burn ONLY what the buy brought in
```

## Install

```bash
npm i github:ciberneticatradingdev/pumpkit        # as a dependency
# or copy src/ into backend/ — it is meant to be read and forked
cp .env.example .env                               # RPC_URL, PRIVATE_KEY (CLI only)
npm run smoke                                      # read-only checks against mainnet, no keys
```

## Modules

| module | what it holds |
|---|---|
| `context` | `createContext({rpcUrl, snapshotRpcUrl, priorityMicroLamports, slippagePct})`, SDK singletons (CJS-loaded — the pump SDKs' ESM builds break on Node), constants, `chunk/sleep/pk/lamportsOf` |
| `tx` | `sendTx` (v0 + priority fee + simulate + confirm, retries BlockhashNotFound), `simulate` (free, no keys), `compileUnsigned` (for user wallets), `relaySigned` (forward someone else's signed bytes), `fetchTransaction`, `balanceDelta`, `withRetry` |
| `wallet` | `keypairFromSecret` (bs58 or JSON), `newWallet`, `getSolBalance`, `sendSol`, `sweepSol`, `encryptSecret/decryptSecret` (AES-256-GCM), `assertMasterKey` |
| `token` | `mintProgramId` (Token-2022 vs SPL — never assume), `ataOf`, `tokenBalanceRaw`, `tokenBalanceSettled`, `tokenAccounts` (all accounts, not just the ATA), `totalSupply`, `readMetadata`, `mintInfo`, `auditMint` |
| `transfer` | `transferTokens` (exact), `transferAllTokens`, `batchTransferTokens`, `transferInstructions` (hook-aware), `closeEmptyAta`, `existingAtas` |
| `burn` | `burnTokens` (exact), `burnDelta` — there is **no burnAll** (see gotchas) |
| `jupiter` | `jupiterQuote`, `jupiterSwap`, `swapSolFor`, `swapForSol`, `hasRoute`, `roundTripPct`, `getUsdPrice`, `getSolUsd`, `jupiterTokenMeta` — on `lite-api.jup.ag` (v6 is dead) |
| `swap` | `buyAny` / `sellAny` (curve → PumpSwap → Jupiter routing), `buyMeasured` (reads balances before/after so the caller knows exactly what was spent and bought) |
| `holders` | `snapshotHolders` (getProgramAccounts, balances summed per owner, system accounts excluded, real wallets only), `topHolders` (no gPA), `filterWallets`, `proRata`, `heldOrGrew`, `systemExclusions` |
| `airdrop` | `airdropTokens` (ATA-rent policy, hook-aware, concurrent batches, per-wallet outcomes), `airdropSol` (rent-exempt skip), `nextSkipStreaks` |
| `engine` | `createScheduler` (global clock), `advisoryLock` (Postgres, keep-alive), `collectFees`, `buybackBurnRound`, `claimBuyAirdropRound` |
| `pumpfun/curve` | `pumpGlobals`, `taxConfig`, `SOL_QUOTE`, `resolveQuote`, `fetchQuoteCatalog`, `loadCurve`, `isGraduated`, `estimateCurveBuy`, `curveBuy/curveSell`, `buildCurveBuy/buildCurveSell` (unsigned) |
| `pumpfun/pumpswap` | `pumpswapBuy/pumpswapSell`, `buildPumpswapBuy/Sell`, `poolOf` |
| `pumpfun/fees` | `creatorVaultBalances`, `claimInstructions`, `claimCreatorFees`; fee sharing: `feeSharingInstructions`, `writeFeeSharing`, `readSharingConfig`, `sharedFeesWaiting`, `distributeSharedFees` (permissionless) |
| `pumpfun/create` | `uploadIpfs`, `buildCreate` (SOL or custom pair, tax), `simulateCreate`, `createCoin` (custodial + dev buy → user), `buildLaunchTxs` (trustless, unsigned), `staticLaunchAccounts` (ALT contents) |
| `pumpfun/market` | `fetchCoinInfo` (DexScreener fallback — pump.fun's `/coins/<mint>` is gone), `fetchMarkets`, `searchTokens`, `fetchCandles`, `fetchTrades`, `fetchTopHoldersList` |
| `pumpfun/verify` | `verifyLaunch` — browser-side check of the launch bytes BEFORE the wallet signs (pure web3.js) |

## CLI

```bash
node bin/pumpkit.js info <mint>                        # program, decimals, creator, tax, market, sharing config
node bin/pumpkit.js holders <mint> --top 20            # snapshot (needs an RPC that allows getProgramAccounts)
node bin/pumpkit.js fees                               # unclaimed creator fees of PRIVATE_KEY's wallet
node bin/pumpkit.js claim --yes
node bin/pumpkit.js buy <mint> 0.1 --yes               # routes curve / PumpSwap / Jupiter
node bin/pumpkit.js burn <mint> 1000000 --yes          # exact amount, UI units
node bin/pumpkit.js airdrop <holdersOfMint> --reward <mint> --amount 5000000 --yes
node bin/pumpkit.js airdrop <holdersOfMint> --sol 1.5 --yes
node bin/pumpkit.js fee-split <mint> <engine>:9000 <main>:1000 --yes   # on-chain, locked forever
node bin/pumpkit.js simulate-create "name" "TICKER13CHARS"             # free, no wallet
```

Run without arguments for the full list. Everything that moves funds needs `--yes`.

## The recipes (examples/)

- `buyback-burn-engine.js` — BLAST: claim → one buy → burn the delta, on a global clock.
- `claim-buy-airdrop.js` — TUNGBANK: claim → buy a reward coin → airdrop it to holders (or SOL directly).
- `trustless-launch-server.js` — PUMPDRAW: build unsigned launch txs, the user signs, we relay and prove the fee on chain. No server key.

Fee-sharing launch (ETF): `createCoin` with the engine wallet as creator, then `writeFeeSharing({ shareholders: [{engine, 9000}, {main, 1000}] })` — pump.fun revokes the admin, so the split can never be redirected. Each round `distributeSharedFees` is permissionless.

## Gotchas baked in (do not undo them)

1. **pump.fun mints are Token-2022** (older ones classic SPL). `getAssociatedTokenAddressSync` defaults to the classic program → wrong ATA → "buy confirmed, no tokens received". Always `mintProgramId()`.
2. **Never burn / sell / transfer "everything the wallet holds".** The engine wallet is usually the creator wallet with the user's dev bag in it. Round #1 of BULLS VS BEARS burned ~1 ETH of the user's tokens that way. Use `buyMeasured` + `burnDelta` / `burnOwedRaw`.
3. **Jupiter v6 is dead**, `lite-api.jup.ag/swap/v1` is the drop-in. Price on `/price/v3`.
4. **pump.fun `/coins/<mint>` 404s** since Sep 2026 → `fetchCoinInfo` falls back to DexScreener.
5. **The pump SDKs' ESM builds break on Node** (bad anchor imports) — `context.js` loads the CJS builds via `createRequire`.
6. **getProgramAccounts** is refused by publicnode and rate-limited by api.mainnet-beta → separate `snapshotRpcUrl` + backoff. Helius/Chainstack keys run out of quota and crash-loop the engine at boot; keep a fallback.
   publicnode also refuses "indexed" calls (`getTokenSupply`, `getTokenLargestAccounts` → we read the mint account / use the snapshot RPC) and, since Oct 2026, **caps `getMultipleAccountsInfo` at 10 keys** ("403 Request blocked") → `getMultipleAccounts(ctx, keys)` shrinks the batch by itself. Never call `connection.getMultipleAccountsInfo` directly.
7. **Airdrop ATA rent**: creating a token account for a holder costs ~0.002 SOL. Policy: pay it when the drop is worth it or after N skipped rounds, once per wallet ever; skip holders who closed an account the engine paid for.
8. **Railway redeploys overlap** two containers for a few seconds and kill the old one mid-tx → `advisoryLock` on a reserved connection with keep-alive, crash-safe ledger hooks (`ledger.afterBuy` before `afterBurn`), deploy only when `scheduler.busy()` is false.
9. **Ticker max is 13 bytes** on chain (UI says 10); `simulateCreate` is the free way to test any limit.
10. **Secrets**: `assertMasterKey` at boot. A `grep MASTER_KEY .env` once matched a comment line and shipped a broken key to production — use `grep -E '^MASTER_KEY='`.
11. **Trustless launches**: the browser owns the mint keypair, the server builds unsigned bytes, `verifyLaunch` runs before signing, `relaySigned` cannot alter anything, and the listing waits for `balanceDelta(tx, treasury) ≥ fee`.

## Versions

`@pump-fun/pump-sdk` 2.0.0 · `@pump-fun/pump-swap-sdk` 1.20.0 · `@solana/web3.js` 1.99 · `@solana/spl-token` 0.4.15 — the combination every live engine of ours runs on.
