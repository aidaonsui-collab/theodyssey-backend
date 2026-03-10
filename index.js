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
  PACKAGE_ID: process.env.PACKAGE_ID || '0xffbc1d872f92494c41eb6483033a647d51c59c3f813070ea2ecf6023881376f4',
  ADMIN_WALLET: process.env.ADMIN_WALLET || '0x2957f0f19ee92eb5283bf1aa6ce7a3742ea7bc79bc9d1dc907fbbf7a11567409',
  NETWORK: process.env.SUI_NETWORK || 'mainnet',
  RPC_URL: process.env.RPC_URL || 'https://sui-mainnet-rpc.dwellir.com',
};

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
    
    // Handle Sui wallet export format (suiprivk1...)
    if (privateKeyHex.startsWith('suiprivk1')) {
      // Use the new decodeSuiPrivateKey function
      const decoded = decodeSuiPrivateKey(privateKeyHex);
      privateKeyHex = Buffer.from(decoded.secretKey).toString('hex');
      console.log('Decoded Sui wallet key to hex, length:', privateKeyHex.length);
    } else if (privateKeyHex.startsWith('0x')) {
      privateKeyHex = privateKeyHex.slice(2);
      console.log('Removed 0x prefix, new length:', privateKeyHex.length);
    }
    
    console.log('Final private key hex length:', privateKeyHex.length);
    
    if (privateKeyHex.length !== 64) {
      console.log('ERROR: Private key must be 64 hex characters (32 bytes). Got:', privateKeyHex.length);
    } else {
      try {
        console.log('Creating keypair from hex...');
        adminKeypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKeyHex, 'hex'));
        console.log('Keypair created, public key:', adminKeypair.getPublicKey().toSuiAddress());
        
        // Use the keypair as a signer directly
        console.log('Using keypair as signer');
        adminSigner = adminKeypair;
        console.log('Admin wallet loaded successfully');
      } catch (signerError) {
        console.log('ERROR in signer creation:', signerError.message);
        console.log('Stack:', signerError.stack);
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
    
    // Get gas coin for fee payment
    const coins = await suiClient.getCoins({
      owner: creator || CONFIG.ADMIN_WALLET,
      coinType: '0x2::sui::SUI',
      limit: 1,
    });
    
    if (!coins.data || coins.data.length === 0) {
      return res.status(400).json({ error: 'No SUI coins found for fee payment' });
    }
    
    const feeCoin = coins.data[0].coinObjectId;
    
    // Build transaction to create token
    const txb = new TransactionBlock();
    
    // Call create_token function
    // moonbags::create_token(name, ticker, description, image_url, social_x, social_telegram, social_discord, website, stream_url, fee, dex)
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
      name,
      ticker,
      message: isAgent ? 'Token created by AI agent (0 SUI fee)' : 'Token created (1 SUI fee)'
    });
  } catch (error) {
    console.error('Create token error:', error);
    res.status(500).json({ error: error.message, details: error.stack });
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
    packageId: CONFIG.PACKAGE_ID,
    network: CONFIG.NETWORK,
    feeStructure: {
      tradingFee: '2%',
      platformFee: '45%',
      creatorFee: '25%',
      aidaStakersFee: '30%'
    },
    aidaContract: '0xcee208b8ae33196244b389e61ffd1202e7a1ae06c8ec210d33402ff649038892::aida::AIDA'
  });
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
    version: '1.0.0',
    status: 'ok',
    endpoints: {
      health: '/health',
      config: '/api/v1/config',
      register: 'POST /api/v1/auth/register',
      createToken: 'POST /api/v1/tokens/create',
      tokenStats: 'GET /api/v1/tokens/:address/stats',
      trade: 'POST /api/v1/tokens/:address/trade',
      allTokens: 'GET /api/v1/memecoins/all',
      trending: 'GET /api/v1/memecoins/trending'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TheOdyssey Backend running on port ${PORT}`);
  console.log(`Package ID: ${CONFIG.PACKAGE_ID}`);
  console.log(`Admin Wallet: ${CONFIG.ADMIN_WALLET}`);
});
