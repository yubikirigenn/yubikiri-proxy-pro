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

  // インターセプトスクリプト + Google One Tap無効化
  const interceptScript = `
    <script>
      (function() {
        const proxyBase = '${origin}';
        
        // Google完全無効化
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
        
        // script要素作成監視
        const originalCreateElement = document.createElement;
        document.createElement = function(tagName) {
          const element = originalCreateElement.call(document, tagName);
          if (tagName.toLowerCase() === 'script') {
            const originalSetAttribute = element.setAttribute.bind(element);
            element.setAttribute = function(name, value) {
              if (name === 'src' && (value.includes('google') || value.includes('gstatic'))) {
                console.log('[Proxy] Blocked Google script:', value);
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
          if (typeof resource === 'string') {
            if (resource.includes('google') || resource.includes('gstatic')) {
              console.log('[Proxy] Blocked Google fetch:', resource);
              return Promise.reject(new Error('Blocked'));
            }
            if (!resource.startsWith('blob:') && !resource.startsWith('data:')) {
              const absoluteUrl = toAbsoluteUrl(resource);
              if (absoluteUrl.startsWith('http')) {
                resource = encodeProxyUrl(absoluteUrl);
              }
            }
          }
          return originalFetch.call(this, resource, options);
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          if (typeof url === 'string') {
            if (url.includes('google') || url.includes('gstatic')) {
              console.log('[Proxy] Blocked Google XHR:', url);
              throw new Error('Blocked');
            }
            if (!url.startsWith('blob:') && !url.startsWith('data:')) {
              const absoluteUrl = toAbsoluteUrl(url);
              if (absoluteUrl.startsWith('http')) {
                url = encodeProxyUrl(absoluteUrl);
              }
            }
          }
          return originalOpen.call(this, method, url, ...rest);
        };

        // エラー抑制
        const originalError = console.error;
        console.error = function(...args) {
          const msg = args.join(' ');
          if (msg.includes('GSI') || msg.includes('google')) {
            return;
          }
          return originalError.apply(console, args);
        };

        console.warn = () => {};
      })();
    </script>
  `;

  html = html.replace(/<head[^>]*>/i, (match) => match + interceptScript);
  
  // Google関連スクリプト削除
  html = html.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '<!-- Removed -->');
  html = html.replace(/<script[^>]*src=[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '<!-- Removed -->');
  html = html.replace(/<iframe[^>]*google[^>]*>[\s\S]*?<\/iframe>/gi, '<!-- Removed -->');
  html = html.replace(/<div[^>]*id=["']g_id[^>]*>[\s\S]*?<\/div>/gi, '<!-- Removed -->');
  html = html.replace(/google\.accounts\.id\.[^;]+;?/gi, '/* Removed */');

  if (!html.includes('<base')) {
    html = html.replace(/<head[^>]*>/i, `<head><base href="/proxy/${encodeProxyUrl(baseUrl)}">`);
  }

  if (!html.includes('charset')) {
    html = html.replace(/<head[^>]*>/i, '<head><meta charset="UTF-8">');
  }

  return html;
}

// プロキシエンドポイント
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
                             parsedUrl.hostname.includes('google') ||
                             (parsedUrl.hostname.includes('x.com') && parsedUrl.pathname.startsWith('/i/'));
    
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
      
      return res.send(response.data);
    }

    // HTMLページはPuppeteerで取得
    const browserInstance = await initBrowser();
    page = await browserInstance.newPage();

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 【最強版】すべてのGoogleリソースをブロック
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const requestUrl = request.url();
      
      const isGoogleResource = (
        requestUrl.includes('google.com') ||
        requestUrl.includes('gstatic.com') ||
        requestUrl.includes('googleapis.com') ||
        requestUrl.includes('doubleclick.net')
      );
      
      if (isGoogleResource) {
        console.log('🚫 Blocked Google:', requestUrl);
        request.abort();
        return;
      }
      
      request.continue();
    });

    // Cookieを設定
    if (req.headers.cookie) {
      const cookies = req.headers.cookie.split(';').map(c => {
        const [name, ...valueParts] = c.trim().split('=');
        return { name, value: valueParts.join('='), domain: new url.URL(targetUrl).hostname };
      });
      await page.setCookie(...cookies).catch(() => {});
    }

    // 【最強版】Google API完全無効化
    await page.evaluateOnNewDocument(() => {
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

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
              if (node.tagName === 'IFRAME' && node.src) {
                if (node.src.includes('google') || node.src.includes('gstatic')) {
                  node.remove();
                }
              }
              if (node.tagName === 'SCRIPT' && node.src) {
                if (node.src.includes('google') || node.src.includes('gstatic')) {
                  node.remove();
                }
              }
              if (node.id && node.id.includes('g_id')) {
                node.remove();
              }
            }
          }
        }
      });

      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });
      }

      console.log('[Proxy] Google blocking initialized');
    });

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 20000
    }).catch(() => {});

    await new Promise(resolve => setTimeout(resolve, 1500));

    let htmlContent = await page.content();
    
    // Google関連削除
    htmlContent = htmlContent.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
    htmlContent = htmlContent.replace(/<script[^>]*src=[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '');
    htmlContent = htmlContent.replace(/<iframe[^>]*google[^>]*>[\s\S]*?<\/iframe>/gi, '');
    htmlContent = htmlContent.replace(/<div[^>]*id=["']g_id[^>]*>[\s\S]*?<\/div>/gi, '');
    htmlContent = htmlContent.replace(/google\.accounts\.id\.[^;]+;?/gi, '');
    htmlContent = htmlContent.replace(/google\.accounts\.id\.prompt\([^)]*\);?/gi, '');
    
    console.log('✅ Google resources removed');
    
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

// POSTリクエスト
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
  console.log(`🚀 Yubikiri Proxy Pro running on port ${PORT}`);
});

const { loginToX } = require('./x-login');

// Xログイン用のページキャッシュ
let xLoginPage = null;

/**
 * Xログイン用ページ初期化
 */
async function initXLoginPage() {
  const browserInstance = await initBrowser();
  const page = await browserInstance.newPage();

  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Google完全ブロック
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const requestUrl = request.url();
    
    if (requestUrl.includes('google.com') || 
        requestUrl.includes('gstatic.com') ||
        requestUrl.includes('googleapis.com')) {
      console.log('🚫 [X-LOGIN] Blocked:', requestUrl.substring(0, 80));
      request.abort();
      return;
    }
    
    request.continue();
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'google', {
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
  });

  console.log('✅ X login page initialized');
  return page;
}

/**
 * POST /api/x-login - Xログインエンドポイント
 */
app.post('/api/x-login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      success: false,
      error: 'Username and password required' 
    });
  }

  try {
    console.log(`[API] Login request for: ${username}`);

    // ページ初期化
    if (!xLoginPage) {
      xLoginPage = await initXLoginPage();
    }

    // ログイン実行
    const result = await loginToX(xLoginPage, username, password);

    if (result.success) {
      return res.json({
        success: true,
        message: 'Login successful',
        authToken: result.authToken,
        ct0Token: result.ct0Token,
        currentUrl: result.currentUrl,
        cookies: result.cookies.map(c => ({
          name: c.name,
          domain: c.domain
        })),
        logs: result.logs
      });
    } else {
      return res.status(401).json({
        success: false,
        message: result.message || 'Login failed',
        error: result.error,
        currentUrl: result.currentUrl,
        needsVerification: result.needsVerification,
        logs: result.logs
      });
    }

  } catch (error) {
    console.error('[API] Login error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Login request failed',
      message: error.message
    });
  }
});

/**
 * GET /api/x-cookies - Cookie確認
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

process.on('SIGTERM', async () => {
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});