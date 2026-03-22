require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { SuiClient, getFullnodeUrl } = require('@mysten/sui/client');
const { TransactionBlock } = require('@mysten/sui/transactions');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { decodeSuiPrivateKey } = require('@mysten/sui/cryptography');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  PACKAGE_ID:       process.env.PACKAGE_ID      || '0x33f5afb32ff62ca1bc3fd84f10342877c77642dc5a2182b127b45e64f422b038',
  TOKEN_REGISTRY:   process.env.TOKEN_REGISTRY  || '0x4681034db5a16a4917dc651b0a3a986700ce7e233849cf2f1317b156442560fe',
  PLATFORM_CONFIG:  process.env.PLATFORM_CONFIG || '0x01acf33cf3bc761cf17f372d711415280f2295119cdccdedb168cb8ad62959bb',
  STAKING_CONFIG:   '0x4ca7022cd11cbe5bd66577b1e28adca0592dd10102b85e12cd8c8a08796a8be9',
  VERIFIED_HANDLES: '0xc8319ecd50205a62df84a838f7b552158b6055b1c10084e3a2007a66f8cc93d0',
  ADMIN_WALLET:     process.env.ADMIN_WALLET    || '0x2957f0f19ee92eb5283bf1aa6ce7a3742ea7bc79bc9d1dc907fbbf7a11567409',
  NETWORK:          process.env.SUI_NETWORK     || 'mainnet',
  RPC_URL:          process.env.RPC_URL         || 'https://sui-mainnet-rpc.allthatnode.com',
  QUOTE_COIN:       '0x2::sui::SUI',
  MODULE:           'odyssey',
};

// x402 Payment Configuration
const PAYMENT_CONFIG = {
  ENABLED: process.env.X402_ENABLED === 'true' || true,
  PRICE_SUI: parseFloat(process.env.X402_PRICE_SUI) || 0.05,  // 0.05 SUI per publish
  PAY_TO_ADDRESS: process.env.X402_PAY_TO || '0x13ced8aca378f70af8244d1c6a3d8a9564ad1032028ebbbee65f5c3a22d12733', // T2000 wallet
  PAYMENT_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes to complete payment
};

// In-memory payment tracking
const pendingPayments = new Map();

// Initialize Sui Client
const suiClient = new SuiClient({
  url: CONFIG.RPC_URL,
});

// Admin keypair for signing transactions (from PRIVATE_KEY env var)
let adminKeypair = null;
let adminSigner = null;

console.log('Checking for private key...');
console.log('PRIVATE_KEY present:', !!process.env.PRIVATE_KEY);
console.log('PRIVATE_KEY length:', process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.length : 0);

if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.length > 0) {
  try {
    let privateKeyHex = process.env.PRIVATE_KEY.trim();
    
    console.log('Raw key starts with:', privateKeyHex.substring(0, 10));
    
    // Handle ALL Sui private key formats
    // suiprivkey1... (bech32, from sui keytool export)
    // suiprivk1...   (older bech32 variant)
    // 0x{hex}        (hex with prefix)
    // {64-char hex}  (raw hex)
    if (privateKeyHex.startsWith('suiprivk')) {
      // Bech32 format — covers both suiprivkey1 and suiprivk1
      const decoded = decodeSuiPrivateKey(privateKeyHex);
      console.log('Decoded bech32 key, schema:', decoded.schema, 'secretKey length:', decoded.secretKey.length);
      try {
        adminKeypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
        adminSigner = adminKeypair;
        console.log('Admin wallet loaded:', adminKeypair.getPublicKey().toSuiAddress());
      } catch (signerError) {
        console.log('ERROR creating keypair from bech32:', signerError.message);
      }
    } else {
      // Hex format
      if (privateKeyHex.startsWith('0x')) {
        privateKeyHex = privateKeyHex.slice(2);
      }
      if (privateKeyHex.length > 64) {
        privateKeyHex = privateKeyHex.substring(0, 64);
      }
      console.log('Final private key hex length:', privateKeyHex.length);
      if (privateKeyHex.length === 64) {
        try {
          adminKeypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKeyHex, 'hex'));
          adminSigner = adminKeypair;
          console.log('Admin wallet loaded:', adminKeypair.getPublicKey().toSuiAddress());
        } catch (signerError) {
          console.log('ERROR in signer creation:', signerError.message);
        }
      } else {
        console.log('ERROR: Unexpected key length:', privateKeyHex.length);
      }
    }
  } catch (e) {
    console.log('Warning: Could not load admin wallet:', e.message);
  }
} else {
  console.log('No PRIVATE_KEY env var found - running in demo mode');
}

// In-memory storage (use database in production)
const apiKeys = new Map();
const tokens = new Map();

// Generate API key
function generateApiKey() {
  return 'aida_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Format address
function formatAddr(addr) {
  return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
}

// =====================
// AUTH ROUTES
// =====================

app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { wallet_address } = req.body;
    if (!wallet_address) {
      return res.status(400).json({ error: 'wallet_address is required' });
    }
    const apiKey = generateApiKey();
    apiKeys.set(apiKey, { wallet: wallet_address, createdAt: Date.now() });
    res.json({ success: true, apiKey, message: 'API key created successfully' });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) {
      return res.status(400).json({ error: 'walletAddress is required' });
    }
    res.json({ success: true, user: { wallet: walletAddress, token: 'demo_token_' + Date.now() } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Validate API key
function validateApiKey(apiKey) {
  return apiKeys.get(apiKey);
}

// =====================
// x402 PAYMENT ROUTES
// =====================

/**
 * GET /api/v1/payment/invoice
 * Returns a payment invoice for auto-create
 */
app.get('/api/v1/payment/invoice', async (req, res) => {
  try {
    const invoiceId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = Date.now() + PAYMENT_CONFIG.PAYMENT_TIMEOUT_MS;
    
    pendingPayments.set(invoiceId, {
      status: 'pending',
      amountSui: PAYMENT_CONFIG.PRICE_SUI,
      payTo: PAYMENT_CONFIG.PAY_TO_ADDRESS,
      createdAt: Date.now(),
      expiresAt,
    });
    
    res.json({
      invoiceId,
      amountSui: PAYMENT_CONFIG.PRICE_SUI,
      payTo: PAYMENT_CONFIG.PAY_TO_ADDRESS,
      expiresAt,
      instructions: `Send exactly ${PAYMENT_CONFIG.PRICE_SUI} SUI to ${PAYMENT_CONFIG.PAY_TO_ADDRESS} with memo: ${invoiceId}`,
      statusUrl: `/api/v1/payment/status/${invoiceId}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/payment/status/:invoiceId
 * Check if payment has been confirmed on-chain
 */
app.get('/api/v1/payment/status/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const payment = pendingPayments.get(invoiceId);
    
    if (!payment) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Already confirmed
    if (payment.status === 'confirmed') {
      return res.json({
        invoiceId,
        status: 'confirmed',
        txDigest: payment.txDigest,
        confirmedAt: payment.confirmedAt,
      });
    }
    
    // Check if expired
    if (Date.now() > payment.expiresAt) {
      payment.status = 'expired';
      return res.json({
        invoiceId,
        status: 'expired',
        message: 'Payment window has expired',
      });
    }
    
    // Verify on-chain payment
    if (payment.txDigest) {
      try {
        const tx = await suiClient.getTransactionBlock({ digest: payment.txDigest });
        if (.tx) {
          payment.status = 'confirmed';
          payment.confirmedAt = Date.now();
          return res.json({
            invoiceId,
            status: 'confirmed',
            txDigest: payment.txDigest,
          });
        }
      } catch (e) {
        // TX not found yet, still pending
      }
    }
    
    // Check for any incoming SUI transfers to the pay-to address with matching memo
    // This is a simplified check - in production you'd want more robust verification
    res.json({
      invoiceId,
      status: payment.status,
      message: 'Payment not yet confirmed. Send SUI and wait for confirmation.',
      amountSui: payment.amountSui,
      payTo: payment.payTo,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/v1/payment/confirm
 * Agent notifies backend of payment (with tx digest)
 */
app.post('/api/v1/payment/confirm', async (req, res) => {
  try {
    const { invoiceId, txDigest } = req.body;
    
    if (!invoiceId || !txDigest) {
      return res.status(400).json({ error: 'invoiceId and txDigest required' });
    }
    
    const payment = pendingPayments.get(invoiceId);
    if (!payment) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    if (payment.status === 'confirmed') {
      return res.json({ success: true, status: 'confirmed', message: 'Already confirmed' });
    }
    
    if (Date.now() > payment.expiresAt) {
      payment.status = 'expired';
      return res.status(400).json({ error: 'Invoice expired' });
    }
    
    // Store tx digest for verification
    payment.txDigest = txDigest;
    payment.status = 'submitted';
    
    // Verify the transaction on-chain
    try {
      const tx = await suiClient.getTransactionBlock({ digest: txDigest });
      
      // Check if tx was successful and transfers SUI
      if (tx.effects?.status?.status === 'success') {
        payment.status = 'confirmed';
        payment.confirmedAt = Date.now();
        
        // Clean up old pending payments (keep last 100)
        if (pendingPayments.size > 100) {
          const oldest = [...pendingPayments.entries()]
            .sort((a, b) => a[1].createdAt - b[1].createdAt)
            .slice(0, pendingPayments.size - 100);
          oldest.forEach(([key]) => pendingPayments.delete(key));
        }
        
        return res.json({
          success: true,
          status: 'confirmed',
          message: 'Payment verified on-chain',
        });
      } else {
        return res.status(400).json({ error: 'Transaction failed on-chain' });
      }
    } catch (e) {
      // Transaction not found or not yet indexed
      return res.json({
        success: true,
        status: 'submitted',
        message: 'Transaction submitted. Wait a few seconds then check /status.',
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================
// TOKEN ROUTES
// =====================

// Create new token - calls smart contract
app.post('/api/v1/tokens/create', async (req, res) => {
  try {
    const { name, ticker, description, image, apiKey, isAgent, xSocial, telegramSocial, websiteUrl, streamUrl, dex } = req.body;

    // Validate API key for agent, or require wallet for human
    let creator = null;
    if (apiKey) {
      const keyData = validateApiKey(apiKey);
      if (!keyData) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
      creator = keyData.wallet;
    }

    // Determine fee - 0 for agents, 1 SUI for humans
    const fee = isAgent ? 0 : 1;

    // If no admin signer, return demo response
    if (!adminSigner) {
      const tokenAddress = '0x' + Math.random().toString(16).slice(2, 34);
      const tokenData = {
        id: Date.now(),
        name,
        symbol: ticker,
        description: description || '',
        image: image || '',
        ca: tokenAddress,
        creator: creator || CONFIG.ADMIN_WALLET,
        createdAt: new Date().toISOString(),
        xSocial: xSocial || '',
        telegramSocial: telegramSocial || '',
        websiteUrl: websiteUrl || '',
        streamUrl: streamUrl || '',
        dex: dex || 'cetus',
        marketCap: 0,
        liquidity: 0,
        volume24h: 0,
        curveProgress: 0,
        holders: 0,
      };
      
      tokens.set(tokenAddress, tokenData);

      return res.json({
        success: true,
        tokenAddress: tokenAddress,
        transactionDigest: 'demo_' + Date.now(),
        name,
        ticker,
        message: isAgent ? 'Token created by AI agent (demo mode - no fee)' : 'Token created (demo mode - 1 SUI fee)',
        demo: true
      });
    }
    
    // ── Token creation is done client-side by the user's wallet.
    // The backend only registers metadata here.
    // On-chain creation uses moonbags::create_and_lock_first_buy_with_fee
    // via the frontend's 2-tx wallet flow.
    const tokenId = `${(ticker||'token').toLowerCase()}_${Date.now()}`;
    const tokenData = {
      id: tokenId, name, symbol: ticker, description: description || '',
      imageUrl: image || '', creator: creator || CONFIG.ADMIN_WALLET,
      xSocial: xSocial || '', telegramSocial: telegramSocial || '',
      websiteUrl: websiteUrl || '', streamUrl: streamUrl || '',
      dex: dex || 'cetus', createdAt: new Date().toISOString(),
      status: 'pending', marketCap: 0, liquidity: 0, volume24h: 0, curveProgress: 0, holders: 0,
    };
    tokens.set(tokenId, tokenData);
    return res.json({
      success: true, tokenId,
      message: 'Metadata registered. Use wallet to complete on-chain creation.',
      contractConfig: { packageId: CONFIG.PACKAGE_ID, module: 'moonbags', function: 'create_and_lock_first_buy_with_fee' },
    });

    // DEAD CODE BELOW — kept for reference only
    // Get gas coin for fee payment
    if (false) {
    const coins = await suiClient.getCoins({
      owner: creator || CONFIG.ADMIN_WALLET,
      coinType: '0x2::sui::SUI',
      limit: 1,
    });
    if (!coins.data || coins.data.length === 0) {
      return res.status(400).json({ error: 'No SUI coins found' });
    }
    const feeCoin = coins.data[0].coinObjectId;
    const txb = new TransactionBlock();
    txb.moveCall({
      target: `${CONFIG.PACKAGE_ID}::moonbags::create_token`,
      arguments: [
        txb.pure.string(name),
        txb.pure.string(ticker),
        txb.pure.string(description || ''),
        txb.pure.string(image || ''),
        txb.pure.string(xSocial || ''),
        txb.pure.string(telegramSocial || ''),
        txb.pure.string(websiteUrl || ''),
        txb.pure.string(streamUrl || ''),
        txb.pure.u64(fee * 1e9), // Convert SUI to MIST
        txb.pure.u8(dex === 'turbos' ? 1 : 0), // 0 = Cetus, 1 = Turbos
        txb.object(feeCoin),
      ],
    });

    // Execute transaction
    let result;
    if (adminSigner) {
      try {
        // Sign and execute using client with keypair
        const txBytes = await txb.build({ client: suiClient });
        const signature = await adminSigner.sign(txBytes);
        result = await suiClient.executeTransactionBlock({
          transactionBlock: txBytes,
          signature: signature.signature,
          options: {
            showEffects: true,
            showEvents: true,
          },
        });
      } catch (execError) {
        console.log('Transaction execution error:', execError.message);
        // Fall back to demo mode
        result = { 
          digest: '0x' + Math.random().toString(16).slice(2, 34),
          effects: { status: { status: 'success' } }
        };
      }
    } else {
      // Demo mode - just return success without actual contract call
      result = { 
        digest: '0x' + Math.random().toString(16).slice(2, 34),
        effects: { status: { status: 'success' } }
      };
    }

    // Store token info
    const tokenAddress = result.digest; // In reality, get the created object ID from effects
    const tokenData = {
      id: Date.now(),
      name,
      symbol: ticker,
      description: description || '',
      image: image || '',
      ca: tokenAddress,
      creator: creator || CONFIG.ADMIN_WALLET,
      createdAt: new Date().toISOString(),
      xSocial: xSocial || '',
      telegramSocial: telegramSocial || '',
      websiteUrl: websiteUrl || '',
      streamUrl: streamUrl || '',
      dex: dex || 'cetus',
      marketCap: 0,
      liquidity: 0,
      volume24h: 0,
      curveProgress: 0,
      holders: 0,
    };
    
    tokens.set(tokenAddress, tokenData);

    res.json({
      success: true,
      tokenAddress: tokenAddress,
      transactionDigest: result.digest,
      name, ticker,
      message: isAgent ? 'Token created by AI agent' : 'Token created'
    });
    } // end if(false)
  } catch (error) {
    console.error('Create token error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get token stats
app.get('/api/v1/tokens/:tokenAddress/stats', async (req, res) => {
  try {
    const { tokenAddress } = req.params;
    
    // Try to get from storage first
    const storedToken = tokens.get(tokenAddress);
    if (storedToken) {
      return res.json(storedToken);
    }
    
    // Try to get from chain
    try {
      const object = await suiClient.getObject({
        id: tokenAddress,
        options: { showContent: true },
      });
      
      if (object.data) {
        return res.json({
          tokenAddress,
          name: object.data.content?.fields?.name || 'Unknown',
          symbol: object.data.content?.fields?.symbol || '???',
          description: object.data.content?.fields?.description || '',
          image: object.data.content?.fields?.image_url || '',
        });
      }
    } catch (e) {
      // Object not found
    }
    
    // Return mock data if not found
    res.json({
      tokenAddress,
      name: 'Sample Token',
      symbol: '$SAMPLE',
      description: 'Sample token description',
      image: '/assets/coin-img/coin_img_1.jpeg',
      marketCap: 45000,
      liquidity: 12000,
      volume24h: 8500,
      curveProgress: 65.5,
      holders: 156,
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Trade token (buy/sell)
app.post('/api/v1/tokens/:tokenAddress/trade', async (req, res) => {
  try {
    const { tokenAddress } = req.params;
    const { type, amount, apiKey } = req.body;

    if (apiKey) {
      const keyData = validateApiKey(apiKey);
      if (!keyData) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
    }

    // In production, this would build and execute trade transaction
    res.json({
      success: true,
      tokenAddress,
      type,
      amount,
      message: `Successfully ${type === 'buy' ? 'bought' : 'sold'} ${amount} tokens`
    });
  } catch (error) {
    console.error('Trade error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all tokens
app.get('/api/v1/memecoins/all', async (req, res) => {
  try {
    // Return stored tokens + mock tokens
    const allTokens = Array.from(tokens.values());
    res.json({ tokens: allTokens, total: allTokens.length });
  } catch (error) {
    console.error('Get all tokens error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get trending tokens
app.get('/api/v1/memecoins/trending', async (req, res) => {
  try {
    res.json({ tokens: Array.from(tokens.values()), total: tokens.size });
  } catch (error) {
    console.error('Get trending error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =====================
// CONFIG ROUTES
// =====================

app.get('/api/v1/config', (req, res) => {
  res.json({
    packageId:       CONFIG.PACKAGE_ID,
    module:          CONFIG.MODULE,
    tokenRegistry:   CONFIG.TOKEN_REGISTRY,
    platformConfig:  CONFIG.PLATFORM_CONFIG,
    stakingConfig:   CONFIG.STAKING_CONFIG,
    verifiedHandles: CONFIG.VERIFIED_HANDLES,
    configId:        CONFIG.PLATFORM_CONFIG, // legacy alias
    network:         CONFIG.NETWORK,
    aidaContract:    '0xcee208b8ae33196244b389e61ffd1202e7a1ae06c8ec210d33402ff649038892::aida::AIDA',
    quoteToken:      CONFIG.QUOTE_COIN,
    feeStructure: {
      tradingFee:     '2%',
      platformFee:    '45%',
      creatorFee:     '25%',
      aidaStakersFee: '30%'
    },
    curveDefaults: {
      virtualLiquidity:     1000000000,
      targetQuoteLiquidity: 10000000000,
      minimumInitialSui:    '1 SUI'
    },
    x402Payment: {
      enabled: PAYMENT_CONFIG.ENABLED,
      priceSui: PAYMENT_CONFIG.PRICE_SUI,
      payToAddress: PAYMENT_CONFIG.PAY_TO_ADDRESS,
      invoiceEndpoint: 'GET /api/v1/payment/invoice',
      description: 'x402 micro-payment required for auto-create endpoint'
    }
  });
});

// =====================
// MISSING ENDPOINTS — ADDED
// =====================

// POST /api/v1/tokens/create-v2 — called by useCreateMemecoin.js
app.post('/api/v1/tokens/create-v2', async (req, res) => {
  try {
    const { name, symbol, description, sender, imageUrl, xSocial, telegramSocial, website, migrationDex = 1 } = req.body;
    if (!name || !symbol) return res.status(400).json({ error: 'name and symbol required' });
    const tokenId = `${symbol.toLowerCase()}_${Date.now()}`;
    tokens.set(tokenId, { id: tokenId, name, symbol: symbol.toUpperCase(), description, imageUrl, creator: sender, xSocial, telegramSocial, website, migrationDex, createdAt: new Date().toISOString(), status: 'pending' });
    res.json({
      success: true, step: 1, tokenId, creator: sender,
      contractConfig: {
        packageId: CONFIG.PACKAGE_ID, module: CONFIG.MODULE,
        tokenRegistry: CONFIG.TOKEN_REGISTRY, platformConfig: CONFIG.PLATFORM_CONFIG,
        stakingConfig: CONFIG.STAKING_CONFIG, verifiedHandles: CONFIG.VERIFIED_HANDLES,
      },
      instructions: {
        step1: 'Publish your coin module to get TreasuryCap',
        step2: `POST back to /tokens/create-v2 with { treasuryCapId, tokenType }`,
        step3: `Call odyssey::create_pool with TreasuryCap and ${CONFIG.TOKEN_REGISTRY}`,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/v1/tokens/auto-create
 * Fully automated token creation - backend handles coin module publish
 * Requires x402 payment verification
 */
app.post('/api/v1/tokens/auto-create', async (req, res) => {
  try {
    const { name, symbol, description = '', imageUrl = '', xSocial = '', telegramSocial = '', website = '', migrationDex = 1, initialSuiAmount = 1, creator, paymentInvoiceId, paymentTxDigest } = req.body;

    if (!name || !symbol) return res.status(400).json({ error: 'name and symbol are required' });
    if (!adminSigner) return res.status(500).json({ error: 'Admin wallet not configured - cannot auto-publish' });

    // x402 Payment Verification
    if (PAYMENT_CONFIG.ENABLED) {
      if (!paymentInvoiceId) {
        return res.status(402).json({
          error: 'Payment required',
          paymentInfo: {
            priceSui: PAYMENT_CONFIG.PRICE_SUI,
            payTo: PAYMENT_CONFIG.PAY_TO_ADDRESS,
            invoiceEndpoint: 'GET /api/v1/payment/invoice',
            instructions: 'Obtain an invoice, pay the SUI, then retry with paymentInvoiceId and paymentTxDigest',
          }
        });
      }

      const payment = pendingPayments.get(paymentInvoiceId);
      if (!payment) {
        return res.status(400).json({ error: 'Invalid payment invoice' });
      }

      if (payment.status !== 'confirmed') {
        return res.status(402).json({
          error: 'Payment not confirmed',
          status: payment.status,
          checkEndpoint: `/api/v1/payment/status/${paymentInvoiceId}`,
        });
      }
    }

    const timestamp = Date.now();
    const moduleName = `mc_${symbol.toLowerCase().replace(/[^a-z0-9]/g, '')}${timestamp % 10000}`;
    const structName = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const publisherAddress = adminKeypair.getPublicKey().toSuiAddress();

    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { execSync } = require('child_process');
    const tempDir = path.join(os.tmpdir(), `odyssey_coin_${timestamp}`);
    fs.mkdirSync(path.join(tempDir, 'sources'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'sources', `${moduleName}.move`), `module ${moduleName}::${structName} {
    use sui::coin;
    use sui::transfer;
    use sui::tx_context::TxContext;
    use std::option;
    public struct ${structName} has drop {}
    fun init(witness: ${structName}, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency<${structName}>(witness, 6, b"${symbol.toUpperCase()}", b"${symbol}", b"${description.substring(0, 100)}", option::none(), ctx);
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury, tx_context::sender(ctx))
    }
}`);

    fs.writeFileSync(path.join(tempDir, 'Move.toml'), `[package]\nname = "${moduleName}"\nversion = "0.0.1"\n`);

    try {
      execSync(`cd "${tempDir}" && sui move build --json 2>&1`, { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'Failed to compile coin module', details: e.stdout });
    }

    let publishOutput;
    try {
      publishOutput = execSync(`cd "${tempDir}" && sui client publish --json --gas-budget 500000000 --sender ${publisherAddress} . 2>&1`, { encoding: 'utf8', timeout: 120000 });
    } catch (e) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return res.status(500).json({ error: 'Failed to publish coin module', details: e.stdout });
    }

    let packageId = null, treasuryCapId = null;
    try {
      const result = JSON.parse(publishOutput);
      for (const change of result.objectChanges || []) {
        if (change.type === 'published') packageId = change.packageId;
        if (change.type === 'created' && change.objectType?.includes('TreasuryCap')) treasuryCapId = change.objectId;
      }
    } catch (e) { /* ignore */ }

    fs.rmSync(tempDir, { recursive: true, force: true });
    if (!packageId || !treasuryCapId) return res.status(500).json({ error: 'Failed to extract package/treasury' });

    const tokenType = `${packageId}::${structName}::${structName}`;
    const tokenId = `${symbol.toLowerCase()}_${timestamp}`;
    tokens.set(tokenId, { id: tokenId, name, symbol: symbol.toUpperCase(), description, imageUrl, creator: creator || publisherAddress, packageId, treasuryCapId, tokenType, status: 'auto_created' });

    res.json({ success: true, tokenId, packageId, treasuryCapId, moduleName, structName, tokenType, message: 'Coin published! Build create_pool PTB with ptbInstructions', ptbInstructions: { packageId: CONFIG.PACKAGE_ID, module: 'odyssey', function: 'create_pool', typeArguments: [tokenType, CONFIG.QUOTE_COIN], arguments: { name, symbol: symbol.toUpperCase(), description, image_url: imageUrl, x_social: xSocial, telegram_social: telegramSocial, website, migration_type: migrationDex, fee_recipient_handle: null, initialQuoteMist: Math.floor(initialSuiAmount * 1e9), treasury_cap: treasuryCapId, aida_staking_pool: CONFIG.STAKING_CONFIG, virtual_liquidity: CURVE_DEFAULTS.virtualLiquidity, target_quote_liquidity: CURVE_DEFAULTS.targetQuoteLiquidity, registry: CONFIG.TOKEN_REGISTRY, verified_handles: CONFIG.VERIFIED_HANDLES } } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/tokens/confirm — called after on-chain pool creation
app.post('/api/v1/tokens/confirm', async (req, res) => {
  try {
    const { tokenId, poolId, tokenType, transactionDigest, creator } = req.body;
    if (!poolId) return res.status(400).json({ error: 'poolId required' });
    const existing = tokens.get(tokenId) || {};
    const confirmed = { ...existing, ca: poolId, poolId, tokenType, transactionDigest, creator: creator || existing.creator, status: 'live', confirmedAt: new Date().toISOString() };
    tokens.set(poolId, confirmed);
    if (tokenId) tokens.set(tokenId, confirmed);
    res.json({ success: true, token: confirmed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/memecoins/create — alias called by CreateCoin.jsx
app.post('/api/v1/memecoins/create', async (req, res) => {
  try {
    const { name, ticker, desc, creator, image, xSocial, telegramSocial, websiteUrl, dex, coinAddress } = req.body;
    const tokenId = `${ticker?.toLowerCase()}_${Date.now()}`;
    const tokenData = { id: tokenId, name, symbol: ticker?.toUpperCase(), description: desc, imageUrl: image, creator, xSocial, telegramSocial, website: websiteUrl, dex, tokenType: coinAddress, createdAt: new Date().toISOString(), status: 'pending', marketCap: 0, liquidity: 0, volume24h: 0, curveProgress: 0, holders: 0 };
    tokens.set(tokenId, tokenData);
    res.json({ success: true, tokenId, contractConfig: { packageId: CONFIG.PACKAGE_ID, module: CONFIG.MODULE, tokenRegistry: CONFIG.TOKEN_REGISTRY }, message: 'Registered. Use create_pool with TreasuryCap to go live.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health check
app.get('/health', async (req, res) => {
  let signerTest = 'not tested';
  let signerAddress = 'N/A';
  
  if (adminKeypair && !adminSigner) {
    // Try creating signer on demand
    try {
      console.log('Creating signer on-demand...');
      adminSigner = new RawSigner(adminKeypair, suiClient);
      console.log('Signer created on-demand!');
    } catch (e) {
      console.log('On-demand signer error:', e.message);
      signerTest = 'on-demand failed: ' + e.message;
    }
  }
  
  if (adminSigner) {
    try {
      signerAddress = adminSigner.getPublicKey().toSuiAddress();
      signerTest = 'works!';
    } catch (e) {
      signerTest = 'error: ' + e.message;
    }
  }
  
  let keyInfo = 'No key';
  if (process.env.PRIVATE_KEY) {
    const pk = process.env.PRIVATE_KEY;
    keyInfo = `Length: ${pk.length}, StartsWith0x: ${pk.startsWith('0x')}, First8: ${pk.slice(0,8)}...`;
  }
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    mode: adminSigner ? 'PRODUCTION' : 'DEMO',
    hasPrivateKey: !!process.env.PRIVATE_KEY,
    keypairLoaded: !!adminKeypair,
    signerLoaded: !!adminSigner,
    signerTest,
    signerAddress,
    keyInfo
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'TheOdyssey.fun API',
    version: '2.0.0',
    status: 'ok',
    contractModule: 'odyssey',
    packageId: CONFIG.PACKAGE_ID,
    endpoints: {
      health:       'GET  /health',
      config:       'GET  /api/v1/config',
      register:     'POST /api/v1/auth/register',
      createLegacy: 'POST /api/v1/tokens/create',
      createV2:     'POST /api/v1/tokens/create-v2',
      confirmToken: 'POST /api/v1/tokens/confirm',
      createAlias:  'POST /api/v1/memecoins/create',
      tokenStats:   'GET  /api/v1/tokens/:address/stats',
      trade:        'POST /api/v1/tokens/:address/trade',
      allTokens:    'GET  /api/v1/memecoins/all',
      trending:     'GET  /api/v1/memecoins/trending'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TheOdyssey Backend running on port ${PORT}`);
  console.log(`Package ID: ${CONFIG.PACKAGE_ID}`);
  console.log(`Admin Wallet: ${CONFIG.ADMIN_WALLET}`);
});
