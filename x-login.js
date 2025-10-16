// x-login.js - Xログイン処理（複数セレクター対応版）

/**
 * 待機用のヘルパー関数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 複数のセレクターを試して要素を見つける
 */
async function findElement(page, selectors, timeout = 15000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await page.evaluate(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && 
                   style.visibility !== 'hidden' && 
                   style.opacity !== '0';
          }, element);
          
          if (isVisible) {
            console.log(`[X-LOGIN] Found element with selector: ${selector}`);
            return { element, selector };
          }
        }
      } catch (e) {
        // セレクターが無効な場合はスキップ
      }
    }
    await sleep(500);
  }
  
  throw new Error(`None of the selectors found: ${selectors.join(', ')}`);
}

/**
 * Xログイン（改善版 - 複数セレクター対応）
 */
async function loginToX(page, username, password) {
  const logs = {
    steps: [],
    errors: [],
    screenshots: []
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
    await sleep(3000);

    // ページのHTMLを取得（デバッグ用）
    const pageContent = await page.content();
    console.log('[X-LOGIN] Page content length:', pageContent.length);

    // Step 2: ユーザー名入力欄を探す
    logs.steps.push({ step: 2, action: 'Find username field', time: Date.now() });
    
    const usernameSelectors = [
      'input[autocomplete="username"]',
      'input[name="text"]',
      'input[type="text"]',
      'input[name="session[username_or_email]"]',
      'input[placeholder*="Phone"]',
      'input[placeholder*="email"]',
      'input[placeholder*="username"]',
      'input',  // 最後の手段
    ];
    
    let usernameField;
    try {
      const result = await findElement(page, usernameSelectors, 20000);
      usernameField = result.element;
      console.log(`[X-LOGIN] ✓ Username field found: ${result.selector}`);
    } catch (e) {
      console.error('[X-LOGIN] ❌ Could not find username field');
      
      // スクリーンショット取得
      try {
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        logs.screenshots.push({ 
          step: 'username_field_not_found',
          data: screenshot.substring(0, 200) + '...'
        });
      } catch (err) {}
      
      logs.errors.push(`Username field not found. Tried: ${usernameSelectors.join(', ')}`);
      
      return {
        success: false,
        message: 'Username input field not found',
        currentUrl: page.url(),
        logs
      };
    }

    // Step 3: ユーザー名入力
    logs.steps.push({ step: 3, action: 'Enter username', time: Date.now() });
    await usernameField.click();
    await sleep(500);
    
    // クリアしてから入力
    await usernameField.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    
    for (const char of username) {
      await page.keyboard.type(char);
      await sleep(100);
    }
    console.log('[X-LOGIN] ✓ Username entered');
    await sleep(2000);

    // Step 4: Next ボタンを探してクリック
    logs.steps.push({ step: 4, action: 'Find and click Next', time: Date.now() });
    
    const nextButtonSelectors = [
      'button:has-text("Next")',
      'div[role="button"]:has-text("Next")',
      '[data-testid="ocf-button"]',
      'button[type="button"]',
      'div[role="button"]'
    ];
    
    // Nextボタンを探す
    let nextClicked = false;
    for (const selector of nextButtonSelectors) {
      try {
        const buttons = await page.$$(selector);
        for (const button of buttons) {
          const text = await page.evaluate(el => el.textContent, button);
          if (text.toLowerCase().includes('next') || text.toLowerCase().includes('次へ')) {
            await button.click();
            nextClicked = true;
            console.log('[X-LOGIN] ✓ Next button clicked');
            break;
          }
        }
        if (nextClicked) break;
      } catch (e) {}
    }
    
    // ボタンが見つからなければEnterキー
    if (!nextClicked) {
      console.log('[X-LOGIN] Next button not found, trying Enter key');
      await page.keyboard.press('Enter');
    }
    
    await sleep(5000);

    // Step 5: パスワード入力待機
    logs.steps.push({ step: 5, action: 'Find password field', time: Date.now() });
    
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
      'input[autocomplete="password"]'
    ];
    
    let passwordField;
    try {
      const result = await findElement(page, passwordSelectors, 20000);
      passwordField = result.element;
      console.log(`[X-LOGIN] ✓ Password field found: ${result.selector}`);
    } catch (e) {
      const currentUrl = page.url();
      console.log('[X-LOGIN] ⚠ Password field not found, URL:', currentUrl);
      
      // 追加認証チェック
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes('Unusual') || 
          bodyText.includes('確認') || 
          bodyText.includes('verify') ||
          bodyText.includes('phone') ||
          bodyText.includes('email')) {
        logs.errors.push('Additional verification required');
        return {
          success: false,
          message: 'Additional verification required (phone/email)',
          needsVerification: true,
          currentUrl,
          logs
        };
      }
      
      // スクリーンショット
      try {
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        logs.screenshots.push({ 
          step: 'password_field_not_found',
          data: screenshot.substring(0, 200) + '...'
        });
      } catch (err) {}
      
      logs.errors.push(`Password field not found. Tried: ${passwordSelectors.join(', ')}`);
      
      return {
        success: false,
        message: 'Password field not found',
        currentUrl,
        logs
      };
    }

    // Step 6: パスワード入力
    logs.steps.push({ step: 6, action: 'Enter password', time: Date.now() });
    await passwordField.click();
    await sleep(500);
    
    for (const char of password) {
      await page.keyboard.type(char);
      await sleep(100);
    }
    console.log('[X-LOGIN] ✓ Password entered');
    await sleep(2000);

    // Step 7: ログインボタン
    logs.steps.push({ step: 7, action: 'Click Login', time: Date.now() });
    
    // ログインボタンを探す
    let loginClicked = false;
    const loginButtonSelectors = [
      'button:has-text("Log in")',
      'div[role="button"]:has-text("Log in")',
      '[data-testid="LoginForm_Login_Button"]',
      'button[type="submit"]'
    ];
    
    for (const selector of loginButtonSelectors) {
      try {
        const buttons = await page.$$(selector);
        for (const button of buttons) {
          const text = await page.evaluate(el => el.textContent, button);
          if (text.toLowerCase().includes('log in') || 
              text.toLowerCase().includes('login') ||
              text.toLowerCase().includes('ログイン')) {
            await button.click();
            loginClicked = true;
            console.log('[X-LOGIN] ✓ Login button clicked');
            break;
          }
        }
        if (loginClicked) break;
      } catch (e) {}
    }
    
    if (!loginClicked) {
      console.log('[X-LOGIN] Login button not found, trying Enter key');
      await page.keyboard.press('Enter');
    }
    
    console.log('[X-LOGIN] Waiting for authentication...');

    // Step 8: ログイン完了待機（最大60秒）
    logs.steps.push({ step: 8, action: 'Wait for auth_token', time: Date.now() });
    let authToken = null;
    
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      
      const cookies = await page.cookies();
      authToken = cookies.find(c => c.name === 'auth_token');
      
      if (authToken) {
        console.log(`[X-LOGIN] ✅ auth_token found after ${i + 1}s!`);
        break;
      }
      
      const currentUrl = page.url();
      if (!currentUrl.includes('/login') && !currentUrl.includes('/flow')) {
        console.log(`[X-LOGIN] ✓ URL changed: ${currentUrl}`);
        await sleep(3000);
        const finalCookies = await page.cookies();
        authToken = finalCookies.find(c => c.name === 'auth_token');
        if (authToken) {
          console.log(`[X-LOGIN] ✅ auth_token found after URL change!`);
        }
        break;
      }
      
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
      
      const currentUrl = page.url();
      const pageTitle = await page.title();
      
      return {
        success: false,
        message: 'Login timeout - no auth_token acquired',
        currentUrl,
        pageTitle,
        cookies: finalCookies,
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