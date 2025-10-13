const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

let browser;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Puppeteerブラウザの初期化
async function initBrowser() {
  if (!browser) {
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--enable-automation',
        '--metrics-recording-only'
      ]
    };

    browser = await puppeteer.launch(launchOptions);
  }
  return browser;
}

// Proxy endpoint - HTMLをレンダリング
app.post('/api/proxy', async (req, res) => {
  let page;
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URLが必要です' });
    }

    // URL検証
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: '無効なURL形式です' });
    }

    const browserInstance = await initBrowser();
    page = await browserInstance.newPage();

    // ビューポート設定
    await page.setViewport({
      width: 1920,
      height: 1080
    });

    // User-Agentを設定
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // タイムアウト設定
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    // ページにアクセス
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // JavaScriptを実行してDOMの準備を待つ
    await page.evaluate(() => {
      return new Promise((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', resolve);
          setTimeout(resolve, 5000);
        }
      });
    });

    // ページの完全なHTMLを取得
    const content = await page.content();

    // すべてのスクリプトを削除（セキュリティ対策）
    const modifiedContent = content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');

    res.json({
      success: true,
      content: modifiedContent,
      url: page.url(),
      status: 200
    });

    await page.close();

  } catch (error) {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // 無視
      }
    }

    console.error('Proxy error:', error.message);

    let errorMessage = 'ページの読み込みに失敗しました';

    if (error.message.includes('net::ERR_NAME_NOT_RESOLVED')) {
      errorMessage = 'ドメインが見つかりません';
    } else if (error.message.includes('net::ERR_CONNECTION_REFUSED')) {
      errorMessage = 'サーバーが応答しません';
    } else if (error.message.includes('Timeout')) {
      errorMessage = 'リクエストがタイムアウトしました';
    } else if (error.message.includes('ERR_BLOCKED_BY_CLIENT')) {
      errorMessage = 'アクセスがブロックされています';
    }

    res.status(500).json({
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Proxy endpoint - スクリーンショットを取得
app.post('/api/screenshot', async (req, res) => {
  let page;
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URLが必要です' });
    }

    const browserInstance = await initBrowser();
    page = await browserInstance.newPage();

    await page.setViewport({
      width: 1920,
      height: 1080
    });

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    const screenshot = await page.screenshot({ type: 'png' });

    res.set('Content-Type', 'image/png');
    res.send(screenshot);

    await page.close();

  } catch (error) {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // 無視
      }
    }

    res.status(500).json({ error: 'スクリーンショット取得に失敗しました' });
  }
});

// Serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Yubikiri Proxy Pro running on port ${PORT}`);
});

// グレースフルシャットダウン
process.on('SIGTERM', async () => {
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});