<p align="center">
  <img src="public/icon.png" width="96" alt="SQFT">
</p>

<h1 align="center">SQFT · $SQFT</h1>

<p align="center"><b>Fees become square feet.</b><br>
A pump.fun coin whose creator rewards are claimed, converted to USDC, bridged to Parcl and turned into long positions on real estate price indices, one per city, measured in square feet of the index. Automatically, every cycle, for as long as the coin trades.<br>
Nothing held by the site. A public receipt at every hop.</p>

<p align="center">
  <a href="https://sqftfun.vercel.app">sqftfun.vercel.app</a> ·
  <a href="https://sqftfun.vercel.app/land">live receipts</a> · <a href="https://sqft-production.up.railway.app/api/engine">api</a> ·
  <a href="https://x.com/sqftfun">@sqftfun</a>
</p>

<p align="center">
  <img src="docs/home.jpg" width="100%" alt="SQFT home: the hero, the KPI strip and the eight market cards">
</p>

---

## What it is

There is no clean way to be long the housing market on Solana: tokenized REITs have no liquidity, fractional-property platforms sell you one building. The one venue that tracks actual home prices is **Parcl**: perpetual futures on Parcl Labs' city indices, quoted in **USD per square foot**, settled in USDC.

SQFT points a pump.fun coin's fee stream at it. The engine wallet owns the coin's creator position. On a timer it:

1. **claims** the creator rewards (SOL),
2. **converts** them on Solana (Jupiter, SOL → USDC, the only collateral the Parcl bridge takes),
3. **bridges** the USDC into Parcl through the bridge program on Solana; the deposit is credited to the Parcl account owned by the same key,
4. **buys land**: free collateral becomes long positions on the city indices in the target book (USA, NYC, Chicago, LA, Miami, Austin, DC, SF by default, equal weight), lot furthest under its weight first, IOC market orders at **1x**, so notional equals collateral and nothing is borrowed,
5. **holds**: one contract unit is one square foot of the index; the index prints once a day (7:50 AM ET) and the positions are marked to it. The engine never sells.

The site shows all of it live: square feet held, land value at today's index, equity on Parcl, the eight lots with their index, daily and 30-day moves, and every transaction with a link to where you can check it yourself.

## Receipts: how to verify it yourself

| Step | Receipt | Where |
|---|---|---|
| Claim | Solana transaction from the pump.fun creator vault to the engine wallet | [solscan.io](https://solscan.io) |
| Convert | Solana transaction of the Jupiter swap (SOL in, USDC out, same wallet) | [solscan.io](https://solscan.io) |
| Bridge | Solana transaction calling the Parcl bridge program; the owner's unclaimed balance on `GET /v1/bridge/state?owner=` | solscan.io, [validator.v4.parcl.co](https://validator.v4.parcl.co/v1/bridge/state) |
| Buy | Parcl transaction hash; the account's positions on `GET /v1/accounts/{id}` | `/land` and the validator |
| Hold | Square feet = position size; value = size × oracle price; the oracle on `GET /v1/oracle/{market}` | `/land`, `GET /api/engine` |

<p align="center">
  <img src="docs/land.jpg" width="100%" alt="The Land page: KPIs, the city markets table and the side panel">
</p>

---

## Run it

```bash
npm install
node server.js            # http://localhost:8787
```

Out of the box the engine is off (`ENGINE=0`) and reads the public side only: the Parcl markets, the creator vault (if `CREATOR_WALLET` is set) and the Parcl account of `ENGINE_WALLET` if one exists.

### Engine

| Variable | Default | Meaning |
|---|---|---|
| `ENGINE` | `0` | `1` runs the loop |
| `ENGINE_DRY` | `1` | `1` logs what it would do and moves nothing |
| `PRIVATE_KEY` | | engine wallet secret (base58 or JSON array). This key is also the Parcl owner key |
| `ENGINE_WALLET` | | public key of the engine wallet, for read-only mode |
| `CREATOR_WALLET` | | public key whose pump.fun vault is shown before the engine is armed |
| `TOKEN_MINT` | | the coin; with a fee-sharing config the engine distributes the shared vault first |
| `ENGINE_EVERY_MS` | `600000` | cycle length |
| `ENGINE_KEEP_SOL` | `0.02` | gas reserve kept in the wallet |
| `PARCL_ENV` | `mainnet` | `mainnet` or `devnet` |
| `PARCL_MARKETS` | all eight | `USA,NYC,Miami` (equal weight) or `USA:40,NYC:30,Miami:30` |
| `PARCL_LEVERAGE` | `1` | leverage on new orders |
| `PARCL_MIN_BRIDGE_USDC` | `5` | the bridge rejects smaller deposits |
| `PARCL_MIN_ORDER_USD` | `5` | smallest order the engine places |
| `PARCL_MAX_SLIPPAGE_BPS` | `100` | slippage cap on market orders |
| `PARCL_REFERRER` | | optional referrer account id for account creation |
| `RPC_URL` | publicnode | Solana RPC |

The first bridge deposit of at least 5 USDC (plus the 1 USDC activation fee) lets the engine sign `CreateFundedAccount` with the owner key; from then on every cycle bridges what it has and buys land with the free collateral.

### Hosting

The frontend is static (`public/`, `vercel.json` included). The API runs anywhere Node 20 runs (`railway.json` included). Point `<meta name="sqft-api">` in `public/index.html` at the API's origin when they are hosted apart.

## Layout

```
server.js          mounts the engine, serves /api/engine, hosts public/
engine/engine.js   the land engine: claim → convert → bridge → buy → hold
engine/parcl.js    Parcl V4 client: public reads, owner-key signing, the bridge deposit instruction
public/            the site: index.html, style.css, app.js, lots.js (the market cards), cities/ (photos), art/ (illustrations)
tools/smoke.mjs    dry-run smoke test of the engine with a throwaway key
vendor/pumpkit     Solana / pump.fun toolkit (claims, swaps, transfers)
```

## Photo credits

The market cards show photographs from Unsplash (free to use under the Unsplash License):

- **New York City**: [photo by @mdisc](https://unsplash.com/photos/landscape-photo-of-new-york-empire-state-building-5omwAMDxmkU) · Unsplash License
- **Chicago**: [photo by @nacio1966](https://unsplash.com/photos/an-aerial-view-of-a-large-city-next-to-a-body-of-water-RIs3Eov9GoM) · Unsplash License
- **Los Angeles**: [photo by @joelmott](https://unsplash.com/photos/lined-palm-trees-7zODz1HMHK4) · Unsplash License
- **Miami**: [photo by @rolandoyera](https://unsplash.com/photos/a-view-of-a-city-from-across-the-water-1T4xUbhjmmk) · Unsplash License
- **Austin**: [photo by @mjtangonan](https://unsplash.com/photos/river-near-buildings-during-daytime-wKfTNWaDYgs) · Unsplash License
- **Washington, DC**: [photo by @caleblaz](https://unsplash.com/photos/capitol-hill-a6h5e59r15o) · Unsplash License
- **San Francisco**: [photo by @vay2250](https://unsplash.com/photos/golden-gate-bridge-san-francisco-california-QhYTCG3CTeI) · Unsplash License
- **United States**: [photo by @aviosly](https://unsplash.com/photos/aerial-view-of-house-village-ZdtOy25eNn4) · Unsplash License

Not financial advice. Perpetual futures carry funding and can be liquidated; at 1x on a daily-marked index that risk is small but not zero. The engine is the only thing that trades, and it only ever buys.
