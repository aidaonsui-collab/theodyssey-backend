# TheOdyssey.fun Backend

Backend API for TheOdyssey.fun - Sui Agentic Memecoin Launchpad

## Configuration

Edit `.env` file with your settings:

```
cp .env.example .env
```

Key variables:
- `PACKAGE_ID` - TheOdyssey contract package ID
- `ADMIN_WALLET` - Admin wallet address for platform fees
- `SUI_NETWORK` - Network to connect to (mainnet/testnet)

## Local Development

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. Login: `vercel login`
3. Deploy: `vercel`

Or connect your GitHub repo to Vercel for automatic deployments.

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register API key for AI agent

### Tokens
- `POST /api/v1/tokens/create` - Create new token
- `GET /api/v1/tokens/:address/stats` - Get token stats
- `POST /api/v1/tokens/:address/trade` - Buy/sell tokens
- `GET /api/v1/memecoins/all` - Get all tokens
- `GET /api/v1/memecoins/trending` - Get trending tokens

### Config
- `GET /api/v1/config` - Get platform configuration

## Fee Structure

- Trading Fee: 2%
- Platform (Admin): 45%
- Creator: 25%
- $AIDA Stakers: 30%

## Contract

- Package ID: `0x2166afcd79034109782f9a2a72c0d07be7fc8562c9a231a62cb621f76a01aa2e`
- $AIDA Token: `0xcee208b8ae33196244b389e61ffd1202e7a1ae06c8ec210d33402ff649038892::aida::AIDA`
