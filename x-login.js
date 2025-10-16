// x-login.js - Xログイン処理

/**
 * Xログイン（改善版 - より長い待機時間）
 */
async function loginToX(page, username, password) {
  const logs = {
    steps: [],
    errors: []
  };

  try {
    console.log('[X-LOGIN] Starting login...');
    
    // Step 1: ログインページへ
    logs.steps.push({ step: 1, action: 'Navigate to login', time: Date.now() });
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });
    console.log('[X-LOGIN] ✓ Login page loaded');
    await page.waitForTimeout(3000);

    // Step 2: ユーザー名入力
    logs.steps.push({ step: 2, action: 'Enter username', time: Date.now() });
    const usernameSelector = 'input[autocomplete="username"]';
    await page.waitForSelector(usernameSelector, { visible: true, timeout: 15000 });
    await page.click(usernameSelector);
    await page.waitForTimeout(500);
    
    // 1文字ずつゆっくり入力
    for (const char of username) {
      await page.keyboard.type(char);
      await page.waitForTimeout(100);
    }
    console.log('[X-LOGIN] ✓ Username entered');
    await page.waitForTimeout(2000);

    // Step 3: Next ボタン
    logs.steps.push({ step: 3, action: 'Click Next', time: Date.now() });
    await page.keyboard.press('Enter');
    console.log('[X-LOGIN] ✓ Next clicked');
    await page.waitForTimeout(5000); // 長めに待機

    // Step 4: パスワード入力待機
    logs.steps.push({ step: 4, action: 'Wait for password field', time: Date.now() });
    const passwordSelector = 'input[type="password"]';
    
    try {
      await page.waitForSelector(passwordSelector, { visible: true, timeout: 15000 });
      console.log('[X-LOGIN] ✓ Password field found');
    } catch (e) {
      // パスワードフィールドが見つからない場合
      const currentUrl = page.url();
      console.log('[X-LOGIN] ⚠ Password field not found, URL:', currentUrl);
      
      // 追加認証が必要な場合の検出
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes('Unusual') || bodyText.includes('確認') || bodyText.includes('verify')) {
        logs.errors.push('Additional verification required (phone/email)');
        return {
          success: false,
          message: 'Additional verification required',
          needsVerification: true,
          logs
        };
      }
      
      throw e;
    }

    // Step 5: パスワード入力
    logs.steps.push({ step: 5, action: 'Enter password', time: Date.now() });
    await page.click(passwordSelector);
    await page.waitForTimeout(500);
    
    for (const char of password) {
      await page.keyboard.type(char);
      await page.waitForTimeout(100);
    }
    console.log('[X-LOGIN] ✓ Password entered');
    await page.waitForTimeout(2000);

    // Step 6: ログインボタン
    logs.steps.push({ step: 6, action: 'Click Login', time: Date.now() });
    await page.keyboard.press('Enter');
    console.log('[X-LOGIN] ✓ Login clicked, waiting for auth...');

    // Step 7: ログイン完了待機（最大60秒）
    logs.steps.push({ step: 7, action: 'Wait for auth_token', time: Date.now() });
    let authToken = null;
    
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      
      // Cookie確認
      const cookies = await page.cookies();
      authToken = cookies.find(c => c.name === 'auth_token');
      
      if (authToken) {
        console.log(`[X-LOGIN] ✅ auth_token found after ${i + 1}s!`);
        break;
      }
      
      // URL変化確認
      const currentUrl = page.url();
      if (!currentUrl.includes('/login') && !currentUrl.includes('/flow')) {
        console.log(`[X-LOGIN] ✓ URL changed: ${currentUrl}`);
        // さらに少し待ってCookie確認
        await page.waitForTimeout(3000);
        const finalCookies = await page.cookies();
        authToken = finalCookies.find(c => c.name === 'auth_token');
        if (authToken) {
          console.log(`[X-LOGIN] ✅ auth_token found after URL change!`);
        }
        break;
      }
      
      // 10秒ごとに状況ログ
      if (i % 10 === 9) {
        console.log(`[X-LOGIN] ⏳ Still waiting... ${i + 1}s elapsed`);
      }
    }

    // 最終結果
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
      console.log('[X-LOGIN] ❌ Login failed - no auth_token after 60s');
      
      // スクリーンショット取得（デバッグ用）
      const screenshot = await page.screenshot({ encoding: 'base64' });
      
      return {
        success: false,
        message: 'Login timeout - no auth_token',
        currentUrl: page.url(),
        cookies: finalCookies,
        screenshot: screenshot.substring(0, 100) + '...', // 最初の100文字だけ
        logs
      };
    }

  } catch (error) {
    console.error('[X-LOGIN] ❌ Error:', error.message);
    logs.errors.push({
      message: error.message,
      stack: error.stack
    });

    return {
      success: false,
      error: error.message,
      currentUrl: page.url(),
      logs
    };
  }
}

module.exports = {
  loginToX
};