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

// Rate limiting - more permissive for first request
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // Increased from 10 to 30
  message: { status: false, message: 'Too many requests, please slow down' }
});
app.use('/api/', limiter);

// ==================== CONFIGURATION ====================
const MAX_SHARE_LIMIT = 50;
const REQUEST_TIMEOUT = 30000; // Increased timeout
const MAX_RETRIES = 5; // Increased retries

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
];

// Store for tracking request states
const activeRequests = new Map();

// ==================== HELPER FUNCTIONS ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Validate Facebook URL
const validateFacebookUrl = (url) => {
  if (!url) return false;
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

// Clean up old active requests
setInterval(() => {
  const now = Date.now();
  for (const [id, request] of activeRequests.entries()) {
    if (now - request.startTime > 300000) {
      activeRequests.delete(id);
      console.log(`Cleaned up stale request: ${id}`);
    }
  }
}, 60000);

// ==================== IMPROVED TOKEN EXTRACTION ====================
async function extractToken(cookie, ua, requestId) {
  try {
    console.log(`[${requestId}] Sending token extraction request to Facebook...`);
    
    const response = await axios.get(
      "https://business.facebook.com/business_locations",
      {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cookie": cookie,
          "Referer": "https://www.facebook.com/",
          "Connection": "keep-alive",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-site",
          "Upgrade-Insecure-Requests": "1"
        },
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 5,
        validateStatus: function (status) {
          return status >= 200 && status < 500;
        }
      }
    );

    console.log(`[${requestId}] Token endpoint response status: ${response.status}`);

    if (response.status === 403 || response.status === 401) {
      console.log(`[${requestId}] Authentication failed with status: ${response.status}`);
      return null;
    }

    // Comprehensive token patterns
    const tokenPatterns = [
          /"accessToken":"(EA[A-Za-z0-9]+)"/,
          /"access_token":"(EA[A-Za-z0-9]+)"/,
          /access_token=([A-Za-z0-9]+)/,
          /EAAG[A-Za-z0-9]+/,
          /EAA[A-Za-z0-9]{15,}/,
          /"token":"(EA[A-Za-z0-9]+)"/,
          /"EAAG\w+"/,
          /'EAAG\w+'/,
          /EAAAA[A-Za-z0-9]+/,
          /EAAH[A-Za-z0-9]+/
    ];

    for (const pattern of tokenPatterns) {
      const match = response.data.match(pattern);
      if (match) {
        let token = match[1] || match[0];
        // Clean token from quotes if present
        token = token.replace(/['"]/g, '');
        if (token && token.length > 15 && token.startsWith('EA')) {
          console.log(`[${requestId}] ✓ Token extracted successfully! Length: ${token.length}`);
          console.log(`[${requestId}] Token preview: ${token.substring(0, 20)}...`);
          return token;
        }
      }
    }

    console.log(`[${requestId}] No valid token pattern matched in response`);
    return null;
    
  } catch (err) {
    console.error(`[${requestId}] Token extraction error:`, err.message);
    return null;
  }
}

// Token extraction with aggressive retry
async function extractTokenWithRetry(cookie, requestId) {
  console.log(`[${requestId}] Starting token extraction with ${MAX_RETRIES} attempts...`);
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ua = getRandomUserAgent();
    console.log(`[${requestId}] Token extraction attempt ${attempt}/${MAX_RETRIES} with UA: ${ua.substring(0, 30)}...`);
    
    const token = await extractToken(cookie, ua, requestId);
    if (token && token.length > 15 && token.startsWith('EA')) {
      console.log(`[${requestId}] ✅ Token extraction SUCCESS on attempt ${attempt}!`);
      return token;
    }
    
    if (attempt < MAX_RETRIES) {
      const delay = 2000 * attempt;
      console.log(`[${requestId}] Token extraction failed, waiting ${delay/1000}s before retry ${attempt + 1}...`);
      await sleep(delay);
    }
  }
  
  console.log(`[${requestId}] ❌ All ${MAX_RETRIES} token extraction attempts failed`);
  return null;
}

// ==================== IMPROVED SHARE FUNCTION ====================
async function performSingleShare(postLink, token, cookie, ua, shareNumber, totalLimit, requestId) {
  try {
    console.log(`[${requestId}] Sending share ${shareNumber}/${totalLimit} request...`);
    
    const response = await axios.post(
      "https://graph.facebook.com/v18.0/me/feed",
      null,
      {
        params: {
          link: postLink,
          access_token: token,
          published: 0,
          no_story: false
        },
        headers: {
          "User-Agent": ua,
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookie,
          "Origin": "https://business.facebook.com",
          "Referer": "https://business.facebook.com/",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors"
        },
        timeout: REQUEST_TIMEOUT
      }
    );

    if (response.data && (response.data.id || response.data.post_id)) {
      const postId = response.data.id || response.data.post_id;
      console.log(`[${requestId}] ✓ Share ${shareNumber}/${totalLimit} SUCCESS! Post ID: ${postId}`);
      return { success: true, id: postId };
    } else {
      console.log(`[${requestId}] Share ${shareNumber}/${totalLimit} - Invalid response format`);
      return { success: false, error: 'Invalid response format', errorType: 'INVALID_RESPONSE' };
    }
    
  } catch (err) {
    let errorMsg = err.message;
    let errorType = 'UNKNOWN';
    
    if (err.response) {
      errorMsg = err.response.data?.error?.message || err.response.statusText || err.message;
      errorType = `HTTP_${err.response.status}`;
      
      if (err.response.status === 401) {
        errorType = 'TOKEN_EXPIRED';
        errorMsg = 'Token expired or invalid';
      } else if (err.response.status === 429) {
        errorType = 'RATE_LIMITED';
        errorMsg = 'Rate limited by Facebook';
      } else if (err.response.status === 403) {
        errorType = 'PERMISSION_DENIED';
        errorMsg = 'Permission denied - insufficient privileges';
      } else if (err.response.status === 400) {
        errorType = 'BAD_REQUEST';
        errorMsg = err.response.data?.error?.message || 'Invalid request';
      }
    }
    
    console.log(`[${requestId}] ✗ Share ${shareNumber}/${totalLimit} FAILED: ${errorType} - ${errorMsg.substring(0, 100)}`);
    
    return { success: false, error: errorMsg, errorType: errorType };
  }
}

// Perform shares with aggressive retry and recovery
async function performShares(postLink, token, cookie, limit, requestId) {
  let success = 0;
  let failed = 0;
  const errors = [];
  let tokenExpired = false;
  let currentToken = token;
  const ua = getRandomUserAgent();
  
  console.log(`[${requestId}] Starting ${limit} shares with ${MAX_RETRIES} retries each...`);
  
  for (let i = 1; i <= limit; i++) {
    if (tokenExpired) {
      console.log(`[${requestId}] Stopping shares due to token expiration at ${i}/${limit}`);
      break;
    }
    
    let shareSuccess = false;
    let retryCount = 0;
    
    while (!shareSuccess && retryCount < MAX_RETRIES && !tokenExpired) {
      const result = await performSingleShare(postLink, currentToken, cookie, ua, i, limit, requestId);
      
      if (result.success) {
        success++;
        shareSuccess = true;
        console.log(`[${requestId}] Progress: ${success}/${limit} successful so far`);
      } else {
        if (result.errorType === 'TOKEN_EXPIRED') {
          tokenExpired = true;
          console.log(`[${requestId}] Token expired during share ${i}`);
          break;
        }
        
        retryCount++;
        if (retryCount === MAX_RETRIES) {
          failed++;
          errors.push({ share: i, error: result.error, errorType: result.errorType });
          console.log(`[${requestId}] Share ${i} failed after ${MAX_RETRIES} attempts`);
        } else {
          const retryDelay = 3000 * retryCount;
          console.log(`[${requestId}] Retrying share ${i} in ${retryDelay/1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
          await sleep(retryDelay);
        }
      }
    }
    
    // Dynamic delay between shares
    if (i < limit && !tokenExpired) {
      const delay = 2000 + Math.random() * 3000;
      console.log(`[${requestId}] Waiting ${Math.round(delay/1000)}s before next share...`);
      await sleep(delay);
    }
  }
  
  return { 
    success, 
    failed, 
    total: limit, 
    errors,
    tokenExpired,
    completed: success + failed
  };
}

// ==================== ROUTES ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: '2.1.0',
    active_requests: activeRequests.size
  });
});

// MAIN API ENDPOINT - OPTIMIZED FOR FIRST REQUEST
app.get('/api/shirr', async (req, res) => {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7).toUpperCase();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${requestId}] 🚀 NEW REQUEST STARTED`);
  console.log(`${'='.repeat(60)}`);
  console.log(`[${requestId}] Time: ${new Date().toLocaleString()}`);
  console.log(`[${requestId}] Parameters received:`);
  console.log(`[${requestId}]   - Link: ${req.query.link || 'NOT PROVIDED'}`);
  console.log(`[${requestId}]   - Limit: ${req.query.limit || 'NOT PROVIDED'}`);
  console.log(`[${requestId}]   - Cookie: ${req.query.cookie ? req.query.cookie.substring(0, 60) + '...' : 'NOT PROVIDED'}`);
  
  // Track this request
  activeRequests.set(requestId, { startTime, status: 'processing' });
  
  try {
    let { cookie, link, limit } = req.query;
    
    // ===== ENHANCED VALIDATION WITH CLEAR MESSAGES =====
    if (!cookie) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Validation failed: Missing cookie`);
      return res.status(400).json({
        status: false,
        error: 'MISSING_COOKIE',
        message: 'Cookie is required. Please provide your Facebook cookie.',
        fix: 'Get cookie from browser: F12 → Console → document.cookie',
        example: '/api/shirr?cookie=c_user=123;xs=456&link=https://facebook.com/post&limit=5',
        request_id: requestId
      });
    }
    
    if (!link) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Validation failed: Missing link`);
      return res.status(400).json({
        status: false,
        error: 'MISSING_LINK',
        message: 'Post link is required. Please provide a Facebook post URL.',
        example: '/api/shirr?cookie=YOUR_COOKIE&link=https://facebook.com/post&limit=5',
        request_id: requestId
      });
    }
    
    if (!limit) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Validation failed: Missing limit`);
      return res.status(400).json({
        status: false,
        error: 'MISSING_LIMIT',
        message: 'Share limit is required. How many shares do you want?',
        example: '/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=5',
        request_id: requestId
      });
    }
    
    let shareLimit = parseInt(limit, 10);
    if (isNaN(shareLimit) || shareLimit < 1) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Validation failed: Invalid limit - ${limit}`);
      return res.status(400).json({
        status: false,
        error: 'INVALID_LIMIT',
        message: 'Limit must be a positive number (1-50)',
        provided: limit,
        request_id: requestId
      });
    }
    
    if (shareLimit > MAX_SHARE_LIMIT) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Validation failed: Limit exceeded - ${shareLimit}`);
      return res.status(400).json({
        status: false,
        error: 'LIMIT_EXCEEDED',
        message: `Maximum limit is ${MAX_SHARE_LIMIT} shares per request`,
        max_allowed: MAX_SHARE_LIMIT,
        provided: shareLimit,
        request_id: requestId
      });
    }
    
    if (!validateFacebookUrl(link)) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Validation failed: Invalid Facebook URL - ${link}`);
      return res.status(400).json({
        status: false,
        error: 'INVALID_URL',
        message: 'Please provide a valid Facebook post URL',
        example: 'https://www.facebook.com/username/posts/123456789',
        provided: link,
        request_id: requestId
      });
    }
    
    if (!validateCookie(cookie)) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Validation failed: Invalid cookie format`);
      return res.status(400).json({
        status: false,
        error: 'INVALID_COOKIE',
        message: 'Cookie format invalid. Cookie must contain "c_user" and "xs".',
        how_to_fix: '1. Login to Facebook\n2. Open DevTools (F12)\n3. Go to Console\n4. Type: document.cookie\n5. Copy the entire string',
        request_id: requestId
      });
    }
    
    console.log(`[${requestId}] ✅ All validations passed!`);
    
    // ===== TOKEN EXTRACTION =====
    console.log(`[${requestId}] 🔑 Extracting access token...`);
    const token = await extractTokenWithRetry(cookie, requestId);
    
    if (!token) {
      activeRequests.delete(requestId);
      console.log(`[${requestId}] ❌ Token extraction failed after ${MAX_RETRIES} attempts`);
      return res.status(401).json({
        status: false,
        error: 'TOKEN_EXTRACTION_FAILED',
        message: 'Could not extract access token from Facebook. Your cookie may be expired or invalid.',
        solution: 'Get a fresh cookie: Logout → Login to Facebook → Copy new cookie',
        request_id: requestId,
        attempts: MAX_RETRIES
      });
    }
    
    console.log(`[${requestId}] ✅ Token extracted: ${token.substring(0, 30)}...`);
    
    // ===== PERFORM SHARES =====
    console.log(`[${requestId}] 📤 Starting ${shareLimit} shares...`);
    const results = await performShares(link, token, cookie, shareLimit, requestId);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // ===== SUCCESS RESPONSE =====
    const response = {
      status: results.success > 0,
      request_id: requestId,
      message: results.success > 0 ? 'Shares completed successfully' : 'All shares failed',
      summary: {
        total_requested: shareLimit,
        successful: results.success,
        failed: results.failed,
        completed: results.completed,
        success_rate: `${((results.success / shareLimit) * 100).toFixed(2)}%`
      },
      duration_seconds: parseFloat(duration),
      performance: {
        shares_per_second: (results.completed / duration).toFixed(2),
        average_time_per_share: (duration / results.completed || 0).toFixed(2)
      },
      timestamp: new Date().toISOString()
    };
    
    if (results.success === 0) {
      response.suggestion = 'Try with a smaller limit (5-10) or refresh your cookie';
    }
    
    if (results.errors.length > 0) {
      response.errors = results.errors.slice(0, 3);
      if (results.errors.length > 3) {
        response.warning = `${results.errors.length} shares failed. First 3 errors shown.`;
      }
    }
    
    console.log(`${'='.repeat(60)}`);
    console.log(`[${requestId}] ✅ REQUEST COMPLETED SUCCESSFULLY`);
    console.log(`[${requestId}] Results: ${results.success}/${shareLimit} successful`);
    console.log(`[${requestId}] Duration: ${duration}s`);
    console.log(`[${requestId}] Speed: ${response.performance.shares_per_second} shares/sec`);
    console.log(`${'='.repeat(60)}\n`);
    
    activeRequests.delete(requestId);
    res.json(response);
    
  } catch (error) {
    console.error(`[${requestId}] ❌ UNEXPECTED ERROR:`, error.message);
    console.error(error.stack);
    
    activeRequests.delete(requestId);
    
    res.status(500).json({
      status: false,
      error: 'SERVER_ERROR',
      message: 'Internal server error occurred',
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
    message: 'Endpoint not found. Use /api/shirr for sharing.',
    available_endpoints: ['GET /', 'GET /api/health', 'GET /api/shirr?cookie=&link=&limit=']
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Global error:', err.message);
  res.status(500).json({
    status: false,
    error: 'SERVER_ERROR',
    message: 'An unexpected error occurred'
  });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 FACEBOOK SHARE API v2.1 - FIRST REQUEST FIXED');
  console.log('='.repeat(60));
  console.log(`📡 Server running on: http://localhost:${PORT}`);
  console.log(`🌐 Test interface: http://localhost:${PORT}`);
  console.log(`💚 Health check: http://localhost:${PORT}/api/health`);
  console.log(`\n📌 API Usage Example:`);
  console.log(`   http://localhost:${PORT}/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=5`);
  console.log(`\n⚙️ Configuration:`);
  console.log(`   ✓ Max shares: ${MAX_SHARE_LIMIT}`);
  console.log(`   ✓ Max retries: ${MAX_RETRIES}`);
  console.log(`   ✓ Timeout: ${REQUEST_TIMEOUT/1000}s`);
  console.log(`   ✓ Rate limit: 30 requests/minute`);
  console.log(`\n💡 First request optimization:`);
  console.log(`   ✓ Increased timeout to 30s`);
  console.log(`   ✓ Aggressive retry mechanism (5 attempts)`);
  console.log(`   ✓ Better token extraction patterns`);
  console.log(`   ✓ Detailed request logging`);
  console.log(`\n✨ Ready to accept requests! ✨`);
  console.log('='.repeat(60) + '\n');
});