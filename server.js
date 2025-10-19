const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const url = require('url');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

let browser;
let puppeteer;

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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

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

  // hrefを書き換え
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

  // srcを書き換え
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

  // actionを書き換え
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
        
        // Google無効化
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
        
        // fetch インターセプト
        const originalFetch = window.fetch;
        window.fetch = function(resource, options) {
          let url = typeof resource === 'string' ? resource : (resource.url || resource);
          
          // Google関連はブロック
          if (url.includes('google.com') || url.includes('gstatic.com')) {
            console.log('[Proxy] Blocked:', url);
            return Promise.reject(new Error('Blocked'));
          }
          
          // blob/dataはそのまま
          if (url.startsWith('blob:') || url.startsWith('data:')) {
            return originalFetch.call(this, resource, options);
          }
          
          // プロキシ経由のURLはそのまま
          if (url.startsWith(PROXY_ORIGIN + '/proxy/')) {
            return originalFetch.call(this, resource, options);
          }
          
          const absoluteUrl = toAbsoluteUrl(url);
          
          // 外部URLの場合
          if (absoluteUrl.startsWith('http')) {
            const proxyUrl = encodeProxyUrl(absoluteUrl);
            console.log('[Proxy] Fetch:', url, '->', proxyUrl);
            
            // オプションを調整
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

        // XMLHttpRequest インターセプト
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (typeof url === 'string') {
            // Google関連はブロック
            if (url.includes('google.com') || url.includes('gstatic.com')) {
              console.log('[Proxy] Blocked XHR:', url);
              throw new Error('Blocked');
            }
            
            // blob/dataはそのまま
            if (!url.startsWith('blob:') && !url.startsWith('data:')) {
              // プロキシ経由でなければ変換
              if (!url.startsWith(PROXY_ORIGIN + '/proxy/')) {
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

        // エラー抑制
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
  
  // Google関連スクリプト削除
  html = html.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*src=[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe[^>]*google[^>]*>[\s\S]*?<\/iframe>/gi, '');

  if (!html.includes('charset')) {
    html = html.replace(/<head[^>]*>/i, '<head><meta charset="UTF-8">');
  }

  return html;
}

// server.js の修正部分（app.get('/proxy/:encodedUrl*', ...) 内）

app.get('/proxy/:encodedUrl*', async (req, res) => {
  let page;
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 Proxying:', targetUrl);
    
    const parsedUrl = new url.URL(targetUrl);
    const ext = path.extname(parsedUrl.pathname).toLowerCase();
    const staticExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.css', '.js', '.woff', '.woff2', '.ttf', '.svg', '.ico', '.mp4', '.webm', '.json'];

    const shouldDirectFetch = staticExtensions.includes(ext) ||
                             parsedUrl.pathname.includes('/api/') ||
                             parsedUrl.pathname.includes('/graphql/') ||
                             parsedUrl.pathname.includes('/1.1/') ||
                             parsedUrl.pathname.includes('/i/api/') ||
                             parsedUrl.pathname.includes('/2/') ||
                             parsedUrl.hostname.startsWith('api.') ||
                             parsedUrl.hostname.includes('google');

    if (shouldDirectFetch) {
      const headers = {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
        'Accept-Encoding': req.headers['accept-encoding'] || 'gzip, deflate, br',
      };

      const refererUrl = new url.URL(targetUrl);
      headers['Referer'] = `${refererUrl.protocol}//${refererUrl.host}/`;
      headers['Origin'] = `${refererUrl.protocol}//${refererUrl.host}`;

      if (req.headers.cookie) {
        headers['Cookie'] = req.headers.cookie;
      }
      
      // キャッシュされたCookieを使用
      if (cachedXCookies && (parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com'))) {
        let cookieString = cachedXCookies
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        headers['Cookie'] = cookieString;
        console.log('🍪 Using cached cookies for API request');
      }

      if (req.headers.authorization) {
        headers['Authorization'] = req.headers.authorization;
      }
      
      if (parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com')) {
        headers['x-twitter-active-user'] = 'yes';
        headers['x-twitter-client-language'] = 'en';
      }

      console.log('📄 Direct fetch:', targetUrl);

      const response = await axios({
        method: 'GET',
        url: targetUrl,
        headers: headers,
        responseType: 'arraybuffer',
        timeout: 30000,
        validateStatus: () => true,
        maxRedirects: 5
      });

      const contentType = response.headers['content-type'] || '';
      
      res.setHeader('Content-Type', contentType);
      
      if (response.headers['set-cookie']) {
        res.setHeader('Set-Cookie', response.headers['set-cookie']);
      }
      
      if (response.headers['cache-control']) {
        res.setHeader('Cache-Control', response.headers['cache-control']);
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      return res.send(response.data);
    }

    // HTMLページはPuppeteerで取得
    const browserInstance = await initBrowser();

    // xLoginPageを再利用（Cookieが設定済み）
    if (xLoginPage && cachedXCookies) {
      console.log('🔄 Reusing xLoginPage with cached cookies');
      page = xLoginPage;
    } else {
      console.log('📍 Creating new page');
      page = await browserInstance.newPage();
      
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

      // ⚠️ 重要: リクエストインターセプションは1回だけ設定
      await page.setRequestInterception(true);
      
      // ⚠️ 修正: リクエストハンドラーの重複を防ぐ
      page.removeAllListeners('request'); // 既存のリスナーをクリア
      
      page.on('request', (request) => {
        const requestUrl = request.url();
        
        // 既に処理済みの場合はスキップ
        if (request.isInterceptResolutionHandled()) {
          return;
        }
        
        const isGoogleResource = (
          requestUrl.includes('google.com') ||
          requestUrl.includes('gstatic.com') ||
          requestUrl.includes('googleapis.com') ||
          requestUrl.includes('doubleclick.net')
        );
        
        if (isGoogleResource) {
          console.log('🚫 Blocked Google:', requestUrl);
          request.abort().catch(() => {});
          return;
        }
        
        request.continue().catch(() => {});
      });

      // Cookieを事前にセット
      if (cachedXCookies && (parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com'))) {
        try {
          await page.setCookie(...cachedXCookies);
          console.log('🍪 Set cached cookies before navigation');
        } catch (e) {
          console.log('⚠️ Could not set cookies:', e.message);
        }
      }
    }

    // ステルスモード設定
    await page.evaluateOnNewDocument(() => {
      delete Object.getPrototypeOf(navigator).webdriver;
      
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: false
      });

      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
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
        if (msg.includes('GSI') || msg.includes('google') || msg.includes('client ID')) {
          return;
        }
        return originalError.apply(console, args);
      };

      console.warn = function(...args) {
        const msg = args.join(' ');
        if (msg.includes('GSI') || msg.includes('google') || msg.includes('FedCM')) {
          return;
        }
        return originalWarn.apply(console, args);
      };

      window.addEventListener('unhandledrejection', (event) => {
        const msg = String(event.reason);
        if (msg.includes('google') || msg.includes('GSI')) {
          event.preventDefault();
        }
      });
    });

    // ⚠️ 修正: タイムアウトを短縮 & リトライを防ぐ
    console.log('🌐 Navigating to:', targetUrl);
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded', // networkidle2 → domcontentloaded に変更
      timeout: 15000 // 20秒 → 15秒に短縮
    }).catch((e) => {
      console.log('⚠️ Navigation timeout (non-critical):', e.message);
    });

    await new Promise(resolve => setTimeout(resolve, 2000)); // 1.5秒 → 2秒

    let htmlContent = await page.content();
    
    // Google要素削除
    htmlContent = htmlContent.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
    htmlContent = htmlContent.replace(/<script[^>]*src=[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '');
    htmlContent = htmlContent.replace(/<iframe[^>]*google[^>]*>[\s\S]*?<\/iframe>/gi, '');
    htmlContent = htmlContent.replace(/<div[^>]*id=["']g_id[^>]*>[\s\S]*?<\/div>/gi, '');
    htmlContent = htmlContent.replace(/google\.accounts\.id\.[^;]+;?/gi, '');
    htmlContent = htmlContent.replace(/google\.accounts\.id\.prompt\([^)]*\);?/gi, '');
    
    const cookies = await page.cookies();
    if (cookies.length > 0) {
      const setCookieHeaders = cookies.map(cookie => {
        return `${cookie.name}=${cookie.value}; Path=${cookie.path || '/'}; ${cookie.httpOnly ? 'HttpOnly;' : ''} ${cookie.secure ? 'Secure;' : ''}`;
      });
      res.setHeader('Set-Cookie', setCookieHeaders);
    }

    htmlContent = rewriteHTML(htmlContent, targetUrl);
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlContent);

    // xLoginPageは閉じない
    if (page !== xLoginPage) {
      await page.close().catch(() => {});
    }

  } catch (error) {
    if (page && page !== xLoginPage) {
      try {
        await page.close().catch(() => {});
      } catch (e) {}
    }

    console.error('❌ Proxy error:', error.message);
    res.status(500).send(`<html><body><h1>Error</h1><p>${error.message}</p></body></html>`);
  }
});

app.post('/proxy/:encodedUrl*', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 POST Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': req.headers.accept || '*/*',
      'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    };

    headers['Origin'] = `${parsedUrl.protocol}//${parsedUrl.host}`;
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    if (req.headers.cookie) {
      headers['Cookie'] = req.headers.cookie;
    }

    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization;
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

    const contentType = response.headers['content-type'] || '';

    if (response.headers['set-cookie']) {
      res.setHeader('Set-Cookie', response.headers['set-cookie']);
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
    res.status(500).json({ error: error.message });
  }
});

app.options('/proxy/:encodedUrl*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).send();
});

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== Xログイン機能 =====
const { loginToX } = require('./x-login');

let xLoginPage = null;
let cachedXCookies = null;

// ===== 以下を const { loginToX } = require('./x-login'); の直後に追加 =====

/**
 * Xページアクセステスト関数
 */
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

// server.js の initXLoginPage() を完全に置き換え

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

  // ⚠️ 重要: リクエストインターセプションは1回だけ
  await page.setRequestInterception(true);
  
  // ⚠️ 修正: 既存のリスナーをクリア
  page.removeAllListeners('request');
  
  page.on('request', (request) => {
    const requestUrl = request.url();
    
    // 既に処理済みの場合はスキップ
    if (request.isInterceptResolutionHandled()) {
      return;
    }
    
    if (requestUrl.includes('google.com') || 
        requestUrl.includes('gstatic.com') ||
        requestUrl.includes('googleapis.com')) {
      request.abort().catch(() => {});
      return;
    }
    
    request.continue().catch(() => {});
  });

  // ステルスモード設定
  await page.evaluateOnNewDocument(() => {
    delete Object.getPrototypeOf(navigator).webdriver;
    
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: false
    });

    window.chrome = {
      app: { isInstalled: false },
      runtime: {},
      loadTimes: function() {
        return {
          commitLoadTime: Date.now() / 1000 - Math.random(),
          connectionInfo: 'http/1.1',
          finishDocumentLoadTime: Date.now() / 1000 - Math.random(),
          finishLoadTime: Date.now() / 1000 - Math.random(),
          navigationType: 'Other',
          requestTime: Date.now() / 1000 - Math.random() * 2,
          startLoadTime: Date.now() / 1000 - Math.random()
        };
      },
      csi: function() {
        return {
          onloadT: Date.now(),
          pageT: Date.now() - Math.random() * 1000,
          startE: Date.now() - Math.random() * 2000
        };
      }
    };

    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3],
      configurable: true
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true
    });

    Object.defineProperty(navigator, 'platform', {
      get: () => 'Win32',
      configurable: true
    });

    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true
    });

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

/**
 * GET /api/x-cookies - Cookie確認
 */
app.get('/api/x-cookies', async (req, res) => {
  try {
    const hasCachedCookies = !!cachedXCookies;
    
    if (!hasCachedCookies && !xLoginPage) {
      return res.status(400).json({ 
        success: false,
        error: 'No cookies cached. Please inject cookies first.',
        cached: false
      });
    }

    let cookies = [];
    let authToken = null;

    if (cachedXCookies) {
      cookies = cachedXCookies;
      authToken = cookies.find(c => c.name === 'auth_token');
    } else if (xLoginPage) {
      cookies = await xLoginPage.cookies();
      authToken = cookies.find(c => c.name === 'auth_token');
    }

    return res.json({
      success: true,
      isLoggedIn: !!authToken,
      cached: hasCachedCookies,
      cookies: cookies.map(c => ({
        name: c.name,
        domain: c.domain,
        expires: c.expires ? new Date(c.expires * 1000).toISOString() : 'session'
      })),
      currentUrl: xLoginPage ? xLoginPage.url() : 'N/A',
      message: hasCachedCookies ? 'Cookies are cached and persistent' : 'Cookies from session only'
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/x-test - Xページアクセステスト
 */
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

/**
 * POST /api/x-inject-cookies - Cookie注入
 */
app.get('/api/x-cookies', async (req, res) => {
  try {
    if (!xLoginPage) {
      return res.status(400).json({ 
        success: false,
        error: 'No active session. Please login first.' 
      });
    }

    const cookies = await xLoginPage.cookies();
    const authToken = cookies.find(c => c.name === 'auth_token');

    return res.json({
      success: true,
      isLoggedIn: !!authToken,
      cookies: cookies.map(c => ({
        name: c.name,
        domain: c.domain
      })),
      currentUrl: xLoginPage.url()
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/x-cookies - Cookieキャッシュ削除
 */
app.delete('/api/x-cookies', async (req, res) => {
  try {
    cachedXCookies = null;
    console.log('[API] Cookie cache cleared');

    if (xLoginPage) {
      const cookies = await xLoginPage.cookies();
      for (const cookie of cookies) {
        await xLoginPage.deleteCookie(cookie);
      }
      console.log('[API] xLoginPage cookies cleared');
    }

    return res.json({
      success: true,
      message: 'All X cookies cleared'
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/x-test - Xページアクセステスト
 */
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

/**
 * POST /api/x-inject-cookies - Cookie注入（永続化対応）
 */
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

    cachedXCookies = cookies;
    console.log('[API] ✅ Cookies cached globally');

    if (!xLoginPage) {
      xLoginPage = await initXLoginPage();
    }

    await xLoginPage.goto('https://x.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    await xLoginPage.setCookie(...cookies);
    console.log('[API] ✅ Cookies set in Puppeteer page');

    await xLoginPage.reload({
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    const currentUrl = xLoginPage.url();
    const allCookies = await xLoginPage.cookies();
    const hasAuthToken = allCookies.some(c => c.name === 'auth_token');

    console.log('[API] Current URL:', currentUrl);
    console.log('[API] Has auth_token:', hasAuthToken);

    return res.json({
      success: true,
      message: 'Cookies cached. Will persist across all requests.',
      isLoggedIn: hasAuthToken,
      currentUrl,
      cached: true,
      cookies: allCookies.map(c => ({
        name: c.name,
        domain: c.domain
      }))
    });

  } catch (error) {
    console.error('[API] Cookie injection error:', error.message);
    
    if (cachedXCookies) {
      return res.json({
        success: true,
        message: 'Cookies cached (verification skipped)',
        warning: error.message,
        cached: true
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Cookie injection failed',
      message: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Yubikiri Proxy Pro running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});