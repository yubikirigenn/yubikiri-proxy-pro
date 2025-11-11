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

// ===== 🔴 CRITICAL: 検索専用ページの実装 =====
// xLoginPageとは完全に独立した検索専用ページ


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
  var urlObj = new url.URL(baseUrl);
  var origin = urlObj.protocol + '//' + urlObj.host;
  var proxyOrigin = process.env.RENDER 
    ? ('https://' + process.env.RENDER_EXTERNAL_HOSTNAME)
    : ('http://localhost:' + PORT);

  function isAlreadyProxied(urlString) {
    return urlString.includes('/proxy/') || urlString.includes(proxyOrigin);
  }

  // href書き換え
  html = html.replace(/href\s*=\s*["']([^"']+)["']/gi, function(match, href) {
    if (href.startsWith('javascript:') || href.startsWith('#') || 
        href.startsWith('mailto:') || href.startsWith('tel:') || 
        isAlreadyProxied(href)) {
      return match;
    }
    var absoluteUrl = href;
    try {
      if (href.startsWith('//')) {
        absoluteUrl = urlObj.protocol + href;
      } else if (href.startsWith('/')) {
        absoluteUrl = origin + href;
      } else if (!href.startsWith('http')) {
        absoluteUrl = new url.URL(href, baseUrl).href;
      }
      return 'href="/proxy/' + encodeProxyUrl(absoluteUrl) + '"';
    } catch (e) {
      return match;
    }
  });

  // src書き換え
  html = html.replace(/src\s*=\s*["']([^"']+)["']/gi, function(match, src) {
    if (src.startsWith('data:') || src.startsWith('blob:') || isAlreadyProxied(src)) {
      return match;
    }
    var absoluteUrl = src;
    try {
      if (src.startsWith('//')) {
        absoluteUrl = urlObj.protocol + src;
      } else if (src.startsWith('/')) {
        absoluteUrl = origin + src;
      } else if (!src.startsWith('http')) {
        absoluteUrl = new url.URL(src, baseUrl).href;
      }
      return 'src="/proxy/' + encodeProxyUrl(absoluteUrl) + '"';
    } catch (e) {
      return match;
    }
  });

  // video source書き換え
  html = html.replace(/<source\s+([^>]*?)src\s*=\s*["']([^"']+)["']([^>]*?)>/gi, function(match, before, src, after) {
    if (src.startsWith('data:') || src.startsWith('blob:') || isAlreadyProxied(src)) {
      return match;
    }
    var absoluteUrl = src;
    try {
      if (src.startsWith('//')) {
        absoluteUrl = urlObj.protocol + src;
      } else if (src.startsWith('/')) {
        absoluteUrl = origin + src;
      } else if (!src.startsWith('http')) {
        absoluteUrl = new url.URL(src, baseUrl).href;
      }
      return '<source ' + before + 'src="/proxy/' + encodeProxyUrl(absoluteUrl) + '"' + after + '>';
    } catch (e) {
      return match;
    }
  });

  // action書き換え
  html = html.replace(/action\s*=\s*["']([^"']+)["']/gi, function(match, action) {
    if (isAlreadyProxied(action)) {
      return match;
    }
    var absoluteUrl = action;
    try {
      if (action.startsWith('//')) {
        absoluteUrl = urlObj.protocol + action;
      } else if (action.startsWith('/')) {
        absoluteUrl = origin + action;
      } else if (!action.startsWith('http')) {
        absoluteUrl = new url.URL(action, baseUrl).href;
      }
      return 'action="/proxy/' + encodeProxyUrl(absoluteUrl) + '"';
    } catch (e) {
      return match;
    }
  });

  // CSP, スクリプトを簡潔に
  var cspMeta = '<meta http-equiv="Content-Security-Policy" content="connect-src * blob: data:; default-src * \'unsafe-inline\' \'unsafe-eval\' blob: data:; script-src * \'unsafe-inline\' \'unsafe-eval\' blob:;">';
 var earlyScript = `<script>
(function(){
  console.log("[Proxy] Starting enhanced intercept");
  
  var PROXY_ORIGIN="${proxyOrigin}";
  var PROXY_PATH="${PROXY_PATH}";
  
  function encodeProxyUrl(u){
    return PROXY_ORIGIN+PROXY_PATH+btoa(u).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")
  }
  
  // 🔴 Cookie確認用ヘルパー
  function getCookieValue(name) {
    const value = document.cookie.match('(^|;)\\\\s*' + name + '\\\\s*=\\\\s*([^;]+)');
    return value ? value.pop() : '';
  }
  
  // 🔴 Cookie診断ログ
  console.log("[Proxy] Cookie check:");
  console.log("  auth_token:", getCookieValue('auth_token') ? 'EXISTS' : 'MISSING');
  console.log("  ct0:", getCookieValue('ct0') ? 'EXISTS' : 'MISSING');
  console.log("  Total cookies:", document.cookie.split(';').length);
  
  // XHRインターセプト
  var OrigXHR=window.XMLHttpRequest;
  window.XMLHttpRequest=function(){
    var xhr=new OrigXHR();
    var origOpen=xhr.open;
    var origSend=xhr.send;
    var isProxied=false;
    
    xhr.open=function(m,u,a,us,p){
      if(typeof u==="string"&&(u.includes("api.x.com")||u.includes("x.com/i/")||u.includes("graphql"))){
        console.log("[Proxy] XHR Intercepted:",u.substring(0,80));
        
        // 🔴 Cookie確認
        const hasCookies = document.cookie.length > 0;
        console.log("[Proxy] Has cookies:", hasCookies);
        
        var pu=encodeProxyUrl(u);
        isProxied=true;
        return origOpen.call(this,m,pu,a,us,p)
      }
      return origOpen.call(this,m,u,a,us,p)
    };
    
    xhr.send=function(){
      if(isProxied){
        // 🔴 withCredentials強制有効化
        this.withCredentials=true;
        console.log("[Proxy] XHR credentials enabled");
      }
      return origSend.apply(this,arguments)
    };
    
    return xhr
  };
  
  // Fetchインターセプト
  var origFetch=window.fetch;
  window.fetch=function(r,o){
    var u=typeof r==="string"?r:(r.url||r);
    
    if(u&&(u.includes("api.x.com")||u.includes("x.com/i/")||u.includes("graphql"))){
      console.log("[Proxy] Fetch intercepted:",u.substring(0,80));
      
      // 🔴 Cookie確認
      const hasCookies = document.cookie.length > 0;
      console.log("[Proxy] Has cookies:", hasCookies);
      
      var pu=encodeProxyUrl(u);
      var newOpts=Object.assign({},o||{});
      
      // 🔴 credentials強制設定
      newOpts.credentials="include";
      
      // 🔴 ヘッダー確認・追加
      if (!newOpts.headers) {
        newOpts.headers = {};
      }
      
      // ct0トークンを明示的に追加
      const ct0 = getCookieValue('ct0');
      if (ct0 && !newOpts.headers['x-csrf-token']) {
        newOpts.headers['x-csrf-token'] = ct0;
        console.log("[Proxy] Added x-csrf-token");
      }
      
      if(typeof r==="string"){
        return origFetch(pu,newOpts)
      }else{
        var clonedHeaders=new Headers(r.headers||{});
        
        // 🔴 CSRFトークン追加
        if (ct0 && !clonedHeaders.has('x-csrf-token')) {
          clonedHeaders.set('x-csrf-token', ct0);
        }
        
        var nr=new Request(pu,{
          method:r.method||"GET",
          headers:clonedHeaders,
          body:r.body,
          credentials:"include"
        });
        return origFetch(nr,newOpts)
      }
    }
    return origFetch(r,o)
  };
  
  console.log("[Proxy] Enhanced intercept OK");
})();
</script>`;
  var mainScript = '<script>document.addEventListener("visibilitychange",function(){if(!document.hidden){console.log("[Proxy] Tab visible")}},true);</script>';

  // <head>に注入
  html = html.replace(/<head([^>]*)>/i, function(match, attrs) {
    return '<head' + attrs + '>' + cspMeta + earlyScript + mainScript;
  });
  
  // Google削除
  html = html.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
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
          protocolTimeout: 120000
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
          ],
          protocolTimeout: 120000
        };
      }

      browser = await puppeteer.puppeteerCore.launch(launchConfig);
      console.log('✅ Browser initialized with extended timeout');
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

  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

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

 async function getOrCreateSearchPage() {
  if (!searchPage) {
   console.log('🔍 [SEARCH-PAGE] Creating dedicated search page...');
    const browserInstance = await initBrowser();
    searchPage = await browserInstance.newPage();
    
    searchPage.setDefaultNavigationTimeout(20000);
    searchPage.setDefaultTimeout(20000);
    
    await searchPage.setViewport({ width: 1920, height: 1080 });
    await searchPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    
    // Cookieを設定
    const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
    if (hasCookies) {
      await searchPage.setCookie(...cachedXCookies);
      console.log('✅ [SEARCH-PAGE] Cookies set');
    }
    
    console.log('✅ [SEARCH-PAGE] Dedicated search page created');
  }
  return searchPage;
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
// ===== 🔴 CRITICAL: SearchTimeline特別ハンドラー =====
// 📍 この位置: OPTIONS routeの直後、通常のGET routeの前

app.options(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token, x-twitter-active-user, x-twitter-client-language, x-twitter-auth-type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).send();
});

// 🔴 SearchTimeline検出専用ミドルウェア
app.use(`${PROXY_PATH}:encodedUrl*`, async (req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);
    
    const isSearchTimeline = targetUrl.includes('SearchTimeline') && targetUrl.includes('graphql');
    
    if (!isSearchTimeline) {
      return next();
    }
    
    console.log('🔍 [SEARCH] ✅ Detected SearchTimeline API request');
    console.log('🔍 [SEARCH] Using DEDICATED search page (independent from xLoginPage)');
    
    const urlObj = new URL(targetUrl);
    const variables = urlObj.searchParams.get('variables');
    
    if (!variables) {
      return res.status(400).json({ error: 'No search variables found' });
    }
    
    let searchQuery;
    try {
      const varsObj = JSON.parse(variables);
      searchQuery = varsObj.rawQuery;
      console.log('🔍 [SEARCH] Query:', searchQuery);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid variables format' });
    }
    
    if (!searchQuery) {
      return res.status(400).json({ error: 'No search query found' });
    }
    
    const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
    
    if (!hasCookies) {
      return res.status(503).json({
        error: 'Search requires authentication. Please inject cookies first.',
        hasCookies: false
      });
    }
    
    // 🔴 検索ページがビジー状態かチェック
    if (searchPageBusy) {
      console.log('⚠️ [SEARCH] Search page is busy, returning error');
      return res.status(503).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>検索中...</title>
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
            .box {
              background: rgba(255,255,255,0.05);
              border: 1px solid rgba(255,255,255,0.1);
              border-radius: 8px;
              padding: 40px;
              max-width: 500px;
              text-align: center;
            }
            h1 { color: #ffa726; margin-bottom: 20px; }
            p { color: rgba(255,255,255,0.7); line-height: 1.6; }
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
          </style>
        </head>
        <body>
          <div class="box">
            <h1>🔍 別の検索が実行中です</h1>
            <p>別の検索リクエストを処理中です。</p>
            <p>数秒待ってから再度お試しください。</p>
            <a href="javascript:history.back()">戻る</a>
          </div>
        </body>
        </html>
      `);
    }
    
    searchPageBusy = true;
    
    try {
      console.log('🔍 [SEARCH] Starting search with dedicated page...');
      
      const page = await getOrCreateSearchPage();
      const searchUrl = `https://x.com/search?q=${encodeURIComponent(searchQuery)}&src=typed_query`;
      console.log('🔍 [SEARCH] URL:', searchUrl);
      
      // ナビゲーション
      try {
        const navPromise = page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 15000
        });
        
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => {
            console.log('⚠️ [SEARCH] 10s passed, getting content...');
            resolve('timeout');
          }, 10000);
        });
        
        await Promise.race([navPromise, timeoutPromise]);
      } catch (navError) {
        console.log('⚠️ [SEARCH] Nav error:', navError.message);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // コンテンツ取得
      let html = null;
      for (let i = 0; i < 2; i++) {
        try {
          console.log(`🔍 [SEARCH] Getting content (attempt ${i + 1}/2)...`);
          html = await page.content();
          
          if (html && html.length > 5000) {
            console.log(`✅ [SEARCH] Got HTML (${html.length} bytes)`);
            break;
          }
          
          if (i < 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (e) {
          console.log(`❌ [SEARCH] Attempt ${i + 1} failed:`, e.message);
        }
      }
      
      if (!html || html.length < 5000) {
        throw new Error('Failed to get valid search page content');
      }
      
      const rewrittenHTML = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(rewrittenHTML);
      
      console.log('✅ [SEARCH] Response sent successfully');
      
    } catch (searchError) {
      console.error('❌ [SEARCH] Error:', searchError.message);
      
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>検索エラー</title>
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
            p { color: rgba(255,255,255,0.7); line-height: 1.6; margin-bottom: 15px; }
            code { 
              background: rgba(0,0,0,0.3);
              padding: 2px 8px;
              border-radius: 4px;
              font-family: monospace;
            }
            a {
              display: inline-block;
              margin: 10px;
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
            <h1>🔍 検索に失敗しました</h1>
            <p><strong>検索:</strong> <code>${searchQuery}</code></p>
            <p>${searchError.message}</p>
            <div>
              <a href="javascript:location.reload()">再読み込み</a>
              <a href="javascript:history.back()">戻る</a>
            </div>
          </div>
        </body>
        </html>
      `);
    } finally {
      searchPageBusy = false;
    }
    
  } catch (error) {
    console.error('❌ [SEARCH] Handler error:', error.message);
    searchPageBusy = false;
    next();
  }
});




// 🔴 CRITICAL: GET proxy route with Puppeteer
app.get(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  console.log('🔵 [PROXY] GET request received');
  
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);
    console.log('🔡 GET Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    
    const isApiEndpoint = parsedUrl.hostname.includes('api.x.com') || 
                          parsedUrl.pathname.includes('.json') ||
                          parsedUrl.pathname.includes('graphql');
    
    const isMediaFile = parsedUrl.pathname.match(/\.(js|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|mp4|webm|m3u8|ts|m4s|mpd)$/i) ||
                        parsedUrl.hostname.includes('video.twimg.com') ||
                        parsedUrl.hostname.includes('video-s.twimg.com') ||
                        parsedUrl.hostname.includes('pbs.twimg.com') ||
                        parsedUrl.hostname.includes('abs.twimg.com');
    
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
          
          // 🔴 CRITICAL: Send cookies to browser
          if (isXDomain && hasCookies) {
            try {
              console.log('🍪 [COOKIE] Sending cookies to browser...');
              console.log('🍪 [COOKIE] Cookie count:', cachedXCookies.length);
              
              const setCookieHeaders = cachedXCookies
                .filter(c => c && c.name && c.value)
                .map(c => {
                  const parts = [
                    `${c.name}=${c.value}`,
                    `Path=/`,
                    `Max-Age=${60 * 60 * 24 * 365}`,
                  ];
                  
                  if (process.env.RENDER) {
                    parts.push('Secure');
                  }
                  
                  if (c.name === 'ct0') {
                    parts.push('SameSite=Lax');
                  } else {
                    parts.push('SameSite=None');
                    if (!process.env.RENDER) {
                      parts.push('Secure');
                    }
                  }
                  
                  return parts.join('; ');
                });
              
              if (setCookieHeaders.length > 0) {
                res.setHeader('Set-Cookie', setCookieHeaders);
                console.log('✅ [COOKIE] Set-Cookie header added:', setCookieHeaders.length, 'cookies');
              }
            } catch (e) {
              console.error('❌ [COOKIE] Failed:', e.message);
            }
          }
          
          return res.send(rewrittenHTML);
          
        } else {
          console.log('🆕 Creating new page');
          const browserInstance = await initBrowser();
          page = await browserInstance.newPage();
          
          page.setDefaultNavigationTimeout(60000);
          page.setDefaultTimeout(60000);
          
          await page.setViewport({ width: 1920, height: 1080 });
          await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          );

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

        console.log(`🌐 Navigating to: ${targetUrl}`);
        
        if (isXDomain) {
          try {
            await page.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 60000
            });
            console.log('✅ DOM loaded');
          } catch (navErr) {
            console.log('⚠️ Navigation timeout:', navErr.message);
          }

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

          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
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

        const htmlContent = await page.content();
        console.log(`✅ Page loaded successfully (${htmlContent.length} bytes)`);

        if (page && page !== xLoginPage) {
          await page.close();
        }

        const rewrittenHTML = rewriteHTML(htmlContent, targetUrl);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // 🔴 CRITICAL: Send cookies to browser
        if (isXDomain && hasCookies) {
          try {
            console.log('🍪 [COOKIE] Sending cookies to browser...');
            console.log('🍪 [COOKIE] Cookie count:', cachedXCookies.length);
            
            const setCookieHeaders = cachedXCookies
              .filter(c => c && c.name && c.value)
              .map(c => {
                const parts = [
                  `${c.name}=${c.value}`,
                  `Path=/`,
                  `Max-Age=${60 * 60 * 24 * 365}`,
                ];
                
                if (process.env.RENDER) {
                  parts.push('Secure');
                }
                
                if (c.name === 'ct0') {
                  parts.push('SameSite=Lax');
                } else {
                  parts.push('SameSite=None');
                  if (!process.env.RENDER) {
                    parts.push('Secure');
                  }
                }
                
                return parts.join('; ');
              });
            
            if (setCookieHeaders.length > 0) {
              res.setHeader('Set-Cookie', setCookieHeaders);
              console.log('✅ [COOKIE] Set-Cookie header added:', setCookieHeaders.length, 'cookies');
            }
          } catch (e) {
            console.error('❌ [COOKIE] Failed:', e.message);
          }
        }
        
        res.send(rewrittenHTML);

      } catch (navError) {
        console.error('❌ Navigation error:', navError.message);
        
        if (navError.message.includes('aborted') || navError.message.includes('ERR_ABORTED')) {
          console.log('⚠️ Request aborted, returning 204');
          res.status(204).send();
          if (!useXLoginPageShared && page) {
            await page.close().catch(() => {});
          }
          return;
        }
        
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
          
          if (isApiEndpoint) {
            const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
            if (ct0Cookie && ct0Cookie.value) {
              headers['x-csrf-token'] = ct0Cookie.value;
              console.log('🔐 Added CSRF token for API');
            }
            
            headers['x-twitter-active-user'] = 'yes';
            headers['x-twitter-client-language'] = 'en';
            headers['x-twitter-auth-type'] = 'OAuth2Session';
            
            if (targetUrl.includes('SearchTimeline')) {
              headers['Referer'] = 'https://x.com/search';
            }
            
            if (targetUrl.includes('graphql')) {
              headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
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
        
        try {
          const errorBody = response.data.toString('utf-8');
          console.log('❌ Error body:', errorBody.substring(0, 200));
          
          if (errorBody.includes('"code":215') || errorBody.includes('Bad Authentication')) {
            console.log('🚨 AUTHENTICATION ERROR - Cookies may be invalid');
            res.setHeader('X-Proxy-Error', 'Authentication Failed');
          }
        } catch (e) {
          console.log('❌ Could not parse error body');
        }
      }

      const contentType = response.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(response.data);
    }

  } catch (error) {
    console.error('❌ GET Proxy error:', error.message);
    
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

app.get('/api/x-cookies-debug', async (req, res) => {
  try {
    const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
    
    if (!hasCookies) {
      return res.json({
        success: false,
        error: 'No cookies cached',
        cookieCount: 0
      });
    }
    
    // Cookie の詳細情報
    const cookieDetails = cachedXCookies.map(c => ({
      name: c.name,
      hasValue: !!c.value,
      valueLength: c.value ? c.value.length : 0,
      valuePreview: c.value ? c.value.substring(0, 10) + '...' : 'empty',
      domain: c.domain,
      httpOnly: c.httpOnly,
      secure: c.secure,
      expires: c.expires ? new Date(c.expires * 1000).toISOString() : 'session',
      isExpired: c.expires ? (c.expires * 1000 < Date.now()) : false
    }));
    
    const authToken = cachedXCookies.find(c => c.name === 'auth_token');
    const ct0 = cachedXCookies.find(c => c.name === 'ct0');
    
    return res.json({
      success: true,
      cookieCount: cachedXCookies.length,
      hasAuthToken: !!authToken,
      hasCt0: !!ct0,
      authTokenExpired: authToken && authToken.expires ? (authToken.expires * 1000 < Date.now()) : null,
      ct0Expired: ct0 && ct0.expires ? (ct0.expires * 1000 < Date.now()) : null,
      cookies: cookieDetails
    });
    
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/test-cookie-send', (req, res) => {
  console.log('🧪 [TEST] Cookie send test endpoint called');
  
  const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;
  
  if (!hasCookies) {
    return res.status(400).json({
      success: false,
      error: 'No cached cookies available. Please inject cookies first at /x-cookie-helper.html'
    });
  }
  
  try {
    console.log('🧪 [TEST] Generating Set-Cookie headers...');
    console.log('🧪 [TEST] Cached cookie count:', cachedXCookies.length);
    
    // Set-Cookieヘッダーを生成
    const setCookieHeaders = cachedXCookies
      .filter(c => {
        if (!c || !c.name || !c.value) {
          console.log('🧪 [TEST] Skipping invalid cookie:', c);
          return false;
        }
        return true;
      })
      .map(c => {
        const parts = [
          `${c.name}=${c.value}`,
          `Path=/`,
          `Max-Age=${60 * 60 * 24 * 365}`, // 1年間有効
        ];
        
        // Render環境の場合はSecureを追加
        if (process.env.RENDER) {
          parts.push('Secure');
        }
        
        // SameSite属性
        if (c.name === 'ct0') {
          parts.push('SameSite=Lax');
        } else {
          parts.push('SameSite=None');
          // ローカル環境でもSecureが必要
          if (!process.env.RENDER) {
            parts.push('Secure');
          }
        }
        
        return parts.join('; ');
      });
    
    if (setCookieHeaders.length === 0) {
      throw new Error('No valid cookies to send');
    }
    
    // Set-Cookieヘッダーを設定
    res.setHeader('Set-Cookie', setCookieHeaders);
    console.log('✅ [TEST] Set-Cookie headers added:', setCookieHeaders.length);
    
    // HTMLレスポンス
    res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cookie送信テスト</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
      color: #fff;
      padding: 40px 20px;
      min-height: 100vh;
    }
    .container { max-width: 800px; margin: 0 auto; }
    h1 {
      font-size: 32px;
      margin-bottom: 20px;
      text-align: center;
      background: linear-gradient(135deg, #4CAF50 0%, #8BC34A 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 30px;
      margin-bottom: 20px;
    }
    .status-box {
      padding: 20px;
      border-radius: 8px;
      margin: 15px 0;
      font-size: 14px;
      line-height: 1.8;
    }
    .status-ok {
      background: rgba(76,175,80,0.1);
      border: 2px solid #4CAF50;
    }
    .status-error {
      background: rgba(244,67,54,0.1);
      border: 2px solid #f44336;
    }
    button {
      padding: 14px 24px;
      background: #2196F3;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      margin: 10px 10px 10px 0;
    }
    button:hover { background: #1976D2; transform: translateY(-2px); }
    button.success { background: #4CAF50; }
    button.success:hover { background: #45a049; }
    pre {
      background: rgba(0,0,0,0.3);
      padding: 15px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.6;
      font-family: 'Courier New', monospace;
    }
    .section-title {
      font-size: 18px;
      color: #b0b0b0;
      margin: 25px 0 15px 0;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .info {
      color: rgba(255,255,255,0.6);
      font-size: 13px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>✅ Cookie送信テスト成功</h1>
    
    <div class="card">
      <div class="status-ok">
        <strong>🍪 Set-Cookieヘッダーを送信しました</strong><br><br>
        送信Cookie数: <strong>${setCookieHeaders.length}個</strong><br>
        Cookie名: <code>${cachedXCookies.map(c => c.name).join(', ')}</code>
      </div>
      
      <div class="section-title">ブラウザCookie確認</div>
      <button onclick="checkCookies()">🔍 Cookieを確認</button>
      <button onclick="location.href='/home'" class="success">🏠 タイムラインをテスト</button>
      <button onclick="location.href='/cookie-diagnostic.html'">📊 診断ツールへ</button>
      
      <div id="result" style="margin-top: 20px; display: none;"></div>
    </div>

    <div class="card">
      <div class="section-title">💡 次のステップ</div>
      <ol style="line-height: 1.8; margin-left: 20px;">
        <li>上の「Cookieを確認」ボタンをクリックして、ブラウザにCookieが保存されたか確認</li>
        <li>10個以上のCookieが表示されればOK</li>
        <li>「タイムラインをテスト」ボタンで /home にアクセス</li>
        <li>ツイートが表示されれば成功！🎉</li>
      </ol>
      
      <div class="info">
        ℹ️ auth_tokenはHttpOnlyのため、document.cookieでは確認できませんが、
        F12 → Application → Cookies で確認できます
      </div>
    </div>
  </div>

  <script>
    function checkCookies() {
      const result = document.getElementById('result');
      const cookies = document.cookie;
      
      if (!cookies) {
        result.className = 'status-box status-error';
        result.innerHTML = 
          '<strong>❌ Cookieが見つかりません</strong><br><br>' +
          'ブラウザがCookieをブロックしている可能性があります。<br>' +
          'ブラウザの設定でCookieを有効にしてください。';
        result.style.display = 'block';
        return;
      }
      
      const cookiePairs = cookies.split(';').map(c => c.trim());
      const count = cookiePairs.length;
      
      const statusClass = count >= 10 ? 'status-ok' : 'status-error';
      const icon = count >= 10 ? '✅' : '⚠️';
      
      result.className = 'status-box ' + statusClass;
      result.innerHTML = 
        '<strong>' + icon + ' ブラウザCookie確認結果</strong><br><br>' +
        'ブラウザに保存されたCookie数: <strong>' + count + '個</strong><br><br>' +
        '<pre>' + cookies + '</pre>' +
        '<div class="info">ℹ️ auth_tokenはHttpOnlyのため表示されません（正常）</div>';
      result.style.display = 'block';
      
      // F12を開いているか確認して案内
      if (count >= 10) {
        setTimeout(() => {
          alert(
            '✅ Cookie送信成功！\\n\\n' +
            count + '個のCookieがブラウザに保存されました。\\n\\n' +
            '次は「タイムラインをテスト」ボタンで /home にアクセスしてください！'
          );
        }, 500);
      }
    }
    
    // ページ読み込み時に自動実行
    setTimeout(checkCookies, 1000);
    
    // F12でApplication → Cookiesの確認を促す
    console.log('=== Cookie送信テスト ===');
    console.log('✅ Set-Cookieヘッダーで ${setCookieHeaders.length} 個のCookieを送信しました');
    console.log('📋 Cookie名:', '${cachedXCookies.map(c => c.name).join(', ')}');
    console.log('');
    console.log('💡 全てのCookieを確認するには:');
    console.log('   F12 → Application → Cookies → https://yubikiri-proxy-pro-x.onrender.com');
    console.log('');
    console.log('🍪 auth_token, ct0 などのHttpOnly Cookieもここで確認できます');
  </script>
</body>
</html>
    `);
    
    console.log('✅ [TEST] Test page sent successfully');
    
  } catch (error) {
    console.error('❌ [TEST] Error:', error.message);
    console.error('❌ [TEST] Stack:', error.stack);
    
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

この診断エンドポイントで以下を確認してください:

https://yubikiri-proxy-pro-x.onrender.com/api/x-cookies-debug

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

// 🆕 検索ページのリダイレクト
app.get('/search', (req, res) => {
  console.log('🔄 Redirecting /search to proxied X.com');
  const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
  const targetUrl = `https://x.com/search${queryString ? '?' + queryString : ''}`;
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