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

// Puppeteer初期化
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
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        };
      } else {
        launchConfig = {
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
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
app.use('/static', express.static('public'));

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

  // href属性をリライト
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

  // src属性をリライト
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

  // action属性をリライト
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

  // XMLHttpRequest/fetchのインターセプトスクリプト + Google One Tap無効化
  const interceptScript = `
    <script>
      (function() {
        const proxyBase = '${origin}';
        
        // Google One Tap / GSI を完全に無効化
        window.google = window.google || {};
        window.google.accounts = {
          id: {
            initialize: function() { console.log('[Proxy] Google One Tap disabled'); },
            prompt: function() { console.log('[Proxy] Google One Tap prompt disabled'); },
            renderButton: function() { console.log('[Proxy] Google button disabled'); },
            disableAutoSelect: function() {},
            storeCredential: function() {},
            cancel: function() {},
            onGoogleLibraryLoad: function() {},
            revoke: function() {}
          }
        };
        
        // gsi/client スクリプトを無効化
        const originalCreateElement = document.createElement;
        document.createElement = function(tagName) {
          const element = originalCreateElement.call(document, tagName);
          if (tagName.toLowerCase() === 'script') {
            const originalSetAttribute = element.setAttribute.bind(element);
            element.setAttribute = function(name, value) {
              if (name === 'src' && (value.includes('accounts.google.com/gsi') || value.includes('gsi/client'))) {
                console.log('[Proxy] Blocked Google GSI script:', value);
                return;
              }
              return originalSetAttribute(name, value);
            };
          }
          return element;
        };
        
        function toAbsoluteUrl(relativeUrl) {
          if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
            return relativeUrl;
          }
          if (relativeUrl.startsWith('//')) {
            return '${urlObj.protocol}' + relativeUrl;
          }
          if (relativeUrl.startsWith('/')) {
            return proxyBase + relativeUrl;
          }
          return '${baseUrl}/' + relativeUrl;
        }
        
        function encodeProxyUrl(url) {
          return '/proxy/' + btoa(url).replace(/\\+/g, '-').replace(/\\\//g, '_').replace(/=/g, '');
        }
        
        const originalFetch = window.fetch;
        window.fetch = function(resource, options) {
          if (typeof resource === 'string' && !resource.startsWith('blob:') && !resource.startsWith('data:')) {
            const absoluteUrl = toAbsoluteUrl(resource);
            if (absoluteUrl.startsWith('http')) {
              resource = encodeProxyUrl(absoluteUrl);
            }
          }
          return originalFetch.call(this, resource, options);
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (typeof url === 'string' && !url.startsWith('blob:') && !url.startsWith('data:')) {
            const absoluteUrl = toAbsoluteUrl(url);
            if (absoluteUrl.startsWith('http')) {
              url = encodeProxyUrl(absoluteUrl);
            }
          }
          return originalOpen.call(this, method, url, ...rest);
        };
      })();
    </script>
  `;

  // インターセプトスクリプトを<head>の最初に挿入（早期実行のため）
  html = html.replace(/<head[^>]*>/i, (match) => match + interceptScript);
  
  // Google GSI スクリプトタグを削除
  html = html.replace(/<script[^>]*src=[^>]*accounts\.google\.com\/gsi[^>]*>[\s\S]*?<\/script>/gi, '<!-- Google GSI script removed by proxy -->');
  html = html.replace(/<script[^>]*src=[^>]*gsi\/client[^>]*>[\s\S]*?<\/script>/gi, '<!-- Google GSI script removed by proxy -->');

  // Base タグを追加
  if (!html.includes('<base')) {
    html = html.replace(/<head[^>]*>/i, `<head><base href="/proxy/${encodeProxyUrl(baseUrl)}">`);
  }

  if (!html.includes('charset')) {
    html = html.replace(/<head[^>]*>/i, '<head><meta charset="UTF-8">');
  }

  return html;
}

// HTML用プロキシ(Puppeteer使用)
app.get('/proxy/:encodedUrl*', async (req, res) => {
  let page;
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 Proxying:', targetUrl);

    // 静的リソース(画像、CSS、JS等)は直接取得
    const parsedUrl = new url.URL(targetUrl);
    const ext = path.extname(parsedUrl.pathname).toLowerCase();
    const staticExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.css', '.js', '.woff', '.woff2', '.ttf', '.svg', '.ico', '.mp4', '.webm', '.json'];
    
    // 明らかにHTMLページではないものは直接取得
    const shouldDirectFetch = staticExtensions.includes(ext) ||
                             parsedUrl.pathname.includes('/api/') ||
                             parsedUrl.pathname.includes('/graphql/') ||
                             parsedUrl.pathname.includes('/gsi/') ||
                             parsedUrl.pathname.includes('/1.1/') ||
                             parsedUrl.pathname.includes('/i/js_inst') ||
                             parsedUrl.pathname.includes('/i/api/') ||
                             parsedUrl.pathname.includes('/jot/') ||
                             parsedUrl.pathname.includes('/onboarding/') ||
                             parsedUrl.pathname.includes('/guest/') ||
                             parsedUrl.pathname.includes('/2/') ||
                             parsedUrl.pathname.startsWith('/i/api/') ||
                             parsedUrl.hostname.startsWith('api.') ||
                             // Google認証関連を追加
                             parsedUrl.hostname.includes('accounts.google.com') ||
                             parsedUrl.hostname.includes('googleapis.com') ||
                             parsedUrl.hostname.includes('gstatic.com') ||
                             parsedUrl.hostname.includes('google.com') && parsedUrl.pathname.includes('/o/oauth2/') ||
                             (parsedUrl.hostname.includes('twitter.com') && parsedUrl.pathname.startsWith('/i/')) ||
                             (parsedUrl.hostname.includes('x.com') && parsedUrl.pathname.startsWith('/i/'));
    
    if (shouldDirectFetch) {
      // オリジナルのリクエストヘッダーを可能な限り保持
      const headers = {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
        'Accept-Encoding': req.headers['accept-encoding'] || 'gzip, deflate, br',
      };

      // Refererを元のドメインに設定
      const refererUrl = new url.URL(targetUrl);
      headers['Referer'] = `${refererUrl.protocol}//${refererUrl.host}/`;
      
      // Originを元のドメインに設定
      headers['Origin'] = `${refererUrl.protocol}//${refererUrl.host}`;

      if (req.headers.cookie) {
        headers['Cookie'] = req.headers.cookie;
      }

      // Authorization headerがあれば転送
      if (req.headers.authorization) {
        headers['Authorization'] = req.headers.authorization;
      }

      const response = await axios({
        method: 'GET',
        url: targetUrl,
        headers: headers,
        responseType: 'arraybuffer',
        timeout: 15000,
        validateStatus: () => true,
        maxRedirects: 5
      });

      const contentType = response.headers['content-type'] || '';
      
      // Content-Typeをそのまま返す
      res.setHeader('Content-Type', contentType);
      
      // Set-Cookieがあれば転送
      if (response.headers['set-cookie']) {
        res.setHeader('Set-Cookie', response.headers['set-cookie']);
      }
      
      // Cache-Controlも転送
      if (response.headers['cache-control']) {
        res.setHeader('Cache-Control', response.headers['cache-control']);
      }

      // Access-Control-Allow-Originを設定
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      return res.send(response.data);
    }

    // HTMLページはPuppeteerで取得
    const browserInstance = await initBrowser();
    page = await browserInstance.newPage();

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Google認証関連のリクエストのみをブロック
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();
      
      // Google認証関連のみブロック（より厳密な条件）
      const shouldBlock = (
        (requestUrl.includes('accounts.google.com') && requestUrl.includes('/gsi/')) ||
        (requestUrl.includes('google.com') && requestUrl.includes('/gsi/client')) ||
        (requestUrl.includes('accounts.google.com') && requestUrl.includes('/o/oauth2/')) ||
        (requestUrl.includes('google.com') && requestUrl.includes('iframeresize'))
      );
      
      if (shouldBlock) {
        console.log('🚫 Blocked Google GSI:', requestUrl);
        request.abort();
      } else {
        request.continue();
      }
    });

    // Cookieを設定
    if (req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').map(c => {
        const [name, ...valueParts] = c.trim().split('=');
        return { name, value: valueParts.join('='), domain: new url.URL(targetUrl).hostname };
      });
      await page.setCookie(...cookies).catch(() => {});
    }

    // ページロード前にGoogle APIを無効化（重要：gotoの前に実行）
    await page.evaluateOnNewDocument(() => {
      // Google One Tap完全無効化
      Object.defineProperty(window, 'google', {
        value: {
          accounts: {
            id: {
              initialize: function() { console.log('[Proxy] Google One Tap blocked'); },
              prompt: function() { console.log('[Proxy] prompt blocked'); },
              renderButton: function() {},
              disableAutoSelect: function() {},
              storeCredential: function() {},
              cancel: function() {},
              onGoogleLibraryLoad: function() {},
              revoke: function() {}
            }
          }
        },
        writable: false,
        configurable: false
      });
    });

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 20000
    }).catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 1500));

    let html = await page.content();
    
    // Google GSI関連のスクリプトとiframeを完全削除
    html = html.replace(/<script[^>]*src=[^>]*accounts\.google\.com[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*src=[^>]*gsi\/client[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*src=[^>]*gstatic\.com\/gsi[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<iframe[^>]*accounts\.google\.com[^>]*>[\s\S]*?<\/iframe>/gi, '');
    html = html.replace(/<div[^>]*id=["']g_id_onload[^>]*>[\s\S]*?<\/div>/gi, '');
    
    // インラインスクリプト内のGoogle One Tap初期化コードも削除
    html = html.replace(/google\.accounts\.id\.initialize\([^)]*\);?/gi, '');
    html = html.replace(/google\.accounts\.id\.prompt\([^)]*\);?/gi, '');
    
    console.log('✅ Google GSI scripts removed from HTML');
    
    // Cookieを取得
    const pageCookies = await page.cookies();
    if (pageCookies.length > 0) {
      const setCookieHeaders = pageCookies.map(cookie => {
        return `${cookie.name}=${cookie.value}; Path=${cookie.path || '/'}; ${cookie.httpOnly ? 'HttpOnly;' : ''} ${cookie.secure ? 'Secure;' : ''}`;
      });
      res.setHeader('Set-Cookie', setCookieHeaders);
    }

    html = rewriteHTML(html, targetUrl);
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

    await page.close().catch(() => {});

  } catch (error) {
    if (page) {
      try {
        await page.close().catch(() => {});
      } catch (e) {}
    }

    console.error('❌ Proxy error:', error.message);
    res.status(500).send(`<html><body><h1>Error</h1><p>${error.message}</p></body></html>`);
  }
});

// POSTリクエスト処理
app.post('/proxy/:encodedUrl*', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);

    console.log('📡 POST Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const headers = {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    };

    // OriginとRefererを元のドメインに設定
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

    // CORS対応
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf-8');
      html = rewriteHTML(html, targetUrl);
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
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

// OPTIONSリクエスト対応（CORS Preflight）
app.options('/proxy/:encodedUrl*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Yubikiri Proxy Pro (Forward Proxy + Puppeteer) running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});