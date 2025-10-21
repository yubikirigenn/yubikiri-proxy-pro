// ===== 1. DEPENDENCIES =====
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const url = require('url');
const fs = require('fs');
require('dotenv').config();

// ===== 2. INITIALIZATION =====
const app = express();
const PORT = process.env.PORT || 3000;

// 変数宣言（ファイル内で一度だけ）
let browser;
let puppeteer;
let xLoginPage = null;
let cachedXCookies = null;

const COOKIE_FILE = path.join(__dirname, '.x-cookies.json');

// ===== 3. COOKIE PERSISTENCE FUNCTIONS =====
function saveCookiesToFile(cookies) {
  try {
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    console.log('💾 Cookies saved to file');
  } catch (e) {
    console.error('❌ Failed to save cookies:', e.message);
  }
}

function loadCookiesFromFile() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const data = fs.readFileSync(COOKIE_FILE, 'utf8');
      const cookies = JSON.parse(data);
      console.log('📂 Cookies loaded from file');
      return cookies;
    }
  } catch (e) {
    console.error('❌ Failed to load cookies:', e.message);
  }
  return null;
}

// Load cookies on startup
cachedXCookies = loadCookiesFromFile();
if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0) {
  console.log('✅ Cached cookies restored from file');
  console.log(`   Cookie count: ${cachedXCookies.length}`);
}

// ===== 4. MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// ===== 5. UTILITY FUNCTIONS =====
function encodeProxyUrl(targetUrl) {
  return Buffer.from(targetUrl).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeProxyUrl(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function rewriteHTML(html, baseUrl) {
  const urlObj = new url.URL(baseUrl);
  const origin = `${urlObj.protocol}//${urlObj.host}`;
  const proxyOrigin = process.env.RENDER ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : `http://localhost:${PORT}`;

  // href書き換え
  html = html.replace(/href\s*=\s*["']([^"']+)["']/gi, (match, href) => {
    if (href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return match;
    }
    
    let absoluteUrl = href;
    try {
      if (href.startsWith('//')) {
        absoluteUrl = urlObj.protocol + href;
      } else if (href.startsWith('/')) {
        absoluteUrl = origin + href;
      } else if (!href.startsWith('http')) {
        absoluteUrl = new url.URL(href, baseUrl).href;
      }
      return `href="/proxy/${encodeProxyUrl(absoluteUrl)}"`;
    } catch (e) {
      return match;
    }
  });

  // src書き換え
  html = html.replace(/src\s*=\s*["']([^"']+)["']/gi, (match, src) => {
    if (src.startsWith('data:') || src.startsWith('blob:')) {
      return match;
    }
    
    let absoluteUrl = src;
    try {
      if (src.startsWith('//')) {
        absoluteUrl = urlObj.protocol + src;
      } else if (src.startsWith('/')) {
        absoluteUrl = origin + src;
      } else if (!src.startsWith('http')) {
        absoluteUrl = new url.URL(src, baseUrl).href;
      }
      return `src="/proxy/${encodeProxyUrl(absoluteUrl)}"`;
    } catch (e) {
      return match;
    }
  });

  // action書き換え
  html = html.replace(/action\s*=\s*["']([^"']+)["']/gi, (match, action) => {
    let absoluteUrl = action;
    try {
      if (action.startsWith('//')) {
        absoluteUrl = urlObj.protocol + action;
      } else if (action.startsWith('/')) {
        absoluteUrl = origin + action;
      } else if (!action.startsWith('http')) {
        absoluteUrl = new url.URL(action, baseUrl).href;
      }
      return `action="/proxy/${encodeProxyUrl(absoluteUrl)}"`;
    } catch (e) {
      return match;
    }
  });

  // インターセプトスクリプト
  const interceptScript = `
    <script>
      (function() {
        const PROXY_ORIGIN = '${proxyOrigin}';
        const TARGET_ORIGIN = '${origin}';
        
        console.log('[Proxy] Initializing for', TARGET_ORIGIN);
        
        Object.defineProperty(window, 'google', {
          get: () => undefined,
          set: () => false,
          configurable: false
        });
        
        Object.defineProperty(window, 'gapi', {
          get: () => undefined,
          set: () => false,
          configurable: false
        });
        
        function toAbsoluteUrl(relativeUrl) {
          if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
            return relativeUrl;
          }
          if (relativeUrl.startsWith('//')) {
            return 'https:' + relativeUrl;
          }
          if (relativeUrl.startsWith('/')) {
            return TARGET_ORIGIN + relativeUrl;
          }
          return TARGET_ORIGIN + '/' + relativeUrl;
        }
        
        function encodeProxyUrl(url) {
          const base64 = btoa(url).replace(/\\+/g, '-').replace(/\\\//g, '_').replace(/=/g, '');
          return PROXY_ORIGIN + '/proxy/' + base64;
        }
        
        function isAlreadyProxied(url) {
          return url.includes(PROXY_ORIGIN) || url.startsWith('/proxy/');
        }
        
        const originalFetch = window.fetch;
        window.fetch = function(resource, options) {
          let url = typeof resource === 'string' ? resource : (resource.url || resource);
          
          if (url.includes('google.com') || url.includes('gstatic.com')) {
            console.log('[Proxy] Blocked:', url);
            return Promise.reject(new Error('Blocked'));
          }
          
          if (url.startsWith('blob:') || url.startsWith('data:')) {
            return originalFetch.call(this, resource, options);
          }
          
          if (isAlreadyProxied(url)) {
            return originalFetch.call(this, resource, options);
          }
          
          const absoluteUrl = toAbsoluteUrl(url);
          
          if (absoluteUrl.startsWith('http')) {
            const proxyUrl = encodeProxyUrl(absoluteUrl);
            console.log('[Proxy] Fetch:', url, '->', proxyUrl);
            
            const newOptions = Object.assign({}, options);
            if (newOptions.mode === 'cors') {
              delete newOptions.mode;
            }
            
            if (typeof resource === 'string') {
              return originalFetch.call(this, proxyUrl, newOptions);
            } else {
              return originalFetch.call(this, new Request(proxyUrl, newOptions));
            }
          }
          
          return originalFetch.call(this, resource, options);
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (typeof url === 'string') {
            if (url.includes('google.com') || url.includes('gstatic.com')) {
              console.log('[Proxy] Blocked XHR:', url);
              throw new Error('Blocked');
            }
            
            if (!url.startsWith('blob:') && !url.startsWith('data:')) {
              if (!isAlreadyProxied(url)) {
                const absoluteUrl = toAbsoluteUrl(url);
                if (absoluteUrl.startsWith('http')) {
                  const proxyUrl = encodeProxyUrl(absoluteUrl);
                  console.log('[Proxy] XHR:', url, '->', proxyUrl);
                  return originalOpen.call(this, method, proxyUrl, ...rest);
                }
              }
            }
          }
          
          return originalOpen.call(this, method, url, ...rest);
        };

        const originalError = console.error;
        console.error = function(...args) {
          const msg = args.join(' ');
          if (msg.includes('GSI') || msg.includes('google')) return;
          return originalError.apply(console, args);
        };

        console.warn = () => {};
        
        console.log('[Proxy] Intercept initialized');
      })();
    </script>
  `;

  html = html.replace(/<head[^>]*>/i, (match) => match + interceptScript);
  
  html = html.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*src=[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe[^>]*google[^>]*>[\s\S]*?<\/iframe>/gi, '');

  if (!html.includes('charset')) {
    html = html.replace(/<head[^>]*>/i, '<head><meta charset="UTF-8">');
  }

  return html;
}

// ===== 6. PUPPETEER FUNCTIONS =====
async function loadPuppeteer() {
  if (process.env.RENDER) {
    const puppeteerCore = require('puppeteer-core');
    const chromium = require('@sparticuz/chromium');
    return { puppeteerCore, chromium, isRender: true };
  } else {
    const puppeteerLib = require('puppeteer');
    return { puppeteerCore: puppeteerLib, chromium: null, isRender: false };
  }
}

async function initBrowser() {
  if (!browser) {
    try {
      if (!puppeteer) {
        puppeteer = await loadPuppeteer();
      }

      let launchConfig;
      if (puppeteer.isRender) {
        const chromium = puppeteer.chromium;
        launchConfig = {
          args: [
            ...chromium.args,
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process'
          ],
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        };
      } else {
        launchConfig = {
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process'
          ]
        };
      }

      browser = await puppeteer.puppeteerCore.launch(launchConfig);
      console.log('✅ Browser initialized');
    } catch (error) {
      console.error('❌ Browser launch failed:', error.message);
      throw error;
    }
  }
  return browser;
}

async function initXLoginPage() {
  const browserInstance = await initBrowser();
  const page = await browserInstance.newPage();

  await page.setViewport({ 
    width: 1920, 
    height: 1080,
    deviceScaleFactor: 1
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  });

  await page.setRequestInterception(true);
  page.removeAllListeners('request');
  
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    
    const requestUrl = request.url();
    if (requestUrl.includes('google.com') || 
        requestUrl.includes('gstatic.com') ||
        requestUrl.includes('googleapis.com')) {
      request.abort().catch(() => {});
      return;
    }
    
    request.continue().catch(() => {});
  });

  await page.evaluateOnNewDocument(() => {
    delete Object.getPrototypeOf(navigator).webdriver;
    
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: false
    });

    window.chrome = {
      app: { isInstalled: false },
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
    };

    Object.defineProperty(window, 'google', {
      get() { return undefined; },
      set() { return false; },
      configurable: false
    });

    Object.defineProperty(window, 'gapi', {
      get() { return undefined; },
      set() { return false; },
      configurable: false
    });

    const originalError = console.error;
    const originalWarn = console.warn;
    
    console.error = function(...args) {
      const msg = args.join(' ');
      if (msg.includes('GSI') || msg.includes('google')) return;
      return originalError.apply(console, args);
    };

    console.warn = function(...args) {
      const msg = args.join(' ');
      if (msg.includes('GSI') || msg.includes('google')) return;
      return originalWarn.apply(console, args);
    };

    window.addEventListener('unhandledrejection', (event) => {
      const msg = String(event.reason);
      if (msg.includes('google') || msg.includes('GSI')) {
        event.preventDefault();
      }
    });

    console.log('[Ultra-Stealth] Initialized');
  });

  console.log('✅ X login page initialized with ultra-stealth mode');
  return page;
}

// Initialize xLoginPage with cached cookies
(async () => {
  if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0) {
    try {
      console.log('🔄 Initializing xLoginPage with cached cookies...');
      xLoginPage = await initXLoginPage();
      await xLoginPage.setCookie(...cachedXCookies);
      console.log('✅ xLoginPage initialized with cached cookies');
    } catch (e) {
      console.log('⚠️ Could not initialize xLoginPage:', e.message);
    }
  }
})();

// ===== 7. TEST ENDPOINTS =====
app.get('/test', (req, res) => {
  res.json({ 
    status: 'Routes are working!',
    hasCachedCookies: !!(cachedXCookies && cachedXCookies.length > 0),
    hasXLoginPage: !!xLoginPage
  });
});

app.get('/test-decode/:encoded', (req, res) => {
  try {
    const decoded = decodeProxyUrl(req.params.encoded);
    res.json({ 
      encoded: req.params.encoded, 
      decoded,
      success: true
    });
  } catch (e) {
    res.status(400).json({ 
      error: e.message,
      encoded: req.params.encoded
    });
  }
});

// ===== 8. PROXY ROUTES (CRITICAL: GET route added) =====

// 🔴 CRITICAL: GET proxy route (was missing!)
app.get('/proxy/:encodedUrl*', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 GET Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    };

    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    // Use cached cookies for X.com
    if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0 && 
        (parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com'))) {
      try {
        let cookieString = cachedXCookies
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        headers['Cookie'] = cookieString;
        console.log('🍪 Using cached cookies for GET');
      } catch (e) {
        console.log('⚠️ Cookie mapping error:', e.message);
      }
    } else if (req.headers.cookie) {
      headers['Cookie'] = req.headers.cookie;
    }

    const response = await axios({
      method: 'GET',
      url: targetUrl,
      headers: headers,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    console.log(`📥 GET Response: ${response.status}`);

    const contentType = response.headers['content-type'] || '';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (contentType.includes('text/html')) {
      let htmlContent = response.data.toString('utf-8');
      htmlContent = rewriteHTML(htmlContent, targetUrl);
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(htmlContent);
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }

  } catch (error) {
    console.error('❌ GET Proxy error:', error.message);
    res.status(500).json({ 
      error: error.message,
      url: req.params.encodedUrl
    });
  }
});

// POST proxy route
app.post('/proxy/:encodedUrl*', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 POST Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': req.headers.accept || '*/*',
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    };

    headers['Origin'] = `${parsedUrl.protocol}//${parsedUrl.host}`;
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    // Use cached cookies
    if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0 && 
        (parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com'))) {
      try {
        let cookieString = cachedXCookies
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        headers['Cookie'] = cookieString;
        console.log('🍪 Using cached cookies for POST');
      } catch (e) {
        console.log('⚠️ Cookie mapping error:', e.message);
      }
    } else if (req.headers.cookie) {
      headers['Cookie'] = req.headers.cookie;
    }

    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    // X API用の追加ヘッダー
    if (parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com')) {
      headers['x-twitter-active-user'] = 'yes';
      headers['x-twitter-client-language'] = 'en';
      
      // ct0トークンを追加（CSRF対策）
      if (cachedXCookies && Array.isArray(cachedXCookies)) {
        const ct0Cookie = cachedXCookies.find(c => c.name === 'ct0');
        if (ct0Cookie) {
          headers['x-csrf-token'] = ct0Cookie.value;
          console.log('🔐 Added CSRF token');
        }
      }
    }

    const response = await axios({
      method: 'POST',
      url: targetUrl,
      headers: headers,
      data: req.body,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    console.log(`📥 POST Response: ${response.status}`);

    const contentType = response.headers['content-type'] || '';

    if (response.headers['set-cookie']) {
      res.setHeader('Set-Cookie', response.headers['set-cookie']);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (contentType.includes('text/html')) {
      let htmlPost = response.data.toString('utf-8');
      htmlPost = rewriteHTML(htmlPost, targetUrl);
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(htmlPost);
    } else if (contentType.includes('application/json')) {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }

  } catch (error) {
    console.error('❌ POST Proxy error:', error.message);
    res.status(500).json({ 
      error: error.message,
      url: req.params.encodedUrl
    });
  }
});

// ===== 9. API ROUTES =====

app.post('/api/proxy', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URLが必要です' });
    }

    const encodedUrl = encodeProxyUrl(url);
    res.json({
      success: true,
      redirectUrl: `/proxy/${encodedUrl}`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/x-inject-cookies', async (req, res) => {
  const { authToken, ct0Token } = req.body;

  if (!authToken || !ct0Token) {
    return res.status(400).json({ 
      success: false,
      error: 'authToken and ct0Token are required' 
    });
  }

  try {
    console.log('[API] Injecting X cookies...');

    const cookies = [
      {
        name: 'auth_token',
        value: authToken,
        domain: '.x.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        expires: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      },
      {
        name: 'ct0',
        value: ct0Token,
        domain: '.x.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      }
    ];

    // メモリとファイルの両方に保存
    cachedXCookies = cookies;
    saveCookiesToFile(cookies);
    console.log('[API] ✅ Cookies cached globally and saved to file');

    // xLoginPageの初期化
    if (!xLoginPage) {
      try {
        console.log('[API] Creating xLoginPage...');
        xLoginPage = await initXLoginPage();
        console.log('[API] ✅ xLoginPage created');
      } catch (initError) {
        console.error('[API] ❌ Failed to create xLoginPage:', initError.message);
        return res.json({
          success: true,
          message: 'Cookies cached (xLoginPage creation failed)',
          warning: initError.message,
          cached: true,
          persisted: true,
          hasXLoginPage: false,
          note: 'Cookies will still work in proxy requests'
        });
      }
    }

    // xLoginPageにCookieをセット
    try {
      await xLoginPage.setCookie(...cookies);
      console.log('[API] ✅ Cookies set in xLoginPage');
    } catch (e) {
      console.log('[API] ⚠️ Could not set cookies in page:', e.message);
    }

    // X.comに移動してCookieを有効化
    let currentUrl = 'N/A';
    let allCookies = [];
    let hasAuthToken = false;

    try {
      console.log('[API] Navigating to X.com to activate cookies...');
      await xLoginPage.goto('https://x.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      currentUrl = xLoginPage.url();
      allCookies = await xLoginPage.cookies();
      hasAuthToken = allCookies.some(c => c && c.name === 'auth_token');

      console.log('[API] Current URL:', currentUrl);
      console.log('[API] Has auth_token:', hasAuthToken);
      console.log('[API] Total cookies:', allCookies.length);

      return res.json({
        success: true,
        message: 'Cookies injected, cached, and persisted successfully',
        isLoggedIn: hasAuthToken,
        currentUrl,
        cached: true,
        persisted: true,
        hasXLoginPage: true,
        cookieCount: allCookies.length,
        cookies: allCookies.map(c => ({
          name: c.name,
          domain: c.domain
        })),
        note: 'Cookies will persist across server restarts'
      });

    } catch (navError) {
      console.log('[API] ⚠️ Navigation failed (cookies still cached):', navError.message);
      
      return res.json({
        success: true,
        message: 'Cookies cached and persisted (navigation skipped)',
        warning: navError.message,
        cached: true,
        persisted: true,
        hasXLoginPage: !!xLoginPage,
        cookieCount: cookies.length,
        note: 'Cookies will be used in proxy requests and persist across restarts'
      });
    }

  } catch (error) {
    console.error('[API] Cookie injection error:', error.message);
    console.error('[API] Stack:', error.stack);
    
    if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0) {
      return res.json({
        success: true,
        message: 'Cookies cached (verification skipped)',
        warning: error.message,
        cached: true,
        persisted: true,
        hasXLoginPage: !!xLoginPage
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Cookie injection failed',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.get('/api/x-cookies', async (req, res) => {
  try {
    const hasCachedCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
    
    if (!hasCachedCookies && !xLoginPage) {
      return res.status(400).json({ 
        success: false,
        error: 'No cookies cached. Please inject cookies first.',
        cached: false,
        hasCachedCookies: false,
        hasXLoginPage: false
      });
    }

    let cookies = [];
    let authToken = null;

    if (hasCachedCookies) {
      cookies = cachedXCookies;
      authToken = cookies.find(c => c && c.name === 'auth_token');
    } else if (xLoginPage) {
      try {
        cookies = await xLoginPage.cookies();
        authToken = cookies.find(c => c && c.name === 'auth_token');
      } catch (e) {
        console.log('⚠️ Could not get cookies from xLoginPage:', e.message);
        cookies = [];
      }
    }

    return res.json({
      success: true,
      isLoggedIn: !!authToken,
      cached: hasCachedCookies,
      hasCachedCookies: hasCachedCookies,
      hasXLoginPage: !!xLoginPage,
      cookieCount: cookies.length,
      cookies: cookies.map(c => ({
        name: c.name,
        domain: c.domain,
        expires: c.expires ? new Date(c.expires * 1000).toISOString() : 'session'
      })),
      currentUrl: xLoginPage ? xLoginPage.url() : 'N/A',
      message: hasCachedCookies ? 'Cookies are cached and persistent' : 'Cookies from session only'
    });

  } catch (error) {
    console.error('[API] GET /api/x-cookies error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.delete('/api/x-cookies', async (req, res) => {
  try {
    cachedXCookies = null;
    console.log('[API] Cookie cache cleared');

    // ファイルも削除
    if (fs.existsSync(COOKIE_FILE)) {
      fs.unlinkSync(COOKIE_FILE);
      console.log('[API] Cookie file deleted');
    }

    if (xLoginPage) {
      const cookies = await xLoginPage.cookies();
      for (const cookie of cookies) {
        await xLoginPage.deleteCookie(cookie);
      }
      console.log('[API] xLoginPage cookies cleared');
    }

    return res.json({
      success: true,
      message: 'All X cookies cleared (memory and file)'
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/x-test', async (req, res) => {
  try {
    console.log('[API] Starting X page access test...');

    if (!xLoginPage) {
      xLoginPage = await initXLoginPage();
    }

    const results = await testXPageAccess(xLoginPage);

    return res.json({
      success: true,
      results
    });

  } catch (error) {
    console.error('[API] Test error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== 10. ROOT ROUTE (must be last) =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 11. TEST HELPER FUNCTION =====
async function testXPageAccess(page) {
  console.log('[X-TEST] Testing X page access without login...');
  
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const results = { tests: [] };
  
  // Test 1: Xトップページ
  console.log('[X-TEST] Test 1: Accessing https://x.com/');
  try {
    await page.goto('https://x.com/', {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 30000
    });
    
    await sleep(3000);
    
    const pageInfo1 = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.substring(0, 500),
      hasError: document.body.innerText.includes('Error') && 
                document.body.innerText.includes('Oops')
    }));
    
    console.log('[X-TEST] Top page result:', JSON.stringify(pageInfo1, null, 2));
    results.tests.push({ page: 'top', ...pageInfo1 });
    
  } catch (e) {
    console.log('[X-TEST] Top page error:', e.message);
    results.tests.push({ page: 'top', error: e.message });
  }
  
  // Test 2: 特定のユーザープロフィール
  console.log('[X-TEST] Test 2: Accessing https://x.com/elonmusk');
  try {
    await page.goto('https://x.com/elonmusk', {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 30000
    });
    
    await sleep(3000);
    
    const pageInfo2 = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.substring(0, 500),
      hasError: document.body.innerText.includes('Error') && 
                document.body.innerText.includes('Oops'),
      hasContent: document.body.innerText.length > 1000
    }));
    
    console.log('[X-TEST] Profile page result:', JSON.stringify(pageInfo2, null, 2));
    results.tests.push({ page: 'profile', ...pageInfo2 });
    
  } catch (e) {
    console.log('[X-TEST] Profile page error:', e.message);
    results.tests.push({ page: 'profile', error: e.message });
  }
  
  // 結果サマリー
  const blockedCount = results.tests.filter(t => t.hasError).length;
  const successCount = results.tests.filter(t => !t.hasError && !t.error).length;
  
  console.log('[X-TEST] ========== SUMMARY ==========');
  console.log(`[X-TEST] Total tests: ${results.tests.length}`);
  console.log(`[X-TEST] Success: ${successCount}`);
  console.log(`[X-TEST] Blocked: ${blockedCount}`);
  
  results.summary = {
    total: results.tests.length,
    success: successCount,
    blocked: blockedCount,
    conclusion: blockedCount === results.tests.length 
      ? 'All pages blocked - X blocks Render completely'
      : 'Only login page is blocked - Regular pages accessible'
  };
  
  return results;
}

// ===== 12. SERVER START =====
app.listen(PORT, () => {
  console.log(`🚀 Yubikiri Proxy Pro running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.RENDER ? 'Render' : 'Local'}`);
  console.log(`🍪 Cached cookies: ${cachedXCookies ? cachedXCookies.length : 0}`);
});

process.on('SIGTERM', async () => {
  console.log('👋 Shutting down gracefully...');
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});