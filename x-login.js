// x-login.js - Xログイン専用モジュール（既存コードに影響なし）

/**
 * Xログイン処理（改善版）
 * @param {Page} page - Puppeteerページオブジェクト
 * @param {string} username - Xのユーザー名
 * @param {string} password - パスワード
 * @returns {Promise<Object>} ログイン結果
 */
async function loginToX(page, username, password) {
  const logs = {
    steps: [],
    requests: [],
    responses: [],
    errors: []
  };

  try {
    // Step 1: ログインページへ移動
    logs.steps.push({ step: 1, action: 'Navigate to login page', time: Date.now() });
    console.log('[X-LOGIN] Step 1: Navigating to login page...');
    
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await page.waitForTimeout(2000);
    logs.steps.push({ step: 1, status: 'success', time: Date.now() });

    // Step 2: ユーザー名入力
    logs.steps.push({ step: 2, action: 'Enter username', time: Date.now() });
    console.log('[X-LOGIN] Step 2: Entering username...');
    
    const usernameSelector = 'input[autocomplete="username"]';
    await page.waitForSelector(usernameSelector, { visible: true, timeout: 10000 });
    await page.click(usernameSelector);
    await page.waitForTimeout(500);
    await page.type(usernameSelector, username, { delay: 100 });
    await page.waitForTimeout(1000);
    
    logs.steps.push({ step: 2, status: 'success', time: Date.now() });

    // Step 3: Nextボタンクリック
    logs.steps.push({ step: 3, action: 'Click Next button', time: Date.now() });
    console.log('[X-LOGIN] Step 3: Clicking Next...');
    
    // Enterキーを使用（より確実）
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    
    logs.steps.push({ step: 3, status: 'success', time: Date.now() });

    // Step 4: パスワード入力
    logs.steps.push({ step: 4, action: 'Enter password', time: Date.now() });
    console.log('[X-LOGIN] Step 4: Entering password...');
    
    const passwordSelector = 'input[type="password"]';
    await page.waitForSelector(passwordSelector, { visible: true, timeout: 10000 });
    await page.click(passwordSelector);
    await page.waitForTimeout(500);
    await page.type(passwordSelector, password, { delay: 100 });
    await page.waitForTimeout(1000);
    
    logs.steps.push({ step: 4, status: 'success', time: Date.now() });

    // Step 5: ログインボタンクリック
    logs.steps.push({ step: 5, action: 'Click Login button', time: Date.now() });
    console.log('[X-LOGIN] Step 5: Clicking Login...');
    
    await page.keyboard.press('Enter');
    console.log('[X-LOGIN] Login button clicked, waiting for completion...');

    // Step 6: ログイン完了待機（auth_token取得を待つ）
    logs.steps.push({ step: 6, action: 'Wait for auth_token', time: Date.now() });
    console.log('[X-LOGIN] Step 6: Waiting for authentication...');
    
    let authToken = null;
    const maxAttempts = 30;
    
    for (let i = 0; i < maxAttempts; i++) {
      await page.waitForTimeout(1000);
      
      const cookies = await page.cookies();
      authToken = cookies.find(c => c.name === 'auth_token');
      
      if (authToken) {
        console.log(`[X-LOGIN] ✅ auth_token found after ${i + 1} seconds!`);
        logs.steps.push({ 
          step: 6, 
          status: 'success', 
          time: Date.now(),
          message: `auth_token acquired after ${i + 1}s`
        });
        break;
      }
      
      // URLチェック（ログイン完了している可能性）
      const currentUrl = page.url();
      if (!currentUrl.includes('/login') && !currentUrl.includes('/flow')) {
        console.log(`[X-LOGIN] URL changed to: ${currentUrl}`);
        logs.steps.push({
          step: 6,
          status: 'url_changed',
          url: currentUrl,
          time: Date.now()
        });
        break;
      }
    }

    // 最終Cookie取得
    const finalCookies = await page.cookies();
    const finalAuthToken = finalCookies.find(c => c.name === 'auth_token');
    const ct0Token = finalCookies.find(c => c.name === 'ct0');

    if (finalAuthToken) {
      console.log('[X-LOGIN] ✅ Login successful!');
      return {
        success: true,
        cookies: finalCookies,
        authToken: finalAuthToken.value,
        ct0Token: ct0Token?.value,
        currentUrl: page.url(),
        logs
      };
    } else {
      console.log('[X-LOGIN] ❌ Login failed - no auth_token');
      logs.errors.push('auth_token not found after 30 seconds');
      return {
        success: false,
        message: 'Login failed - no auth_token acquired',
        cookies: finalCookies,
        currentUrl: page.url(),
        logs
      };
    }

  } catch (error) {
    console.error('[X-LOGIN] ❌ Error:', error.message);
    logs.errors.push({
      message: error.message,
      stack: error.stack,
      time: Date.now()
    });

    return {
      success: false,
      error: error.message,
      logs
    };
  }
}

/**
 * リクエスト/レスポンスデバッグ用のリスナー設定
 */
function setupDebugListeners(page, logs) {
  // リクエストログ
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/login') || 
        url.includes('/sessions') || 
        url.includes('/authenticate') ||
        url.includes('/i/api/')) {
      logs.requests.push({
        url,
        method: request.method(),
        timestamp: Date.now()
      });
      console.log(`[DEBUG] Request: ${request.method()} ${url}`);
    }
  });

  // レスポンスログ
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/login') || 
        url.includes('/sessions') || 
        url.includes('/authenticate') ||
        url.includes('/i/api/')) {
      
      const status = response.status();
      let body = null;

      try {
        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('application/json')) {
          body = await response.json();
        }
      } catch (e) {
        // JSON parseエラーは無視
      }

      logs.responses.push({
        url,
        status,
        timestamp: Date.now(),
        body: body ? JSON.stringify(body).substring(0, 200) : null
      });

      console.log(`[DEBUG] Response: ${status} ${url}`);
      if (body && status !== 200) {
        console.log(`[DEBUG] Body:`, JSON.stringify(body).substring(0, 200));
      }
    }
  });

  // コンソールエラー
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error') {
      const text = msg.text();
      // Google認証エラーは無視
      if (!text.includes('GSI_LOGGER') && !text.includes('google')) {
        logs.errors.push({
          type: 'console_error',
          message: text,
          timestamp: Date.now()
        });
        console.log(`[DEBUG] Console Error: ${text}`);
      }
    }
  });
}

/**
 * 詳細デバッグ付きログイン
 */
async function loginToXWithDebug(page, username, password) {
  const logs = {
    steps: [],
    requests: [],
    responses: [],
    errors: []
  };

  // デバッグリスナー設定
  setupDebugListeners(page, logs);

  // ログイン実行
  const result = await loginToX(page, username, password);
  
  // ログを統合
  result.logs = {
    ...result.logs,
    requests: logs.requests,
    responses: logs.responses,
    errors: [...(result.logs.errors || []), ...logs.errors]
  };

  return result;
}

module.exports = {
  loginToX,
  loginToXWithDebug,
  setupDebugListeners
};