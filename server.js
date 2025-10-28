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
let xLoginPageBusy = false; // 🆕 ページ使用中フラグ
const xLoginPageQueue = []; // 🆕 待機キュー

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

// 🔴 CRITICAL FIX: 静的ファイルを後で提供（API routesの後）
// app.use(express.static('public')); // ← ここでは使わない

// ===== 5. UTILITY FUNCTIONS =====
function encodeProxyUrl(targetUrl) {
  return Buffer.from(targetUrl).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function decodeProxyUrl(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// プロキシパスを変更（フィルタリング回避）
const PROXY_PATH = '/proxy/'; // 標準的なプロキシパス

function rewriteHTML(html, baseUrl) {
  const urlObj = new url.URL(baseUrl);
  const origin = `${urlObj.protocol}//${urlObj.host}`;
  const proxyOrigin = process.env.RENDER ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : `http://localhost:${PORT}`;

  function isAlreadyProxied(urlString) {
    return urlString.includes('/proxy/') || urlString.includes(proxyOrigin);
  }

  // href書き換え
  html = html.replace(/href\s*=\s*["']([^"']+)["']/gi, (match, href) => {
    if (href.startsWith('javascript:') || href.startsWith('#') || 
        href.startsWith('mailto:') || href.startsWith('tel:') || 
        isAlreadyProxied(href)) {
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
    if (src.startsWith('data:') || src.startsWith('blob:') || isAlreadyProxied(src)) {
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

  // video source書き換え
  html = html.replace(/<source\s+([^>]*?)src\s*=\s*["']([^"']+)["']([^>]*?)>/gi, (match, before, src, after) => {
    if (src.startsWith('data:') || src.startsWith('blob:') || isAlreadyProxied(src)) {
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
      return `<source ${before}src="/proxy/${encodeProxyUrl(absoluteUrl)}"${after}>`;
    } catch (e) {
      return match;
    }
  });

  // action書き換え
  html = html.replace(/action\s*=\s*["']([^"']+)["']/gi, (match, action) => {
    if (isAlreadyProxied(action)) {
      return match;
    }
    
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

  // CSP追加
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' ${proxyOrigin} blob: data: *; default-src 'self' 'unsafe-inline' 'unsafe-eval' ${proxyOrigin} *; img-src * data: blob:; media-src * blob: data:; script-src 'self' 'unsafe-inline' 'unsafe-eval' ${proxyOrigin} * blob:; style-src 'self' 'unsafe-inline' *; worker-src 'self' blob:;">`;

  // 緊急インターセプト
  const earlyInterceptScript = `
    <script>
      (function() {
        'use strict';
        console.log('[EARLY INTERCEPT] 🚨 Blocking direct API access');
        
        const PROXY_ORIGIN = '${proxyOrigin}';
        const PROXY_PATH = '${PROXY_PATH}';
        
        function encodeProxyUrl(url) {
          const base64 = btoa(url).replace(/\\+/g, '-').replace(/\\\//g, '_').replace(/=/g, '');
          return PROXY_ORIGIN + PROXY_PATH + base64;
        }
        
        const OriginalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
          const xhr = new OriginalXHR();
          const originalOpen = xhr.open;
          
          xhr.open = function(method, url, ...rest) {
            if (typeof url === 'string' && (url.includes('api.x.com') || url.includes('api.twitter.com'))) {
              console.log('[EARLY INTERCEPT] ⛔ Blocked direct API call:', url);
              const proxiedUrl = encodeProxyUrl(url);
              console.log('[EARLY INTERCEPT] ↪️ Redirecting to:', proxiedUrl);
              return originalOpen.call(this, method, proxiedUrl, ...rest);
            }
            return originalOpen.call(this, method, url, ...rest);
          };
          
          return xhr;
        };
        
        console.log('[EARLY INTERCEPT] ✅ XMLHttpRequest override complete');
      })();
    </script>
  `;

  // 超強力インターセプト
  const interceptScript = `
    <script>
      (function() {
        'use strict';
        
        const PROXY_ORIGIN = '${proxyOrigin}';
        const TARGET_ORIGIN = '${origin}';
        const PROXY_PATH = '${PROXY_PATH}';
        
        console.log('[Proxy] Ultra-Strong Intercept initializing for', TARGET_ORIGIN);
        
        function isAlreadyProxied(url) {
          if (!url) return false;
          return url.includes(PROXY_ORIGIN) || url.includes(PROXY_PATH);
        }
        
        function toAbsoluteUrl(relativeUrl) {
          if (!relativeUrl) return relativeUrl;
          if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) return relativeUrl;
          if (relativeUrl.startsWith('//')) return 'https:' + relativeUrl;
          if (relativeUrl.startsWith('/')) return TARGET_ORIGIN + relativeUrl;
          return TARGET_ORIGIN + '/' + relativeUrl;
        }
        
        function encodeProxyUrl(url) {
          const base64 = btoa(url).replace(/\\+/g, '-').replace(/\\\//g, '_').replace(/=/g, '');
          return PROXY_ORIGIN + PROXY_PATH + base64;
        }
        
        function proxyUrl(url) {
          if (!url || typeof url !== 'string') return url;
          if (isAlreadyProxied(url)) return url;
          if (url.startsWith('blob:') || url.startsWith('data:')) return url;
          const absoluteUrl = toAbsoluteUrl(url);
          if (absoluteUrl.startsWith('http')) return encodeProxyUrl(absoluteUrl);
          return url;
        }
        
        // locationç„¡åŠ¹åŒ–（エラーハンドリング付き）
try {
  Object.defineProperty(window.location, 'href', {
    get: function() { return window.location.href; },
    set: function(value) { console.log('[Proxy] 🛑 BLOCKED location.href =', value); return true; },
    configurable: false
  });
} catch (e) {
  console.warn('[Proxy] Could not override location.href:', e.message);
}
        
        window.location.replace = function(url) {
          console.log('[Proxy] 🛑 BLOCKED location.replace:', url);
          return false;
        };
        
        window.location.assign = function(url) {
          console.log('[Proxy] 🛑 BLOCKED location.assign:', url);
          return false;
        };
        
        // fetch
        const originalFetch = window.fetch;
        window.fetch = function(resource, options) {
          let url = typeof resource === 'string' ? resource : (resource.url || resource);
          if (url && (url.includes('google.com') || url.includes('gstatic.com'))) {
            return Promise.reject(new Error('Blocked'));
          }
          if (url && (url.startsWith('blob:') || url.startsWith('data:'))) {
            return originalFetch.call(this, resource, options);
          }
          if (isAlreadyProxied(url)) {
            return originalFetch.call(this, resource, options);
          }
          const proxiedUrl = proxyUrl(url);
          if (proxiedUrl !== url) {
            const newOptions = Object.assign({}, options);
            if (newOptions.mode === 'cors') delete newOptions.mode;
            if (typeof resource === 'string') {
              return originalFetch.call(this, proxiedUrl, newOptions);
            } else {
              return originalFetch.call(this, new Request(proxiedUrl, newOptions));
            }
          }
          return originalFetch.call(this, resource, options);
        };
        
        // XMLHttpRequest（二重防御）
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (typeof url === 'string') {
            if (url.includes('google.com') || url.includes('gstatic.com')) {
              throw new Error('Blocked');
            }
            if (!url.startsWith('blob:') && !url.startsWith('data:')) {
              if (!isAlreadyProxied(url)) {
                const proxiedUrl = proxyUrl(url);
                if (proxiedUrl !== url) {
                  console.log('[Proxy] XHR intercepted:', url, '→', proxiedUrl);
                  return originalOpen.call(this, method, proxiedUrl, ...rest);
                }
              }
            }
          }
          return originalOpen.call(this, method, url, ...rest);
        };
        
        console.log('[Proxy] 🛡️ Protection ACTIVE');
      })();
    </script>
  `;

  // <head>に注入
  html = html.replace(/<head([^>]*)>/i, (match, attrs) => {
    return `<head${attrs}>${cspMeta}${earlyInterceptScript}${interceptScript}`;
  });
  
  // Google削除
  html = html.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*src=[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe[^>]*google[^>]*>[\s\S]*?<\/iframe>/gi, '');

  // charset確保
  if (!html.includes('charset')) {
    html = html.replace(/<head([^>]*)>/i, '<head$1><meta charset="UTF-8">');
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

  // タイムアウトを延長（X.comは読み込みが遅い）
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

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

// 🆕 xLoginPageの排他制御付き使用
async function useXLoginPage(callback) {
  // ページが使用中の場合は待機
  if (xLoginPageBusy) {
    console.log('⏳ xLoginPage is busy, queuing request...');
    return new Promise((resolve) => {
      xLoginPageQueue.push(async () => {
        const result = await callback();
        resolve(result);
      });
    });
  }

  xLoginPageBusy = true;
  try {
    const result = await callback();
    return result;
  } finally {
    xLoginPageBusy = false;
    
    // キューに待機中のリクエストがあれば処理
    if (xLoginPageQueue.length > 0) {
      const nextRequest = xLoginPageQueue.shift();
      setImmediate(nextRequest);
    }
  }
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
    hasXLoginPage: !!xLoginPage,
    cookieCount: cachedXCookies ? cachedXCookies.length : 0,
    cookieNames: cachedXCookies ? cachedXCookies.map(c => c.name) : []
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

app.get('/test-cookies', (req, res) => {
  const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
  
  res.json({
    hasCachedCookies: hasCookies,
    cookieCount: hasCookies ? cachedXCookies.length : 0,
    cookies: hasCookies ? cachedXCookies.map(c => {
      if (!c) return { error: 'null cookie' };
      return {
        name: c.name || 'no-name',
        domain: c.domain || 'no-domain',
        value: c.value ? (c.value.substring(0, 20) + '...') : 'no-value',
        hasValue: !!c.value,
        valueLength: c.value ? c.value.length : 0
      };
    }) : [],
    hasAuthToken: hasCookies ? !!cachedXCookies.find(c => c && c.name === 'auth_token') : false,
    hasCt0: hasCookies ? !!cachedXCookies.find(c => c && c.name === 'ct0') : false
  });
});

// ===== 8. PROXY ROUTES =====

// OPTIONS proxy route（CORSプリフライト用）
app.options(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token, x-twitter-active-user, x-twitter-client-language, x-twitter-auth-type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).send();
});

// 🔴 CRITICAL: GET proxy route with Puppeteer
app.get(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  console.log('🔵 [PROXY] GET request received');
  console.log('🔵 [PROXY] params:', req.params);
  console.log('🔵 [PROXY] path:', req.path);
  
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    console.log('🔵 [PROXY] encodedUrl:', encodedUrl.substring(0, 100) + '...');
    
    const targetUrl = decodeProxyUrl(encodedUrl);
    console.log('📡 GET Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    
    // APIエンドポイントかどうかを判定
    const isApiEndpoint = parsedUrl.hostname.includes('api.x.com') || 
                          parsedUrl.pathname.includes('.json') ||
                          parsedUrl.pathname.includes('graphql');
    
    // 動画・メディアファイルの判定
    const isMediaFile = parsedUrl.pathname.match(/\.(js|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|mp4|webm|m3u8|ts|m4s|mpd)$/i) ||
                        parsedUrl.hostname.includes('video.twimg.com') ||
                        parsedUrl.hostname.includes('video-s.twimg.com') ||
                        parsedUrl.hostname.includes('pbs.twimg.com') ||
                        parsedUrl.hostname.includes('abs.twimg.com');
    
    // HTMLページかどうかを判定（API・メディアは除外）
    const isHTML = !isApiEndpoint && !isMediaFile;

    console.log(`📊 Type: isHTML=${isHTML}, isAPI=${isApiEndpoint}, isMedia=${isMediaFile}`);
    
    const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;

    // HTMLページの場合はPuppeteerを使用
    if (isHTML) {
      console.log('🌐 Using Puppeteer for HTML page');
      
      let page;
      const useXLoginPageShared = isXDomain && xLoginPage && hasCookies;

      try {
        if (useXLoginPageShared) {
          // xLoginPageを使用（キューイングシステムで処理）
          console.log('♻️ Using shared xLoginPage');
          
          const htmlContent = await useXLoginPage(async () => {
            await xLoginPage.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 60000
            }).catch(err => {
              console.log('⚠️ Navigation timeout (continuing):', err.message);
            });
            
            if (isXDomain) {
              await Promise.race([
                xLoginPage.waitForSelector('div[data-testid="primaryColumn"]', { timeout: 10000 }),
                xLoginPage.waitForSelector('main[role="main"]', { timeout: 10000 }),
                new Promise(resolve => setTimeout(resolve, 10000))
              ]).catch(() => {});
              
              await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            return await xLoginPage.content();
          });
          
          const rewrittenHTML = rewriteHTML(htmlContent, targetUrl);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.send(rewrittenHTML);
          
        } else {
          console.log('🆕 Creating new page');
          const browserInstance = await initBrowser();
          page = await browserInstance.newPage();
          
          // タイムアウトを延長
          page.setDefaultNavigationTimeout(60000);
          page.setDefaultTimeout(60000);
          
          await page.setViewport({ width: 1920, height: 1080 });
          await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          );

          // X.com用のCookieをセット
          if (isXDomain && hasCookies) {
            try {
              const validCookies = cachedXCookies.filter(c => c && c.name && c.value);
              if (validCookies.length > 0) {
                await page.setCookie(...validCookies);
                console.log('🍪 Cookies set for new page:', validCookies.length);
              }
            } catch (e) {
              console.log('⚠️ Could not set cookies:', e.message);
            }
          }
        }

        // ナビゲーション（X.comは読み込みが遅いので戦略を変更）
        console.log(`🌐 Navigating to: ${targetUrl}`);
        
        if (isXDomain) {
          // X.com専用の読み込み戦略
          try {
            await page.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 60000
            });
            console.log('✅ DOM loaded');
          } catch (navErr) {
            console.log('⚠️ Navigation timeout, but DOM may be loaded:', navErr.message);
          }

          // X.comの主要な要素が出現するまで待機（タイムアウト付き）
          try {
            await Promise.race([
              page.waitForSelector('div[data-testid="primaryColumn"]', { timeout: 10000 }),
              page.waitForSelector('main[role="main"]', { timeout: 10000 }),
              new Promise(resolve => setTimeout(resolve, 10000))
            ]);
            console.log('✅ Main content detected');
          } catch (e) {
            console.log('⚠️ Main content not detected, continuing anyway');
          }

          // さらに少し待機（動的コンテンツの読み込み）
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          // 通常サイトの読み込み戦略
          try {
            await page.goto(targetUrl, {
              waitUntil: 'networkidle2',
              timeout: 30000
            });
          } catch (navErr) {
            console.log('⚠️ Navigation timeout:', navErr.message);
          }
          
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // HTMLを取得
        const htmlContent = await page.content();
        console.log(`✅ Page loaded successfully (${htmlContent.length} bytes)`);

        // 新しく作成したページをクローズ（xLoginPageは維持）
        if (page && page !== xLoginPage) {
          await page.close();
        }

        // HTMLを書き換えて送信
        const rewrittenHTML = rewriteHTML(htmlContent, targetUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenHTML);

      } catch (navError) {
        console.error('❌ Navigation error:', navError.message);
        
        // abortedエラーの場合は無視（ページ遷移によるキャンセル）
        if (navError.message.includes('aborted') || navError.message.includes('ERR_ABORTED')) {
          console.log('⚠️ Request aborted (likely page navigation), returning empty response');
          res.status(204).send(); // No Content
          if (!useXLoginPageShared && page) {
            await page.close().catch(() => {});
          }
          return;
        }
        
        // エラーページを表示
        res.status(500).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <title>プロキシエラー</title>
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
                color: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
              }
              .error-box {
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                padding: 40px;
                max-width: 500px;
                text-align: center;
              }
              h1 { color: #ff6b6b; margin-bottom: 20px; }
              p { color: rgba(255,255,255,0.7); line-height: 1.6; }
              code { 
                background: rgba(0,0,0,0.3);
                padding: 2px 8px;
                border-radius: 4px;
                font-family: monospace;
              }
              a {
                display: inline-block;
                margin-top: 20px;
                padding: 12px 24px;
                background: #b0b0b0;
                color: #1a1a1a;
                text-decoration: none;
                border-radius: 6px;
                font-weight: 600;
              }
              a:hover { background: #d0d0d0; }
            </style>
          </head>
          <body>
            <div class="error-box">
              <h1>❌ ページの読み込みに失敗しました</h1>
              <p><strong>対象URL:</strong><br><code>${targetUrl}</code></p>
              <p><strong>エラー:</strong><br>${navError.message}</p>
              <a href="/">トップページに戻る</a>
            </div>
          </body>
          </html>
        `);
        
        // 新しく作成したページをクローズ
        if (page && page !== xLoginPage) {
          await page.close().catch(() => {});
        }
      }
    } else {
      // 非HTMLリソース（JS/CSS/画像/API）はaxiosで取得
      console.log('📦 Fetching non-HTML resource with axios');
      
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.host}/`,
      };

      // X.com用のCookie（APIエンドポイント含む）
if (isXDomain && hasCookies) {
  try {
    const cookieString = cachedXCookies
      .filter(c => c && c.name && c.value)
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    
    if (cookieString) {
      headers['Cookie'] = cookieString;
      console.log('🍪 Using cached cookies for resource');
    }
    
    // API用の追加ヘッダー
    if (isApiEndpoint) {
      const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
      if (ct0Cookie && ct0Cookie.value) {
        headers['x-csrf-token'] = ct0Cookie.value;
        console.log('🔐 Added CSRF token for API');
      }
      
      // 🔴 追加：必須ヘッダー
      headers['x-twitter-active-user'] = 'yes';
      headers['x-twitter-client-language'] = 'en';
      headers['x-twitter-auth-type'] = 'OAuth2Session';
      
      // GraphQL用
      if (targetUrl.includes('graphql')) {
        headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
        console.log('🔑 Added GraphQL bearer token');
      }
    }
  } catch (e) {
    console.log('⚠️ Cookie error:', e.message);
  }
}

      const response = await axios({
        method: 'GET',
        url: targetUrl,
        headers: headers,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: () => true,
        timeout: 15000
      });

      console.log(`📥 Resource loaded: ${response.status}`);
      
      if (response.status === 400 || response.status === 404) {
  console.log('❌ Resource Error:', response.status, 'for', targetUrl);
  
  // 🔴 デバッグ：エラーレスポンスの内容を確認
  try {
    const errorBody = response.data.toString('utf-8');
    console.log('❌ Full Error body:', errorBody);
  } catch (e) {
    console.log('Could not parse error body');
  }
  
  // そのままエラーをクライアントに返す（空ではなく）
  const contentType = response.headers['content-type'] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(response.status).send(response.data);
  return;
}

      const contentType = response.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(response.data);
    }

  } catch (error) {
    console.error('❌ GET Proxy error:', error.message);
    
    // abortedエラーは無視
    if (error.message.includes('aborted') || error.message.includes('ERR_ABORTED')) {
      console.log('⚠️ Request aborted, returning 204');
      res.status(204).send();
      return;
    }
    
    res.status(500).json({ 
      error: error.message,
      url: req.params.encodedUrl
    });
  }
});

// POST proxy route（X API対応強化版）
app.post(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 POST Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    headers['Origin'] = `${parsedUrl.protocol}//${parsedUrl.host}`;
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    // X.com用のCookie処理
    if (isXDomain) {
      const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
      
      if (hasCookies) {
        try {
          let cookieString = cachedXCookies
            .map(c => c && c.name && c.value ? `${c.name}=${c.value}` : '')
            .filter(s => s)
            .join('; ');
          
          if (cookieString) {
            headers['Cookie'] = cookieString;
            console.log('🍪 Using cached cookies for POST');
            console.log('🍪 Cookie count:', cachedXCookies.length);
          }
          
          // CSRF トークン（ct0）を x-csrf-token ヘッダーに追加
          const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
          if (ct0Cookie && ct0Cookie.value) {
            headers['x-csrf-token'] = ct0Cookie.value;
            console.log('🔐 Added x-csrf-token:', ct0Cookie.value.substring(0, 10) + '...');
          } else {
            console.log('⚠️ ct0 cookie not found!');
          }
          
          // auth_tokenの確認
          const authToken = cachedXCookies.find(c => c && c.name === 'auth_token');
          if (authToken && authToken.value) {
            console.log('✅ auth_token found');
          } else {
            console.log('⚠️ auth_token not found!');
          }
        } catch (e) {
          console.log('⚠️ Cookie mapping error:', e.message);
          console.error(e.stack);
        }
      } else {
        console.log('❌ No cached cookies available!');
      }
      
      // X API用の追加ヘッダー
      headers['x-twitter-active-user'] = 'yes';
      headers['x-twitter-client-language'] = 'en';
      headers['x-twitter-auth-type'] = 'OAuth2Session';
      
      // GraphQL API用のヘッダー
      if (targetUrl.includes('graphql') || targetUrl.includes('UserByScreenName')) {
        headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
        console.log('🔑 Added GraphQL authorization bearer token');
      }
    } else if (req.headers.cookie) {
      headers['Cookie'] = req.headers.cookie;
    }

    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    console.log('📤 Request headers:', Object.keys(headers));

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
    
    if (response.status === 400 || response.status === 404) {
      console.log('❌ API Error:', response.status);
      console.log('Response headers:', response.headers);
      try {
        const errorBody = response.data.toString('utf-8');
        console.log('Error body:', errorBody.substring(0, 500));
      } catch (e) {
        console.log('Could not parse error body');
      }
    }

    const contentType = response.headers['content-type'] || '';

    if (response.headers['set-cookie']) {
      res.setHeader('Set-Cookie', response.headers['set-cookie']);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token, x-twitter-active-user, x-twitter-client-language');
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

// PUT proxy route（X API用）
app.put(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 PUT Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    headers['Origin'] = `${parsedUrl.protocol}//${parsedUrl.host}`;
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    // X.com用のCookie処理
    if (isXDomain) {
      const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
      
      if (hasCookies) {
        try {
          let cookieString = cachedXCookies
            .filter(c => c && c.name && c.value)
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
          
          if (cookieString) {
            headers['Cookie'] = cookieString;
            console.log('🍪 Using cached cookies for PUT');
          }
          
          const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
          if (ct0Cookie && ct0Cookie.value) {
            headers['x-csrf-token'] = ct0Cookie.value;
            console.log('🔐 Added x-csrf-token for PUT');
          }
        } catch (e) {
          console.log('⚠️ Cookie error:', e.message);
        }
      }
      
      headers['x-twitter-active-user'] = 'yes';
      headers['x-twitter-client-language'] = 'en';
      headers['x-twitter-auth-type'] = 'OAuth2Session';
      
      if (targetUrl.includes('graphql') || targetUrl.includes('strato')) {
        headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
        console.log('🔑 Added bearer token for PUT');
      }
    }

    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
    }

    const response = await axios({
      method: 'PUT',
      url: targetUrl,
      headers: headers,
      data: req.body,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    console.log(`📥 PUT Response: ${response.status}`);
    
    if (response.status === 400 || response.status === 403 || response.status === 404) {
      console.log('❌ PUT API Error:', response.status);
      try {
        const errorBody = response.data.toString('utf-8');
        console.log('Error body:', errorBody.substring(0, 300));
      } catch (e) {
        console.log('Could not parse error body');
      }
    }

    const contentType = response.headers['content-type'] || '';

    if (response.headers['set-cookie']) {
      res.setHeader('Set-Cookie', response.headers['set-cookie']);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token, x-twitter-active-user, x-twitter-client-language');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (contentType.includes('application/json')) {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }

  } catch (error) {
    console.error('❌ PUT Proxy error:', error.message);
    res.status(500).json({ 
      error: error.message,
      url: req.params.encodedUrl
    });
  }
});

// ===== 9. API ROUTES =====

app.post('/api/proxy', async (req, res) => {
  console.log('🔵 [API] /api/proxy called');
  console.log('🔵 [API] Request body:', req.body);
  
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URLが必要です' });
    }

    const encodedUrl = encodeProxyUrl(url);
    res.json({
      success: true,
      redirectUrl: `${PROXY_PATH}${encodedUrl}`
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/x-inject-cookies', async (req, res) => {
  const { authToken, ct0Token, allCookies } = req.body;

  // 🆕 完全なCookie配列を受け取る（推奨）
  if (allCookies && Array.isArray(allCookies) && allCookies.length > 0) {
    console.log('[API] Injecting ALL cookies from array:', allCookies.length);
    
    try {
      // Cookieの形式を正規化
      const formattedCookies = allCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.x.com',
        path: c.path || '/',
        httpOnly: c.httpOnly !== undefined ? c.httpOnly : (c.name === 'auth_token' || c.name === '_twitter_sess'),
        secure: c.secure !== undefined ? c.secure : true,
        sameSite: c.sameSite || (c.name === 'ct0' ? 'Lax' : 'None'),
        expires: c.expires || Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      }));

      // メモリとファイルの両方に保存
      cachedXCookies = formattedCookies;
      saveCookiesToFile(formattedCookies);
      console.log('[API] ✅ All cookies cached:', formattedCookies.length);
      console.log('[API] Cookie names:', formattedCookies.map(c => c.name).join(', '));

      // xLoginPageの初期化
      if (!xLoginPage) {
        try {
          console.log('[API] Creating xLoginPage...');
          xLoginPage = await initXLoginPage();
          console.log('[API] ✅ xLoginPage created');
        } catch (initError) {
          console.error('[API] ⚠️ Failed to create xLoginPage:', initError.message);
          return res.json({
            success: true,
            message: `${formattedCookies.length} cookies cached (xLoginPage creation skipped)`,
            cached: true,
            persisted: true,
            hasXLoginPage: false,
            cookieCount: formattedCookies.length,
            cookieNames: formattedCookies.map(c => c.name),
            warning: 'xLoginPage creation failed, but cookies will work in proxy requests'
          });
        }
      }

      // xLoginPageにCookieをセット
      if (xLoginPage) {
        try {
          await xLoginPage.setCookie(...formattedCookies);
          console.log('[API] ✅ Cookies set in xLoginPage');
        } catch (e) {
          console.log('[API] ⚠️ Could not set cookies in page:', e.message);
        }
      }

      // X.comに移動してCookieを有効化（オプショナル）
      let currentUrl = 'N/A';
      let pageCookies = [];
      let hasAuthToken = false;

      try {
        if (xLoginPage) {
          console.log('[API] Navigating to X.com to activate cookies...');
          await xLoginPage.goto('https://x.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          }).catch(() => {});
          
          await new Promise(r => setTimeout(r, 2000));
          
          currentUrl = xLoginPage.url();
          pageCookies = await xLoginPage.cookies();
          hasAuthToken = pageCookies.some(c => c && c.name === 'auth_token');
          
          console.log('[API] Current URL:', currentUrl);
          console.log('[API] Has auth_token:', hasAuthToken);
          console.log('[API] Total cookies in page:', pageCookies.length);
        }
      } catch (navError) {
        console.log('[API] ⚠️ Navigation skipped:', navError.message);
      }

      return res.json({
        success: true,
        message: `${formattedCookies.length} cookies injected successfully`,
        isLoggedIn: hasAuthToken,
        currentUrl,
        cached: true,
        persisted: true,
        hasXLoginPage: !!xLoginPage,
        cookieCount: formattedCookies.length,
        cookieNames: formattedCookies.map(c => c.name),
        note: 'Cookies will persist across server restarts'
      });

    } catch (error) {
      console.error('[API] Error processing cookies:', error.message);
      console.error('[API] Stack:', error.stack);
      return res.status(500).json({ 
        success: false, 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }

  // 従来の方法（auth_token + ct0のみ）- 後方互換性のため残す
  if (!authToken || !ct0Token) {
    return res.status(400).json({ 
      success: false,
      error: 'authToken and ct0Token are required, or provide allCookies array' 
    });
  }

  try {
    console.log('[API] Injecting basic cookies (auth_token + ct0)...');
    console.log('[API] authToken length:', authToken.length);
    console.log('[API] ct0Token length:', ct0Token.length);

    const cookies = [
      {
        name: 'auth_token',
        value: authToken.trim(),
        domain: '.x.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        expires: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      },
      {
        name: 'ct0',
        value: ct0Token.trim(),
        domain: '.x.com',
        path: '/',
        secure: true,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60)
      }
    ];

    cachedXCookies = cookies;
    saveCookiesToFile(cookies);
    console.log('[API] ✅ Basic cookies cached');

    if (!xLoginPage) {
      try {
        xLoginPage = await initXLoginPage();
        console.log('[API] ✅ xLoginPage created');
      } catch (initError) {
        console.error('[API] ⚠️ Failed to create xLoginPage:', initError.message);
        return res.json({
          success: true,
          message: 'Basic cookies cached (xLoginPage creation skipped)',
          cached: true,
          persisted: true,
          hasXLoginPage: false,
          cookieCount: 2,
          warning: 'Only 2 cookies provided. Some features may not work. Use the Cookie Helper to input more cookies.'
        });
      }
    }

    if (xLoginPage) {
      try {
        await xLoginPage.setCookie(...cookies);
        console.log('[API] ✅ Cookies set in xLoginPage');
      } catch (e) {
        console.log('[API] ⚠️ Could not set cookies:', e.message);
      }
    }

    return res.json({
      success: true,
      message: 'Basic cookies injected',
      cached: true,
      persisted: true,
      hasXLoginPage: !!xLoginPage,
      cookieCount: 2,
      cookieNames: ['auth_token', 'ct0'],
      warning: '⚠️ Only 2 cookies provided. Some API features may not work correctly. Please use the Cookie Helper page to input all cookies for best results.'
    });

  } catch (error) {
    console.error('[API] Cookie injection error:', error.message);
    console.error('[API] Stack:', error.stack);
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
      cookies = cachedXCookies.filter(c => c && c.name);
      authToken = cookies.find(c => c.name === 'auth_token');
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
      isLoggedIn: !!(authToken && authToken.value),
      cached: hasCachedCookies,
      hasCachedCookies: hasCachedCookies,
      hasXLoginPage: !!xLoginPage,
      cookieCount: cookies.length,
      cookies: cookies.map(c => ({
        name: c.name || 'unknown',
        domain: c.domain || 'unknown',
        expires: c.expires ? new Date(c.expires * 1000).toISOString() : 'session'
      })),
      currentUrl: xLoginPage ? xLoginPage.url() : 'N/A',
      message: hasCachedCookies ? 'Cookies are cached and persistent' : 'Cookies from session only'
    });

  } catch (error) {
    console.error('[API] GET /api/x-cookies error:', error.message);
    console.error('[API] Stack:', error.stack);
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

// ===== 🆕 X.COM SPECIFIC PATH HANDLING =====
// X.comの相対パスへの直接アクセスをプロキシ経由にリダイレクト

app.get('/home', (req, res) => {
  console.log('🔄 Redirecting /home to proxied X.com');
  const targetUrl = 'https://x.com/home';
  const encodedUrl = encodeProxyUrl(targetUrl);
  res.redirect(302, `${PROXY_PATH}${encodedUrl}`);
});

app.get('/explore', (req, res) => {
  console.log('🔄 Redirecting /explore to proxied X.com');
  const targetUrl = 'https://x.com/explore';
  const encodedUrl = encodeProxyUrl(targetUrl);
  res.redirect(302, `${PROXY_PATH}${encodedUrl}`);
});

app.get('/notifications', (req, res) => {
  console.log('🔄 Redirecting /notifications to proxied X.com');
  const targetUrl = 'https://x.com/notifications';
  const encodedUrl = encodeProxyUrl(targetUrl);
  res.redirect(302, `${PROXY_PATH}${encodedUrl}`);
});

app.get('/messages', (req, res) => {
  console.log('🔄 Redirecting /messages to proxied X.com');
  const targetUrl = 'https://x.com/messages';
  const encodedUrl = encodeProxyUrl(targetUrl);
  res.redirect(302, `${PROXY_PATH}${encodedUrl}`);
});

// 動画ファイルの直接アクセスをプロキシ経由に
app.get('/amplify_video/*', (req, res) => {
  const videoPath = req.path;
  console.log('🎥 Redirecting video:', videoPath);
  const targetUrl = `https://video.twimg.com${videoPath}`;
  const encodedUrl = encodeProxyUrl(targetUrl);
  res.redirect(302, `${PROXY_PATH}${encodedUrl}`);
});

console.log('✅ X.com path handlers registered');

// ===== 10. STATIC FILES & ROOT ROUTE =====

// 🔴 CRITICAL FIX: 静的ファイルをAPI routesの後に配置
app.use(express.static('public'));

// 明示的な静的ファイルルート
app.get('/x-cookie-helper.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'x-cookie-helper.html'));
});

app.get('/x-login-test.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'x-login-test.html'));
});

// ルートパス（最後に配置）
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404エラーハンドラー（すべてのルートの最後）
app.use((req, res) => {
  console.log('❌ 404 - Route not found:', req.method, req.path);
  console.log('❌ Full URL:', req.originalUrl);
  console.log('❌ Headers:', req.headers);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path,
    method: req.method,
    originalUrl: req.originalUrl
  });
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
  console.log(`🔍 Environment: ${process.env.RENDER ? 'Render' : 'Local'}`);
  console.log(`🍪 Cached cookies: ${cachedXCookies ? cachedXCookies.length : 0}`);
});

process.on('SIGTERM', async () => {
  console.log('👋 Shutting down gracefully...');
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});