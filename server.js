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

function rewriteHTML(html, baseUrl) {
  const urlObj = new url.URL(baseUrl);
  const origin = `${urlObj.protocol}//${urlObj.host}`;
  const proxyOrigin = process.env.RENDER
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : `http://localhost:${PORT}`;

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

  // video source タグの書き換え
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

  // インターセプトスクリプト（無限ループ防止）
  const interceptScript = `
    <script>
      (function() {
        const PROXY_ORIGIN = '${proxyOrigin}';
        const TARGET_ORIGIN = '${origin}';
        const PROXY_PATH = '${PROXY_PATH}';
        let redirectAttempts = 0;
        const MAX_REDIRECT_ATTEMPTS = 5;
        
        console.log('[Proxy] Initializing for', TARGET_ORIGIN);
        
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
          const base64 = btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
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
        
        // fetch インターセプト
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

        // XMLHttpRequest インターセプト
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
                  return originalOpen.call(this, method, proxiedUrl, ...rest);
                }
              }
            }
          }
          return originalOpen.call(this, method, url, ...rest);
        };

        // HTMLMediaElement (video/audio) の src インターセプト
        try {
          const mediaSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
          if (mediaSrcDescriptor && mediaSrcDescriptor.set) {
            Object.defineProperty(HTMLMediaElement.prototype, 'src', {
              set: function(value) {
                const proxiedValue = proxyUrl(value);
                return mediaSrcDescriptor.set.call(this, proxiedValue);
              },
              get: function() {
                return mediaSrcDescriptor.get.call(this);
              }
            });
          }
        } catch (e) {
          console.warn('[Proxy] Could not intercept HTMLMediaElement.src:', e.message);
        }

        // Image src のインターセプト
        try {
          const imageSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
          if (imageSrcDescriptor && imageSrcDescriptor.set) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
              set: function(value) {
                const proxiedValue = proxyUrl(value);
                return imageSrcDescriptor.set.call(this, proxiedValue);
              },
              get: function() {
                return imageSrcDescriptor.get.call(this);
              }
            });
          }
        } catch (e) {
          console.warn('[Proxy] Could not intercept HTMLImageElement.src:', e.message);
        }

        // location.href インターセプト（無限ループ防止）
        try {
          const locationDescriptor = Object.getOwnPropertyDescriptor(window.Location.prototype, 'href');
          if (locationDescriptor && locationDescriptor.set) {
            Object.defineProperty(window.Location.prototype, 'href', {
              set: function(value) {
                console.log('[Proxy] location.href set:', value);
                if (!value || typeof value !== 'string') return;
                if (redirectAttempts >= MAX_REDIRECT_ATTEMPTS) {
                  console.error('[Proxy] Too many redirects - BLOCKED');
                  return;
                }
                if (isAlreadyProxied(value)) {
                  redirectAttempts++;
                  return locationDescriptor.set.call(this, value);
                }
                if (value.startsWith('#') || value.startsWith('?')) {
                  return locationDescriptor.set.call(this, value);
                }
                if (value === window.location.href || value === window.location.pathname) {
                  console.warn('[Proxy] Same-page redirect blocked');
                  return;
                }
                const absoluteValue = toAbsoluteUrl(value);
                if (absoluteValue.includes('x.com') || absoluteValue.includes('twitter.com')) {
                  const proxiedValue = proxyUrl(absoluteValue);
                  redirectAttempts++;
                  return locationDescriptor.set.call(this, proxiedValue);
                } else {
                  console.warn('[Proxy] External redirect blocked');
                  return;
                }
              },
              get: function() { return window.location.href; }
            });
          }
        } catch (e) {
          console.warn('[Proxy] Could not intercept location.href:', e.message);
        }

        // History API の詳細な監視
        try {
          const originalPushState = window.history.pushState;
          window.history.pushState = function(state, title, url) {
            if (url) {
              console.log('[Proxy] pushState called:', url);
              if (typeof url === 'string' && (url.startsWith('/') || url.startsWith('#') || url.startsWith('?'))) {
                return originalPushState.call(this, state, title, url);
              }
              if (typeof url === 'string' && !isAlreadyProxied(url) && url.startsWith('http')) {
                const proxiedUrl = proxyUrl(url);
                return originalPushState.call(this, state, title, proxiedUrl);
              }
            }
            return originalPushState.call(this, state, title, url);
          };

          const originalReplaceState = window.history.replaceState;
          window.history.replaceState = function(state, title, url) {
            if (url) {
              console.log('[Proxy] replaceState called:', url);
              if (typeof url === 'string' && (url.startsWith('/') || url.startsWith('#') || url.startsWith('?'))) {
                return originalReplaceState.call(this, state, title, url);
              }
              if (typeof url === 'string' && !isAlreadyProxied(url) && url.startsWith('http')) {
                const proxiedUrl = proxyUrl(url);
                return originalReplaceState.call(this, state, title, proxiedUrl);
              }
            }
            return originalReplaceState.call(this, state, title, url);
          };
        } catch (e) {
          console.warn('[Proxy] Could not intercept History API:', e.message);
        }

        // MutationObserver で動的に追加される要素を監視
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === 1) {
                if (node.tagName === 'IMG' && node.src && !isAlreadyProxied(node.src)) {
                  const proxiedSrc = proxyUrl(node.src);
                  if (proxiedSrc !== node.src) {
                    node.src = proxiedSrc;
                  }
                }
                if ((node.tagName === 'VIDEO' || node.tagName === 'AUDIO') && node.src && !isAlreadyProxied(node.src)) {
                  const proxiedSrc = proxyUrl(node.src);
                  if (proxiedSrc !== node.src) {
                    node.src = proxiedSrc;
                  }
                }
                if (node.tagName === 'SOURCE' && node.src && !isAlreadyProxied(node.src)) {
                  const proxiedSrc = proxyUrl(node.src);
                  if (proxiedSrc !== node.src) {
                    node.src = proxiedSrc;
                  }
                }
                const imgs = node.querySelectorAll && node.querySelectorAll('img[src], video[src], audio[src], source[src]');
                if (imgs) {
                  imgs.forEach((el) => {
                    if (el.src && !isAlreadyProxied(el.src)) {
                      const proxiedSrc = proxyUrl(el.src);
                      if (proxiedSrc !== el.src) {
                        el.src = proxiedSrc;
                      }
                    }
                  });
                }
              }
            });
          });
        });

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });

        // 認証エラー検知と警告表示
        let authErrorCount = 0;
        const originalXHRSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(...args) {
          const xhr = this;
          const originalOnLoad = xhr.onload;
          
          xhr.onload = function() {
            try {
              if (xhr.status === 401 || xhr.status === 403) {
                authErrorCount++;
                console.error('[Proxy] Auth error detected:', xhr.status, xhr.responseURL);
                
                if (authErrorCount > 5) {
                  console.error('[Proxy] Too many auth errors, session may be expired');
                  
                  if (!document.getElementById('proxy-auth-warning')) {
                    const warning = document.createElement('div');
                    warning.id = 'proxy-auth-warning';
                    warning.style.cssText = 'position:fixed;top:20px;right:20px;background:rgba(255,87,87,0.95);color:white;padding:20px;border-radius:8px;z-index:99999;max-width:300px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
                    warning.innerHTML = '<strong>⚠️ セッション警告</strong><br><br>認証エラーが複数発生しています。<br>Cookieが期限切れの可能性があります。<br><br><a href="/x-cookie-helper.html" style="color:#fff;text-decoration:underline;">Cookieを再注入</a>';
                    document.body.appendChild(warning);
                    
                    setTimeout(() => warning.remove(), 10000);
                  }
                }
              }
            } catch (e) {}
            
            if (originalOnLoad) {
              return originalOnLoad.apply(this, arguments);
            }
          };
          
          return originalXHRSend.apply(this, args);
        };

        setTimeout(() => { redirectAttempts = 0; }, 10000);
        console.log('[Proxy] Initialization complete');
      })();
    </script>
  `;

  html = html.replace(/<head[^>]*>/i, (match) => match + interceptScript);
  html = html.replace(/<script[^>]*src=[^>]*google[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*src=[^>]*gstatic[^>]*>[\s\S]*?<\/script>/gi, '');

  if (!html.includes('charset')) {
    html = html.replace(/<head[^>]*>/i, '<head><meta charset="UTF-8">');
  }

  return html;
}

// ===== 6. PUPPETEER SETUP =====
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
    if (request.isInterceptResolutionHandled()) return;
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

// 起動時にxLoginPage初期化
(async () => {
  if (cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0) {
    try {
      console.log('🔄 Initializing xLoginPage with cached cookies...');
      xLoginPage = await initXLoginPage();
      await xLoginPage.setCookie(...cachedXCookies);
      console.log('✅ xLoginPage initialized with cached cookies');
      const currentCookies = await xLoginPage.cookies();
      console.log('📋 Current cookies in xLoginPage:');
      currentCookies.forEach(c => {
        console.log(`   - ${c.name}: ${c.value ? c.value.substring(0, 20) + '...' : '<no-value>'}`);
      });
    } catch (e) {
      console.log('⚠️ Could not initialize xLoginPage:', e.message);
    }
  }
})();

// ===== 7. TEST ROUTES =====
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
    res.json({ encoded: req.params.encoded, decoded, success: true });
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
        value: c.value ? (c.value.substring(0, 20) + '...') : 'no-value',
        hasValue: !!c.value,
        valueLength: c.value ? c.value.length : 0,
        expires: c.expires ? new Date(c.expires * 1000).toISOString() : 'session',
        isExpired: c.expires ? (c.expires * 1000 < Date.now()) : false
      };
    }) : [],
    hasAuthToken: hasCookies ? !!cachedXCookies.find(c => c && c.name === 'auth_token') : false,
    hasCt0: hasCookies ? !!cachedXCookies.find(c => c && c.name === 'ct0') : false
  });
});

// ===== 8. PROXY ROUTES =====
app.options(`${PROXY_PATH}:encodedUrl*`, (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-csrf-token, x-twitter-active-user, x-twitter-client-language');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).send();
});

app.get(`${PROXY_PATH}:encodedUrl*`, async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl + (req.params[0] || '');
    const targetUrl = decodeProxyUrl(encodedUrl);
    console.log('📡 GET Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    const isApiEndpoint = parsedUrl.hostname.includes('api.x.com') || 
                          parsedUrl.pathname.includes('.json') ||
                          parsedUrl.pathname.includes('graphql');
    const isMediaFile = parsedUrl.pathname.match(/\.(js|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|mp4|webm|m3u8|ts|m4s|mpd)$/i) ||
                        parsedUrl.hostname.includes('video.twimg.com') ||
                        parsedUrl.hostname.includes('pbs.twimg.com') ||
                        parsedUrl.hostname.includes('abs.twimg.com');
    
    const isHTML = !isApiEndpoint && !isMediaFile;
    const hasCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;

    if (isHTML) {
      console.log('🌐 Using Puppeteer for HTML page');
      let page;
      const useXLoginPageShared = isXDomain && xLoginPage && hasCookies;

      try {
        if (useXLoginPageShared) {
          console.log('♻️ Using shared xLoginPage');
          const htmlContent = await useXLoginPage(async () => {
            await xLoginPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
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
          page.setDefaultNavigationTimeout(60000);
          await page.setViewport({ width: 1920, height: 1080 });
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

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

          await page.goto(targetUrl, { waitUntil: isXDomain ? 'domcontentloaded' : 'networkidle2', timeout: 60000 }).catch(() => {});
          await new Promise(r => setTimeout(r, isXDomain ? 3000 : 2000));

          const htmlContent = await page.content();
          if (page && page !== xLoginPage) await page.close().catch(() => {});

          const rewrittenHTML = rewriteHTML(htmlContent, targetUrl);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.send(rewrittenHTML);
        }
      } catch (err) {
        console.error('❌ Navigation error:', err.message);
        if (err.message && (err.message.includes('aborted') || err.message.includes('ERR_ABORTED'))) {
          res.status(204).send();
          return;
        }
        res.status(500).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head><body><h1>ページ読み込みエラー</h1><p>${targetUrl}</p></body></html>`);
        return;
      }
    } else {
      console.log('📦 Fetching non-HTML resource');
      const headers = {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.host}/`
      };

      if (isXDomain && hasCookies) {
        const cookieString = cachedXCookies
          .filter(c => c && c.name && c.value)
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        if (cookieString) headers['Cookie'] = cookieString;
        
        if (isApiEndpoint) {
          const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
          if (ct0Cookie && ct0Cookie.value) {
            headers['x-csrf-token'] = ct0Cookie.value;
          }
          headers['x-twitter-active-user'] = 'yes';
          headers['x-twitter-client-language'] = 'en';
          if (targetUrl.includes('graphql')) {
            headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
          }
        }
      }

      const response = await axios.get(targetUrl, {
        headers,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: () => true,
        timeout: 15000
      });

      if (response.status === 404) {
        res.status(404).send('');
        return;
      }

      res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(response.data);
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

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    const headers = Object.assign({}, req.headers);
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    if (isXDomain && cachedXCookies && cachedXCookies.length > 0) {
      const cookieString = cachedXCookies.map(c => `${c.name}=${c.value}`).join('; ');
      headers['Cookie'] = cookieString;
      const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
      if (ct0Cookie) headers['x-csrf-token'] = ct0Cookie.value;
      headers['x-twitter-active-user'] = 'yes';
      headers['x-twitter-client-language'] = 'en';
      if (targetUrl.includes('graphql')) {
        headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
      }
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
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(html);
    } else {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(response.data);
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

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    const headers = Object.assign({}, req.headers);
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    if (isXDomain && cachedXCookies && cachedXCookies.length > 0) {
      const cookieString = cachedXCookies.map(c => `${c.name}=${c.value}`).join('; ');
      headers['Cookie'] = cookieString;
      const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
      if (ct0Cookie) headers['x-csrf-token'] = ct0Cookie.value;
    }

    const response = await axios.put(targetUrl, req.body, {
      headers,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(response.data);
  } catch (error) {
    console.error('❌ PUT Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});❌ PUT Proxy error:', error.message);
    res.status(500).json({ error: error.message });
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
          cached: true,
          persisted: true,
          hasXLoginPage: false
        });
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
        cached: true,
        persisted: true,
        hasXLoginPage: !!xLoginPage,
        cookieCount: cookies.length
      });
    }
  } catch (error) {
    console.error('[API] Cookie injection error:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Cookie injection failed',
      message: error.message
    });
  }
});

app.get('/api/x-cookies', async (req, res) => {
  try {
    const hasCachedCookies = cachedXCookies && Array.isArray(cachedXCookies) && cachedXCookies.length > 0;

    if (!hasCachedCookies && !xLoginPage) {
      return res.status(400).json({
        success: false,
        error: 'No cookies cached',
        cached: false
      });
    }

    let cookies = [];
    if (hasCachedCookies) {
      cookies = cachedXCookies.filter(c => c && c.name);
    } else if (xLoginPage) {
      try {
        cookies = await xLoginPage.cookies();
      } catch (e) {
        cookies = [];
      }
    }

    const authToken = cookies.find(c => c.name === 'auth_token');

    return res.json({
      success: true,
      isLoggedIn: !!(authToken && authToken.value),
      cached: hasCachedCookies,
      cookieCount: cookies.length,
      cookies: cookies.map(c => ({
        name: c.name || 'unknown',
        domain: c.domain || 'unknown',
        expires: c.expires ? new Date(c.expires * 1000).toISOString() : 'session'
      }))
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/x-cookies', async (req, res) => {
  try {
    cachedXCookies = null;
    if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
    if (xLoginPage) {
      try {
        const cookies = await xLoginPage.cookies();
        for (const cookie of cookies) {
          await xLoginPage.deleteCookie(cookie).catch(() => {});
        }
      } catch (e) {}
    }
    return res.json({ success: true, message: 'All X cookies cleared' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ===== 10. STATIC FILES & ROOT =====
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

// ===== 11. SERVER START =====
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

    if (isXDomain && cachedXCookies && cachedXCookies.length > 0) {
      const cookieString = cachedXCookies.map(c => `${c.name}=${c.value}`).join('; ');
      headers['Cookie'] = cookieString;
      const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
      if (ct0Cookie) headers['x-csrf-token'] = ct0Cookie.value;
      headers['x-twitter-active-user'] = 'yes';
      headers['x-twitter-client-language'] = 'en';
      if (targetUrl.includes('graphql')) {
        headers['authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
      }
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
    const targetUrl = decodeProxyUrl(req.params.encodedUrl + (req.params[0] || ''));
    console.log('📡 PUT Proxying:', targetUrl);

    const parsedUrl = new url.URL(targetUrl);
    const isXDomain = parsedUrl.hostname.includes('x.com') || parsedUrl.hostname.includes('twitter.com');
    const headers = Object.assign({}, req.headers);
    headers['Referer'] = `${parsedUrl.protocol}//${parsedUrl.host}/`;

    if (isXDomain && cachedXCookies && cachedXCookies.length > 0) {
      const cookieString = cachedXCookies.map(c => `${c.name}=${c.value}`).join('; ');
      headers['Cookie'] = cookieString;
      const ct0Cookie = cachedXCookies.find(c => c && c.name === 'ct0');
      if (ct0Cookie) headers['x-csrf-token'] = ct0Cookie.value;
    }

    const response = await axios.put(targetUrl, req.body, {
      headers,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 30000
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    return res.send(response.data);
  } catch (error) {
    console.error('