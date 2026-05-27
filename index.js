const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { status: false, message: 'Too many requests, please slow down' }
});
app.use('/api/', limiter);

// Configuration
const MAX_SHARE_LIMIT = 50;
const REQUEST_TIMEOUT = 20000;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Extract token from cookie
async function extractToken(cookie, ua) {
  try {
    const response = await axios.get(
      "https://business.facebook.com/business_locations",
      {
        headers: {
          "user-agent": ua,
          "referer": "https://www.facebook.com/",
          "Cookie": cookie,
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
        },
        timeout: REQUEST_TIMEOUT
      }
    );

    const patterns = [/(EAAG\w+)/, /(EAA[A-Za-z0-9]+)/, /access_token=([^&\s"]+)/];
    for (const pattern of patterns) {
      const match = response.data.match(pattern);
      if (match) return match[1];
    }
    return null;
  } catch (err) {
    console.error('Token extraction failed:', err.message);
    return null;
  }
}

// Perform share
async function performShares(postLink, token, cookie, ua, limit) {
  let success = 0;
  let failed = 0;
  const errors = [];

  for (let i = 1; i <= limit; i++) {
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
            "user-agent": ua,
            "Cookie": cookie,
            "accept": "application/json, text/plain, */*"
          },
          timeout: REQUEST_TIMEOUT
        }
      );

      if (response.data && response.data.id) {
        success++;
        console.log(`✓ Share ${i}/${limit} successful: ${response.data.id}`);
      }
      
      await sleep(1000);
      
    } catch (err) {
      failed++;
      const errorMsg = err.response?.data?.error?.message || err.message;
      errors.push({ share: i, error: errorMsg });
      console.error(`✗ Share ${i}/${limit} failed:`, errorMsg);
      
      if (err.response?.status === 429) {
        console.log('Rate limited, waiting 10 seconds...');
        await sleep(10000);
      }
    }
  }
  
  return { success, failed, total: limit, errors };
}

// ========== MAIN GET ENDPOINT ==========
// URL Format: http://localhost.com/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10
app.get("/api/shirr", async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Get parameters from query string
    let { cookie, link, limit } = req.query;
    
    console.log("📥 Received request:", { cookie: cookie?.substring(0, 50) + "...", link, limit });
    
    // ===== VALIDATION =====
    if (!cookie) {
      return res.status(400).json({
        status: false,
        error: "MISSING_COOKIE",
        message: "Cookie parameter is required",
        example: "/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10"
      });
    }
    
    if (!link) {
      return res.status(400).json({
        status: false,
        error: "MISSING_LINK",
        message: "Link parameter is required",
        example: "/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10"
      });
    }
    
    if (!limit) {
      return res.status(400).json({
        status: false,
        error: "MISSING_LIMIT",
        message: "Limit parameter is required",
        example: "/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10"
      });
    }
    
    // Parse and validate limit
    let shareLimit = parseInt(limit, 10);
    if (isNaN(shareLimit) || shareLimit < 1) {
      return res.status(400).json({
        status: false,
        error: "INVALID_LIMIT",
        message: "Limit must be a positive number (minimum 1)"
      });
    }
    
    if (shareLimit > MAX_SHARE_LIMIT) {
      return res.status(400).json({
        status: false,
        error: "LIMIT_EXCEEDED",
        message: `Maximum limit is ${MAX_SHARE_LIMIT} shares per request`,
        max_allowed: MAX_SHARE_LIMIT
      });
    }
    
    // Validate URL
    if (!link.includes('facebook.com') && !link.includes('fb.com')) {
      return res.status(400).json({
        status: false,
        error: "INVALID_URL",
        message: "Please provide a valid Facebook post URL"
      });
    }
    
    // Validate cookie format
    if (!cookie.includes('c_user') || !cookie.includes('xs')) {
      return res.status(400).json({
        status: false,
        error: "INVALID_COOKIE",
        message: "Cookie must contain 'c_user' and 'xs' values"
      });
    }
    
    // Select random user agent
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    
    // ===== EXTRACT TOKEN =====
    console.log("🔑 Extracting token...");
    const token = await extractToken(cookie, ua);
    
    if (!token) {
      return res.status(401).json({
        status: false,
        error: "TOKEN_EXTRACTION_FAILED",
        message: "Failed to extract access token. Your cookie might be expired or invalid."
      });
    }
    
    console.log("✅ Token extracted successfully");
    
    // ===== PERFORM SHARES =====
    console.log(`📤 Starting ${shareLimit} shares...`);
    const results = await performShares(link, token, cookie, ua, shareLimit);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    // ===== RESPONSE =====
    const response = {
      status: results.success > 0,
      endpoint: "/api/shirr",
      method: "GET",
      parameters: {
        cookie: "***hidden***",
        link: link,
        limit: shareLimit
      },
      summary: {
        total_requested: shareLimit,
        successful: results.success,
        failed: results.failed,
        success_rate: `${((results.success / shareLimit) * 100).toFixed(2)}%`
      },
      duration_seconds: duration,
      timestamp: new Date().toISOString()
    };
    
    // Add errors if any (only first 3 for clean response)
    if (results.errors.length > 0) {
      response.errors = results.errors.slice(0, 3);
    }
    
    console.log(`✅ Completed: ${results.success}/${shareLimit} successful in ${duration}s`);
    res.json(response);
    
  } catch (error) {
    console.error("❌ Server error:", error.message);
    res.status(500).json({
      status: false,
      error: "SERVER_ERROR",
      message: "Internal server error occurred",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`\n📌 USAGE EXAMPLES:`);
  console.log(`1. Health check:`);
  console.log(`   GET http://localhost:${PORT}/api/health`);
  console.log(`\n2. Share API (GET Method):`);
  console.log(`   GET http://localhost:${PORT}/api/shirr?cookie=YOUR_COOKIE&link=POST_URL&limit=10`);
  console.log(`\n3. Example with real values:`);
  console.log(`   GET http://localhost:${PORT}/api/shirr?cookie=c_user=123456;xs=abc123&link=https://facebook.com/post/123&limit=5`);
  console.log(`\n📝 NOTE: Maximum limit is ${MAX_SHARE_LIMIT} shares per request\n`);
});