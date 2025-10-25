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

// ===== 変数宣言 =====
let browser;
let puppeteer;
let xLoginPage = null;
let cachedXCookies = null;
let xLoginPageBusy = false;
const xLoginPageQueue = [];

const COOKIE_FILE = path.join(__dirname, '.x-cookies.json');

// ===== 3. COOKIE FUNCTIONS =====
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

// 起動時にCookieロード
cachedXCookies = loadCookiesFromFile();
if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0) {
  console.log('✅ Cached cookies restored from file');
  console.log(`   Cookie count: ${cachedXCookies.length}`);
}

// ===== 4. MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ===== 5. UTILITY FUNCTIONS =====
function encodeProxyUrl(targetUrl) {
  return Buffer.from(targetUrl).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function decodeProxyUrl(encoded) {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

const PROXY_PATH = '/proxy/';

// ===== 6. REWRITE HTML (改変なし) =====
function rewriteHTML(html, baseUrl) {
  const urlObj = new url.URL(baseUrl);
  const origin = `${urlObj.protocol}//${urlObj.host}`;
  const proxyOrigin = process.env.RENDER
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : `http://localhost:${PORT}`;

  // 既にプロキシ化されているか確認
  function isAlreadyProxied(urlString) {
    return urlString.includes('/proxy/') || urlString.includes(proxyOrigin);
  }

  // href, src, video source, form action をプロキシ化
  html = html.replace(/(href|src|action)=["']([^"']+)["']/gi, (match, attr, value) => {
    if (value.startsWith('javascript:') || value.startsWith('#') || value.startsWith('mailto:') || value.startsWith('tel:') || isAlreadyProxied(value)) {
      return match;
    }
    let absoluteUrl = value;
    try {
      if (value.startsWith('//')) absoluteUrl = urlObj.protocol + value;
      else if (value.startsWith('/')) absoluteUrl = origin + value;
      else if (!value.startsWith('http')) absoluteUrl = new url.URL(value, baseUrl).href;
      return `${attr}="/proxy/${encodeProxyUrl(absoluteUrl)}"`;
    } catch {
      return match;
    }
  });

  // 不要スクリプト除去 + charset強制
  html = html.replace(/<script[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '');
  if (!html.includes('charset')) {
    html = html.replace(/<head[^>]*>/i, '<head><meta charset="UTF-8">');
  }

  return html;
}

// ===== 7. PUPPETEER SETUP =====
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
      if (!puppeteer) puppeteer = await loadPuppeteer();

      let launchConfig;
      if (puppeteer.isRender) {
        const chromium = puppeteer.chromium;
        launchConfig = {
          args: [
            ...chromium.args,
            '--disable-blink-features=AutomationControlled'
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
            '--disable-blink-features=AutomationControlled'
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
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('google.com') || url.includes('gstatic.com') || url.includes('googleapis.com')) {
      request.abort().catch(() => {});
    } else {
      request.continue().catch(() => {});
    }
  });

  await page.evaluateOnNewDocument(() => {
    delete Object.getPrototypeOf(navigator).webdriver;
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('✅ X login page initialized');
  return page;
}

async function useXLoginPage(callback) {
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
    if (xLoginPageQueue.length > 0) {
      const next = xLoginPageQueue.shift();
      setImmediate(next);
    }
  }
}
// ===== 8. TEST ROUTES =====
app.get('/test', (req, res) => {
  res.json({ status: '✅ Routes are working!', cookies: !!cachedXCookies });
});

// ===== 9. PROXY (GET / POST / PUT / OPTIONS) =====
app.options(`${PROXY_PATH}:encodedUrl*`, (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.status(204).send();
});

app.get(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const targetUrl = decodeProxyUrl(req.params.encodedUrl + (req.params[0] || ''));
    console.log('📡 GET Proxying:', targetUrl);

    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0' }
    });

    // HTMLを自動書き換え（rewriteHTML）
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf8');
      const rewritten = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(rewritten);
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }
  } catch (error) {
    console.error('❌ GET Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const targetUrl = decodeProxyUrl(req.params.encodedUrl + (req.params[0] || ''));
    console.log('📡 POST Proxying:', targetUrl);

    const response = await axios.post(targetUrl, req.body, {
      headers: req.headers,
      responseType: 'arraybuffer'
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf8');
      const rewritten = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(rewritten);
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }
  } catch (error) {
    console.error('❌ POST Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const targetUrl = decodeProxyUrl(req.params.encodedUrl + (req.params[0] || ''));
    console.log('📡 PUT Proxying:', targetUrl);

    const response = await axios.put(targetUrl, req.body, {
      headers: req.headers,
      responseType: 'arraybuffer'
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf8');
      const rewritten = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(rewritten);
    } else {
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    }
  } catch (error) {
    console.error('❌ PUT Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== 10. X COOKIE API =====
app.post('/api/x-inject-cookies', async (req, res) => {
  const { authToken, ct0Token } = req.body;

  if (!authToken || !ct0Token) {
    return res.status(400).json({ success: false, error: 'Missing tokens' });
  }

  const cookies = [
    { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', secure: true },
    { name: 'ct0', value: ct0Token, domain: '.x.com', path: '/', secure: true }
  ];

  cachedXCookies = cookies;
  saveCookiesToFile(cookies);

  console.log('🍪 Injected new cookies into cache');
  res.json({ success: true, cookies });
});

app.get('/api/x-cookies', (req, res) => {
  res.json({
    cached: !!cachedXCookies,
    cookies: cachedXCookies || []
  });
});

app.delete('/api/x-cookies', (req, res) => {
  cachedXCookies = null;
  if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
  console.log('🧹 Cleared X cookies');
  res.json({ success: true });
});
// ===== 11. 共有 xLoginPage 初期化ブロック（起動時にキャッシュCookieがあれば投入） =====
(async () => {
  if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0) {
    try {
      console.log('🔄 Initializing xLoginPage with cached cookies...');
      xLoginPage = await initXLoginPage();
      // setCookie expects cookie objects with url or domain/path; make best-effort
      try {
        await xLoginPage.setCookie(...cachedXCookies);
        console.log('✅ xLoginPage initialized with cached cookies');
      } catch (e) {
        console.log('⚠️ Could not set cookies on xLoginPage directly:', e.message);
      }

      try {
        const currentCookies = await xLoginPage.cookies();
        console.log('📋 Current cookies in xLoginPage:');
        currentCookies.forEach(c => {
          console.log(`   - ${c.name}: ${c.value ? c.value.substring(0, 20) + '...' : '<no-value>'}`);
        });
      } catch (e) {
        console.log('⚠️ Could not list cookies from xLoginPage:', e.message);
      }
    } catch (e) {
      console.log('⚠️ Could not initialize xLoginPage:', e.message);
    }
  }
})();

// ===== 12. TEST / DEBUG ENDPOINTS（詳細） =====
app.get('/test-decode/:encoded', (req, res) => {
  try {
    const decoded = decodeProxyUrl(req.params.encoded);
    res.json({
      encoded: req.params.encoded,
      decoded,
      success: true
    });
  } catch (e) {
    res.status(400).json({ error: e.message, encoded: req.params.encoded });
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
        valuePreview: c.value ? (c.value.substring(0, 20) + '...') : 'no-value',
        hasValue: !!c.value,
        expires: c.expires ? new Date(c.expires * 1000).toISOString() : 'session'
      };
    }) : [],
    hasAuthToken: hasCookies ? !!cachedXCookies.find(c => c && c.name === 'auth_token') : false,
    hasCt0: hasCookies ? !!cachedXCookies.find(c => c && c.name === 'ct0') : false
  });
});

// ===== 13. 詳細プロキシ処理（Puppeteer 経由の HTML ハンドリング含む） =====
/**
 * 補助: どのホストが x（旧twitter） かを判定
 */
function isXHostname(hostname) {
  if (!hostname) return false;
  return hostname.includes('x.com') || hostname.includes('twitter.com');
}

app.get(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);
    console.log('📡 GET Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = isXHostname(parsedUrl.hostname);
    const isApiEndpoint = parsedUrl.hostname.includes('api.x.com') || parsedUrl.pathname.includes('.json') || parsedUrl.pathname.includes('graphql');
    const isMediaFile = parsedUrl.pathname.match(/\.(js|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|mp4|webm|m3u8|ts|m4s|mpd)$/i) ||
                        parsedUrl.hostname.includes('video.twimg.com') ||
                        parsedUrl.hostname.includes('video-s.twimg.com') ||
                        parsedUrl.hostname.includes('pbs.twimg.com') ||
                        parsedUrl.hostname.includes('abs.twimg.com');

    const isHTML = !isApiEndpoint && !isMediaFile;

    const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;

    if (isHTML) {
      console.log('🌐 Handling HTML via Puppeteer');

      let page;
      let useSharedXPage = isXDomain && xLoginPage && hasCookies;

      try {
        if (useSharedXPage) {
          // use shared logged-in page
          const htmlContent = await useXLoginPage(async () => {
            await xLoginPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            // wait a bit for dynamic content
            await new Promise(r => setTimeout(r, 2500));
            return await xLoginPage.content();
          });

          const rewrittenHTML = rewriteHTML(htmlContent, targetUrl);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.send(rewrittenHTML);
        } else {
          // create ephemeral browser page
          const browserInstance = await initBrowser();
          page = await browserInstance.newPage();
          page.setDefaultNavigationTimeout(60000);
          page.setDefaultTimeout(60000);
          await page.setViewport({ width: 1920, height: 1080 });

          await page.setUserAgent(req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

          if (isXDomain && hasCookies) {
            try {
              const validCookies = cachedXCookies.filter(c => c && c.name && c.value);
              if (validCookies.length > 0) {
                await page.setCookie(...validCookies);
                console.log('🍪 Cookies set for new page:', validCookies.length);
              }
            } catch (e) {
              console.log('⚠️ Could not set cookies on new page:', e.message);
            }
          }

          try {
            await page.goto(targetUrl, { waitUntil: isXDomain ? 'domcontentloaded' : 'networkidle2', timeout: 60000 });
          } catch (navErr) {
            console.log('⚠️ Navigation warning:', navErr.message);
          }

          // small wait for client-side render
          await new Promise(r => setTimeout(r, isXDomain ? 3000 : 1500));

          const htmlContent = await page.content();

          if (page && page !== xLoginPage) {
            await page.close().catch(() => {});
          }

          const rewrittenHTML = rewriteHTML(htmlContent, targetUrl);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.send(rewrittenHTML);
        }
      } catch (err) {
        console.error('❌ HTML handling error:', err.message);
        if (err.message && (err.message.includes('aborted') || err.message.includes('ERR_ABORTED'))) {
          res.status(204).send();
          return;
        }

        // Return friendly error page
        res.status(500).send(`
          <!doctype html>
          <html>
            <head><meta charset="utf-8"><title>Proxy Error</title></head>
            <body style="font-family:Arial,Helvetica,sans-serif;background:#111;color:#eee;padding:40px;">
              <h1>読み込みに失敗しました</h1>
              <p>対象: <code>${targetUrl}</code></p>
              <pre style="color:#f88;">${String(err.message).slice(0, 400)}</pre>
            </body>
          </html>
        `);
        return;
      }
    } else {
      // non-HTML (media or API) -> use axios
      console.log('📦 Fetching resource via axios:', targetUrl);

      const headers = {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': req.headers['accept'] || '*/*',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.host}/`
      };

      if (isXDomain && hasCookies) {
        try {
          const cookieString = cachedXCookies
            .filter(c => c && c.name && c.value)
            .map(c => `${c.name}=${c.value}`)
            .join('; ');
          if (cookieString) headers['Cookie'] = cookieString;
        } catch (e) { /* ignore */ }
      } else if (req.headers.cookie) {
        headers['Cookie'] = req.headers.cookie;
      }

      try {
        const response = await axios.get(targetUrl, {
          headers,
          responseType: 'arraybuffer',
          maxRedirects: 5,
          validateStatus: () => true,
          timeout: 20000
        });

        if (response.status === 404) {
          res.status(404).send('');
          return;
        }

        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(response.data);
      } catch (e) {
        console.error('❌ Resource fetch error:', e.message);
        res.status(500).json({ error: e.message });
        return;
      }
    }
  } catch (error) {
    console.error('❌ GET Proxy error (outer):', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /proxy/... (axios-backed, but keep HTML rewrite behavior)
app.post(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);
    console.log('📡 POST Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = isXHostname(parsedUrl.hostname);
    const headers = Object.assign({}, req.headers);
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    if (isXDomain && cachedXCookies && cachedXCookies.length > 0) {
      try {
        const cookieString = cachedXCookies.map(c => `${c.name}=${c.value}`).join('; ');
        headers['Cookie'] = cookieString;
      } catch (e) {}
    }

    const response = await axios.post(targetUrl, req.body, {
      headers,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf8');
      html = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } else {
      res.setHeader('Content-Type', contentType);
      return res.send(response.data);
    }
  } catch (error) {
    console.error('❌ POST Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.put(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);
    console.log('📡 PUT Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = isXHostname(parsedUrl.hostname);
    const headers = Object.assign({}, req.headers);
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    if (isXDomain && cachedXCookies && cachedXCookies.length > 0) {
      try {
        const cookieString = cachedXCookies.map(c => `${c.name}=${c.value}`).join('; ');
        headers['Cookie'] = cookieString;
      } catch (e) {}
    }

    const response = await axios.put(targetUrl, req.body, {
      headers,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf8');
      html = rewriteHTML(html, targetUrl);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    } else {
      res.setHeader('Content-Type', contentType);
      return res.send(response.data);
    }
  } catch (error) {
    console.error('❌ PUT Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== 14. 追加 API：詳細な x-cookie 注入（元の挙動を保持） =====
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
    console.log('[API] ✅ Cookies cached globally and saved to file');

    // Try to create xLoginPage if not exists and set cookies there
    if (!xLoginPage) {
      try {
        console.log('[API] Creating xLoginPage...');
        xLoginPage = await initXLoginPage();
        console.log('[API] ✅ xLoginPage created');
      } catch (initError) {
        console.error('[API] ❌ Failed to create xLoginPage:', initError.message);
      }
    }

    if (xLoginPage) {
      try {
        await xLoginPage.setCookie(...cookies);
        console.log('[API] ✅ Cookies set in xLoginPage');
      } catch (e) {
        console.log('[API] ⚠️ Could not set cookies in page:', e.message);
      }
    }

    // Attempt to navigate to x.com to verify
    let currentUrl = 'N/A';
    let allCookies = [];
    let hasAuthToken = false;

    try {
      if (xLoginPage) {
        console.log('[API] Navigating to X.com to activate cookies...');
        await xLoginPage.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        currentUrl = xLoginPage.url();
        allCookies = await xLoginPage.cookies();
        hasAuthToken = allCookies.some(c => c && c.name === 'auth_token');
      }

      return res.json({
        success: true,
        message: 'Cookies injected, cached, and persisted successfully',
        isLoggedIn: hasAuthToken,
        currentUrl,
        cached: true,
        persisted: true,
        hasXLoginPage: !!xLoginPage,
        cookieCount: allCookies.length,
        cookies: allCookies.map(c => ({ name: c.name, domain: c.domain })),
        injectedCookies: {
          authToken: authToken.substring(0, 10) + '...',
          ct0Token: ct0Token.substring(0, 10) + '...'
        }
      });
    } catch (navError) {
      console.error('[API] Navigation failed (cookies still cached):', navError.message);
      return res.json({
        success: true,
        message: 'Cookies cached and persisted (navigation skipped)',
        warning: navError.message,
        cached: true,
        persisted: true,
        hasXLoginPage: !!xLoginPage,
        cookieCount: cookies.length,
        injectedCookies: {
          authToken: authToken.substring(0, 10) + '...',
          ct0Token: ct0Token.substring(0, 10) + '...'
        }
      });
    }
  } catch (error) {
    console.error('[API] Cookie injection error:', error.message);
    if (cachedXCookies && cachedXCookies.length > 0) {
      return res.json({
        success: true,
        message: 'Cookies cached (verification skipped)',
        cached: true,
        persisted: true,
        hasXLoginPage: !!xLoginPage
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Cookie injection failed',
      message: error.message
    });
  }
});

// ===== 15. 追加 API: x-cookies (詳細版) =====
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
    if (hasCachedCookies) {
      cookies = cachedXCookies.filter(c => c && c.name);
    } else if (xLoginPage) {
      try {
        cookies = await xLoginPage.cookies();
      } catch (e) {
        console.log('⚠️ Could not get cookies from xLoginPage:', e.message);
        cookies = [];
      }
    }

    const authToken = cookies.find(c => c.name === 'auth_token');

    return res.json({
      success: true,
      isLoggedIn: !!(authToken && authToken.value),
      cached: hasCachedCookies,
      hasCachedCookies,
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
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ===== 16. DELETE x-cookies (詳細版) =====
app.delete('/api/x-cookies', async (req, res) => {
  try {
    cachedXCookies = null;
    console.log('[API] Cookie cache cleared');

    if (fs.existsSync(COOKIE_FILE)) {
      fs.unlinkSync(COOKIE_FILE);
      console.log('[API] Cookie file deleted');
    }

    if (xLoginPage) {
      try {
        const cookies = await xLoginPage.cookies();
        for (const cookie of cookies) {
          try { await xLoginPage.deleteCookie(cookie); } catch (e) {}
        }
        console.log('[API] xLoginPage cookies cleared');
      } catch (e) {
        console.log('[API] Could not clear cookies from xLoginPage:', e.message);
      }
    }

    return res.json({ success: true, message: 'All X cookies cleared (memory and file)' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ===== 17. Xページ テストヘルパー =====
async function testXPageAccess(page) {
  console.log('[X-TEST] Testing X page access without login...');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = { tests: [] };

  try {
    await page.goto('https://x.com/', { waitUntil: ['load', 'domcontentloaded'], timeout: 30000 }).catch(() => {});
    await sleep(3000);
    const pageInfo1 = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.substring(0, 500),
    }));
    results.tests.push({ page: 'top', ...pageInfo1 });
  } catch (e) {
    results.tests.push({ page: 'top', error: e.message });
  }

  try {
    await page.goto('https://x.com/elonmusk', { waitUntil: ['load', 'domcontentloaded'], timeout: 30000 }).catch(() => {});
    await sleep(3000);
    const pageInfo2 = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.substring(0, 500),
      hasContent: document.body.innerText.length > 1000
    }));
    results.tests.push({ page: 'profile', ...pageInfo2 });
  } catch (e) {
    results.tests.push({ page: 'profile', error: e.message });
  }

  const blockedCount = results.tests.filter(t => t.error || t.hasError).length;
  const successCount = results.tests.filter(t => !t.error && !t.hasError).length;

  results.summary = {
    total: results.tests.length,
    success: successCount,
    blocked: blockedCount,
    conclusion: blockedCount === results.tests.length ? 'All pages blocked' : 'Some pages accessible'
  };

  return results;
}

app.get('/api/x-test', async (req, res) => {
  try {
    if (!xLoginPage) xLoginPage = await initXLoginPage();
    const results = await testXPageAccess(xLoginPage);
    res.json({ success: true, results });
  } catch (error) {
    console.error('[API] Test error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== 18. 静的ファイル & 404 =====
app.use(express.static('public'));

app.get('/x-cookie-helper.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'x-cookie-helper.html'));
});

app.get('/x-login-test.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'x-login-test.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  console.log('❌ 404 - Route not found:', req.method, req.path);
  res.status(404).json({ error: 'Route not found', path: req.path, method: req.method });
});

// ===== 19. SERVER START =====
app.listen(PORT, () => {
  console.log(`🚀 Yubikiri Proxy Pro running on port ${PORT}`);
  console.log(`🔍 Environment: ${process.env.RENDER ? 'Render' : 'Local'}`);
  console.log(`🍪 Cached cookies: ${cachedXCookies ? cachedXCookies.length : 0}`);
});

process.on('SIGTERM', async () => {
  console.log('👋 Shutting down gracefully...');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
