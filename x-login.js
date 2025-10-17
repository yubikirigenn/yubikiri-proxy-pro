// x-login.js - Xログイン処理（DOM完全読み込み対応版）

/**
 * 待機用のヘルパー関数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ページが完全に読み込まれるまで待つ
 */
async function waitForPageLoad(page, timeout = 30000) {
  try {
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout }
    );
    console.log('[X-LOGIN] ✓ Page fully loaded');
    return true;
  } catch (e) {
    console.log('[X-LOGIN] ⚠ Page load timeout, continuing anyway');
    return false;
  }
}

/**
 * 要素を待機して取得
 */
async function waitAndGetElement(page, selectors, timeout = 20000) {
  const startTime = Date.now();
  
  console.log(`[X-LOGIN] Searching for elements: ${selectors.slice(0, 3).join(', ')}...`);
  
  while (Date.now() - startTime < timeout) {
    // すべての入力要素を取得して確認
    const inputs = await page.$$('input');
    
    for (const input of inputs) {
      try {
        const inputInfo = await page.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return {
            type: el.type,
            name: el.name,
            placeholder: el.placeholder,
            autocomplete: el.autocomplete,
            visible: rect.width > 0 && rect.height > 0 && 
                     window.getComputedStyle(el).display !== 'none' &&
                     window.getComputedStyle(el).visibility !== 'hidden',
            value: el.value
          };
        }, input);
        
        if (inputInfo.visible) {
          // セレクターに一致するかチェック
          for (const selector of selectors) {
            const matches = await page.evaluate((el, sel) => {
              try {
                return el.matches(sel);
              } catch {
                return false;
              }
            }, input, selector);
            
            if (matches) {
              console.log(`[X-LOGIN] ✓ Found input: ${selector}`, inputInfo);
              return input;
            }
          }
          
          // プレースホルダーやオートコンプリートでマッチング
          if (inputInfo.placeholder && (
            inputInfo.placeholder.toLowerCase().includes('phone') ||
            inputInfo.placeholder.toLowerCase().includes('email') ||
            inputInfo.placeholder.toLowerCase().includes('username')
          )) {
            console.log('[X-LOGIN] ✓ Found input by placeholder:', inputInfo);
            return input;
          }
          
          if (inputInfo.autocomplete === 'username' || 
              inputInfo.name === 'text' ||
              inputInfo.type === 'text') {
            console.log('[X-LOGIN] ✓ Found input by attributes:', inputInfo);
            return input;
          }
        }
      } catch (e) {
        // 要素が削除された場合などはスキップ
      }
    }
    
    await sleep(1000);
  }
  
  throw new Error(`No matching input found after ${timeout}ms`);
}

/**
 * Xログイン（改善版）
 */
async function loginToX(page, username, password) {
  const logs = {
    steps: [],
    errors: []
  };

  try {
    console.log('[X-LOGIN] ========== Starting login ==========');
    
    // Step 1: ログインページへ移動
    logs.steps.push({ step: 1, action: 'Navigate to login page', time: Date.now() });
    console.log('[X-LOGIN] Step 1: Navigating to login page...');
    
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: ['networkidle0', 'domcontentloaded'],
      timeout: 60000
    });
    
    console.log('[X-LOGIN] ✓ Page navigated');
    await sleep(5000); // ページが落ち着くまで待つ
    
    // ページ読み込み確認
    await waitForPageLoad(page);
    
    // ページ情報を取得
    const pageInfo = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      inputCount: document.querySelectorAll('input').length,
      bodyText: document.body.innerText.substring(0, 500)
    }));
    
    console.log('[X-LOGIN] Page info:', pageInfo);
    logs.steps.push({ step: 1, status: 'success', pageInfo, time: Date.now() });

    // Step 2: ユーザー名入力欄を探す
    logs.steps.push({ step: 2, action: 'Find username field', time: Date.now() });
    console.log('[X-LOGIN] Step 2: Finding username field...');
    
    const usernameSelectors = [
      'input[autocomplete="username"]',
      'input[name="text"]',
      'input[type="text"]'
    ];
    
    let usernameInput;
    try {
      usernameInput = await waitAndGetElement(page, usernameSelectors, 30000);
    } catch (e) {
      console.error('[X-LOGIN] ❌ Username field not found');
      
      // HTMLを取得してログに保存
      const html = await page.content();
      console.log('[X-LOGIN] Page HTML length:', html.length);
      console.log('[X-LOGIN] Page HTML preview:', html.substring(0, 1000));
      
      logs.errors.push({
        step: 'username_field',
        message: 'Username input not found',
        pageHtmlPreview: html.substring(0, 2000)
      });
      
      return {
        success: false,
        message: 'Username input field not found. Page may not have loaded correctly.',
        currentUrl: page.url(),
        logs
      };
    }
    
    console.log('[X-LOGIN] ✓ Username field found');
    logs.steps.push({ step: 2, status: 'success', time: Date.now() });

    // Step 3: ユーザー名を入力
    logs.steps.push({ step: 3, action: 'Enter username', time: Date.now() });
    console.log('[X-LOGIN] Step 3: Entering username...');
    
    await usernameInput.click({ clickCount: 3 });
    await sleep(500);
    await usernameInput.type(username, { delay: 150 });
    
    console.log('[X-LOGIN] ✓ Username entered');
    logs.steps.push({ step: 3, status: 'success', time: Date.now() });
    await sleep(2000);

    // Step 4: Nextボタンをクリック
    logs.steps.push({ step: 4, action: 'Click Next', time: Date.now() });
    console.log('[X-LOGIN] Step 4: Clicking Next...');
    
    await page.keyboard.press('Enter');
    console.log('[X-LOGIN] ✓ Enter pressed');
    logs.steps.push({ step: 4, status: 'success', time: Date.now() });
    await sleep(6000);

    // Step 5: パスワード入力欄を探す
    logs.steps.push({ step: 5, action: 'Find password field', time: Date.now() });
    console.log('[X-LOGIN] Step 5: Finding password field...');
    
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]'
    ];
    
    let passwordInput;
    try {
      passwordInput = await waitAndGetElement(page, passwordSelectors, 30000);
    } catch (e) {
      console.error('[X-LOGIN] ⚠ Password field not found');
      
      // 追加認証が必要かチェック
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('[X-LOGIN] Page text preview:', bodyText.substring(0, 500));
      
      if (bodyText.toLowerCase().includes('unusual') || 
          bodyText.toLowerCase().includes('verify') ||
          bodyText.toLowerCase().includes('confirm') ||
          bodyText.toLowerCase().includes('phone') && bodyText.toLowerCase().includes('number')) {
        
        logs.errors.push('Additional verification required');
        
        return {
          success: false,
          message: 'Additional verification required (phone/email confirmation)',
          needsVerification: true,
          currentUrl: page.url(),
          logs
        };
      }
      
      logs.errors.push({
        step: 'password_field',
        message: 'Password input not found',
        bodyTextPreview: bodyText.substring(0, 1000)
      });
      
      return {
        success: false,
        message: 'Password field not found. May need additional verification.',
        currentUrl: page.url(),
        logs
      };
    }
    
    console.log('[X-LOGIN] ✓ Password field found');
    logs.steps.push({ step: 5, status: 'success', time: Date.now() });

    // Step 6: パスワードを入力
    logs.steps.push({ step: 6, action: 'Enter password', time: Date.now() });
    console.log('[X-LOGIN] Step 6: Entering password...');
    
    await passwordInput.click();
    await sleep(500);
    await passwordInput.type(password, { delay: 150 });
    
    console.log('[X-LOGIN] ✓ Password entered');
    logs.steps.push({ step: 6, status: 'success', time: Date.now() });
    await sleep(2000);

    // Step 7: ログインボタンをクリック
    logs.steps.push({ step: 7, action: 'Submit login', time: Date.now() });
    console.log('[X-LOGIN] Step 7: Submitting login...');
    
    await page.keyboard.press('Enter');
    console.log('[X-LOGIN] ✓ Login submitted');
    logs.steps.push({ step: 7, status: 'success', time: Date.now() });

    // Step 8: 認証トークン待機
    logs.steps.push({ step: 8, action: 'Wait for auth_token', time: Date.now() });
    console.log('[X-LOGIN] Step 8: Waiting for authentication...');
    
    let authToken = null;
    
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      
      const cookies = await page.cookies();
      authToken = cookies.find(c => c.name === 'auth_token');
      
      if (authToken) {
        console.log(`[X-LOGIN] ✅ auth_token found after ${i + 1}s!`);
        logs.steps.push({ step: 8, status: 'success', duration: i + 1, time: Date.now() });
        break;
      }
      
      const currentUrl = page.url();
      if (!currentUrl.includes('/login') && !currentUrl.includes('/flow')) {
        console.log(`[X-LOGIN] ✓ URL changed to: ${currentUrl}`);
        await sleep(3000);
        
        const newCookies = await page.cookies();
        authToken = newCookies.find(c => c.name === 'auth_token');
        
        if (authToken) {
          console.log('[X-LOGIN] ✅ auth_token found after redirect!');
          logs.steps.push({ step: 8, status: 'success', duration: i + 1, time: Date.now() });
        }
        break;
      }
      
      if (i % 10 === 9) {
        console.log(`[X-LOGIN] ⏳ Still waiting... ${i + 1}s`);
      }
    }

    // 最終結果
    const finalCookies = await page.cookies();
    const finalAuthToken = finalCookies.find(c => c.name === 'auth_token');
    const ct0Token = finalCookies.find(c => c.name === 'ct0');
    const currentUrl = page.url();

    if (finalAuthToken) {
      console.log('[X-LOGIN] ========== ✅ LOGIN SUCCESSFUL ==========');
      return {
        success: true,
        cookies: finalCookies,
        authToken: finalAuthToken.value,
        ct0Token: ct0Token?.value,
        currentUrl,
        logs
      };
    } else {
      console.log('[X-LOGIN] ========== ❌ LOGIN FAILED (timeout) ==========');
      
      return {
        success: false,
        message: 'Login timeout - auth_token not received after 60 seconds',
        currentUrl,
        cookies: finalCookies,
        logs
      };
    }

  } catch (error) {
    console.error('[X-LOGIN] ========== ❌ ERROR ==========');
    console.error('[X-LOGIN] Error:', error.message);
    console.error('[X-LOGIN] Stack:', error.stack);
    
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