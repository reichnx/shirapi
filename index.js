const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const app = express();

// ==================== MIDDLEWARE ====================
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from public directory
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  message: { status: false, message: 'Too many requests, please slow down' }
});
app.use('/api/', limiter);

// ==================== CONFIGURATION ====================
const MAX_SHARE_LIMIT = 50;
const REQUEST_TIMEOUT = 20000;
const MAX_RETRIES = 3;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
];

// ==================== HELPER FUNCTIONS ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Validate Facebook URL
const validateFacebookUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes('facebook.com') || urlObj.hostname.includes('fb.com');
  } catch {
    return false;
  }
};

// Validate cookie format
const validateCookie = (cookie) => {
  if (!cookie || typeof cookie !== 'string') return false;
  return cookie.includes('c_user') && cookie.includes('xs');
};

// ==================== CORE FUNCTIONS ====================
// Extract token from cookie
async function extractToken(cookie, ua) {
  try {
    const response = await axios.get(
      "https://business.facebook.com/business_locations",
      {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cookie": cookie,
          "Referer": "https://www.facebook.com/",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1"
        },
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5
      }
    );

    const tokenPatterns = [
      /"accessToken":"(EA[A-Za-z0-9]+)"/,
      /access_token=([A-Za-z0-9]+)/,
      /EAAG[A-Za-z0-9]+/,
      /EAA[A-Za-z0-9]+/,
      /"token":"(EA[A-Za-z0-9]+)"/
    ];

    for (const pattern of tokenPatterns) {
      const match = response.data.match(pattern);
      if (match) {
        const token = match[1] || match[0];
        console.log('✓ Token extracted successfully');
        return token;
      }
    }

    console.log('No valid token pattern matched');
    return null;
  } catch (err) {
    console.error('Token extraction failed:', err.message);
    return null;
  }
}

// Extract token with retry mechanism
async function extractTokenWithRetry(cookie) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ua = getRandomUserAgent();
    console.log(`Token extraction attempt ${attempt}/${MAX_RETRIES}`);
    
    const token = await extractToken(cookie, ua);
    if (token) return token;
    
    if (attempt < MAX_RETRIES) {
      const delay = 2000 * attempt;
      console.log(`Waiting ${delay/1000}s before retry...`);
      await sleep(delay);
    }
  }
  return null;
}

// Perform single share
async function performSingleShare(postLink, token, cookie, ua, shareNumber, totalLimit) {
  try {
    const response = await axios.post(
      "https://graph.facebook.com/v18.0/me/feed",
      null,
      {
        params: {
          link: postLink,
          access_token: token,
          published: 0
        },
        headers: {
          "User-Agent": ua,
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookie,
          "Origin": "https://business.facebook.com",
          "Referer": "https://business.facebook.com/"
        },
        timeout: REQUEST_TIMEOUT
      }
    );

    if (response.data && response.data.id) {
      console.log(`✓ Share ${shareNumber}/${totalLimit} successful: ${response.data.id}`);
      return { success: true, id: response.data.id };
    } else {
      throw new Error('Invalid response from Facebook');
    }
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error(`✗ Share ${shareNumber}/${totalLimit} failed:`, errorMsg);
    
    // Handle specific error types
    if (err.response?.status === 401) {
      throw new Error('TOKEN_EXPIRED');
    }
    if (err.response?.status === 429) {
      console.log('Rate limited, waiting 10 seconds...');
      await sleep(10000);
    }
    
    return { success: false, error: errorMsg };
  }
}

// Perform multiple shares with retry
async function performShares(postLink, token, cookie, limit) {
  let success = 0;
  let failed = 0;
  const errors = [];
  const ua = getRandomUserAgent();
  
  for (let i = 1; i <= limit; i++) {
    let shareSuccess = false;
    let retryCount = 0;
    
    while (!shareSuccess && retryCount < MAX_RETRIES) {
      const result = await performSingleShare(postLink, token, cookie, ua, i, limit);
      
      if (result.success) {
        success++;
        shareSuccess = true;
      } else if (result.error === 'TOKEN_EXPIRED') {
        throw new Error('Token expired during process');
      } else {
        retryCount++;
        if (retryCount === MAX_RETRIES) {
          failed++;
          errors.push({ share: i, error: result.error });
        } else {
          console.log(`Retrying share ${i} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
          await sleep(2000 * retryCount);
        }
      }
    }
    
    // Random delay between shares to avoid rate limiting
    if (i < limit) {
      const delay = 1000 + Math.random() * 2000;
      await sleep(delay);
    }
  }
  
  return { success, failed, total: limit, errors };
}

// ==================== ROUTES ====================
// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: '2.0.0'
  });
});

// Main API endpoint
app.get('/api/shirr', async (req, res) => {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    // Get parameters from query string
    let { cookie, link, limit } = req.query;
    
    console.log(`\n[${requestId}] 📥 New request received`);
    console.log(`[${requestId}] Link: ${link}`);
    console.log(`[${requestId}] Limit: ${limit}`);
    console.log(`[${requestId}] Cookie: ${cookie?.substring(0, 50)}...`);
    
    // ===== VALIDATION =====
    if (!cookie) {
      return res.status(400).json({
        status: false,
        error: 'MISSING_COOKIE',
        message: 'Cookie parameter is required',
        example: '/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10',
        request_id: requestId
      });
    }
    
    if (!link) {
      return res.status(400).json({
        status: false,
        error: 'MISSING_LINK',
        message: 'Link parameter is required',
        example: '/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10',
        request_id: requestId
      });
    }
    
    if (!limit) {
      return res.status(400).json({
        status: false,
        error: 'MISSING_LIMIT',
        message: 'Limit parameter is required',
        example: '/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10',
        request_id: requestId
      });
    }
    
    // Parse and validate limit
    let shareLimit = parseInt(limit, 10);
    if (isNaN(shareLimit) || shareLimit < 1) {
      return res.status(400).json({
        status: false,
        error: 'INVALID_LIMIT',
        message: 'Limit must be a positive number (minimum 1)',
        request_id: requestId
      });
    }
    
    if (shareLimit > MAX_SHARE_LIMIT) {
      return res.status(400).json({
        status: false,
        error: 'LIMIT_EXCEEDED',
        message: `Maximum limit is ${MAX_SHARE_LIMIT} shares per request`,
        max_allowed: MAX_SHARE_LIMIT,
        request_id: requestId
      });
    }
    
    // Validate URL
    if (!validateFacebookUrl(link)) {
      return res.status(400).json({
        status: false,
        error: 'INVALID_URL',
        message: 'Please provide a valid Facebook post URL (must contain facebook.com or fb.com)',
        request_id: requestId
      });
    }
    
    // Validate cookie format
    if (!validateCookie(cookie)) {
      return res.status(400).json({
        status: false,
        error: 'INVALID_COOKIE',
        message: 'Cookie must contain "c_user" and "xs" values. Get valid cookie from Facebook after login.',
        request_id: requestId
      });
    }
    
    // ===== TOKEN EXTRACTION =====
    console.log(`[${requestId}] 🔑 Extracting token...`);
    const token = await extractTokenWithRetry(cookie);
    
    if (!token) {
      return res.status(401).json({
        status: false,
        error: 'TOKEN_EXTRACTION_FAILED',
        message: 'Failed to extract access token. Your cookie might be expired or invalid. Please refresh your Facebook cookie.',
        request_id: requestId
      });
    }
    
    console.log(`[${requestId}] ✅ Token extracted successfully`);
    
    // ===== PERFORM SHARES =====
    console.log(`[${requestId}] 📤 Starting ${shareLimit} shares...`);
    const results = await performShares(link, token, cookie, shareLimit);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // ===== RESPONSE =====
    const response = {
      status: results.success > 0,
      request_id: requestId,
      endpoint: '/api/shirr',
      method: 'GET',
      parameters: {
        cookie: '***hidden***',
        link: link,
        limit: shareLimit
      },
      summary: {
        total_requested: shareLimit,
        successful: results.success,
        failed: results.failed,
        success_rate: `${((results.success / shareLimit) * 100).toFixed(2)}%`
      },
      duration_seconds: parseFloat(duration),
      timestamp: new Date().toISOString()
    };
    
    // Add errors if any (only first 3 for clean response)
    if (results.errors.length > 0) {
      response.errors = results.errors.slice(0, 3);
      response.warning = `${results.errors.length} share(s) failed. Check 'errors' array for details.`;
    }
    
    console.log(`[${requestId}] ✅ Completed: ${results.success}/${shareLimit} successful in ${duration}s`);
    res.json(response);
    
  } catch (error) {
    console.error(`[${requestId}] ❌ Server error:`, error.message);
    res.status(500).json({
      status: false,
      error: 'SERVER_ERROR',
      message: 'Internal server error occurred. Please try again later.',
      request_id: requestId,
      timestamp: new Date().toISOString()
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: false,
    error: 'NOT_FOUND',
    message: 'Endpoint not found. Use /api/shirr for sharing or /api/health for health check',
    available_endpoints: [
      'GET /',
      'GET /api/health',
      'GET /api/shirr?cookie=&link=&limit='
    ]
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.message);
  res.status(500).json({
    status: false,
    error: 'SERVER_ERROR',
    message: 'An unexpected error occurred'
  });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('\n=================================');
  console.log('🚀 Facebook Share API Server');
  console.log('=================================');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log('\n📌 Available Endpoints:');
  console.log(`   🏠 Home: http://localhost:${PORT}/`);
  console.log(`   💚 Health: http://localhost:${PORT}/api/health`);
  console.log(`   📤 Share API: http://localhost:${PORT}/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10`);
  console.log('\n⚙️ Configuration:');
  console.log(`   Max share limit: ${MAX_SHARE_LIMIT}`);
  console.log(`   Request timeout: ${REQUEST_TIMEOUT/1000}s`);
  console.log(`   Max retries: ${MAX_RETRIES}`);
  console.log('\n📝 Press Ctrl+C to stop\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  process.exit(0);
});