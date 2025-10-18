// x-login.js - Xログイン処理（完全版）

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * ページの詳細情報を取得
 */
async function getPageDebugInfo(page) {
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      bodyLength: document.body.innerHTML.length,
      inputCount: inputs.length,
      inputs: inputs.map((input, idx) => ({
        index: idx,
        type: input.type,
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        autocomplete: input.autocomplete,
        className: input.className,
        visible: input.offsetWidth > 0 && input.offsetHeight > 0
      })),
      bodyTextPreview: document.body.innerText.substring(0, 300)
    };
  });
}

/**
 * Xログイン
 */
async function loginToX(page, username, password) {
  const logs = {
    steps: [],
    errors: [],
    debug: []
  };

  try {
    console.log('[X-LOGIN] ==================== START ====================');
    
    // Step 1: ログインページへ
    console.log('[X-LOGIN] Step 1: Navigating...');
    logs.steps.push({ step: 1, action: 'Navigate', time: Date.now() });
    
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: ['load', 'domcontentloaded'],
      timeout: 60000
    });
    
    console.log('[X-LOGIN] Page loaded, waiting 8 seconds...');
    await sleep(8000);
    
    // ページ情報取得
    const pageInfo1 = await getPageDebugInfo(page);
    console.log('[X-LOGIN] === PAGE INFO AFTER LOAD ===');
    console.log(JSON.stringify(pageInfo1, null, 2));
    logs.debug.push({ stage: 'after_load', info: pageInfo1 });
    
    if (pageInfo1.inputCount === 0) {
      console.error('[X-LOGIN] ❌ NO INPUTS FOUND ON PAGE!');
      logs.errors.push('No input elements found on page');
      
      const html = await page.content();
      console.log('[X-LOGIN] HTML length:', html.length);
      console.log('[X-LOGIN] HTML preview:', html.substring(0, 2000));
      
      return {
        success: false,
        message: 'No input fields found. X may have blocked the request.',
        currentUrl: page.url(),
        logs
      };
    }
    
    // Step 2: ユーザー名入力
    console.log('[X-LOGIN] Step 2: Finding username input...');
    logs.steps.push({ step: 2, action: 'Find username', time: Date.now() });
    
    const usernameInputIndex = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        if (input.offsetWidth > 0 && input.offsetHeight > 0) {
          console.log(`Found visible input at index ${i}:`, {
            type: input.type,
            name: input.name,
            placeholder: input.placeholder
          });
          return i;
        }
      }
      return -1;
    });
    
    if (usernameInputIndex === -1) {
      console.error('[X-LOGIN] ❌ No visible input found');
      logs.errors.push('No visible input elements');
      
      return {
        success: false,
        message: 'No visible input field found',
        currentUrl: page.url(),
        logs
      };
    }
    
    console.log(`[X-LOGIN] Using input at index: ${usernameInputIndex}`);
    
    const inputs = await page.$$('input');
    const usernameInput = inputs[usernameInputIndex];
    
    console.log('[X-LOGIN] Clicking input...');
    await usernameInput.click();
    await sleep(1000);
    
    console.log('[X-LOGIN] Typing username...');
    await page.keyboard.type(username, { delay: 150 });
    
    console.log('[X-LOGIN] ✓ Username entered');
    logs.steps.push({ step: 2, status: 'success', time: Date.now() });
    await sleep(2000);
    
    // Step 3: Next
    console.log('[X-LOGIN] Step 3: Pressing Enter for Next...');
    logs.steps.push({ step: 3, action: 'Click Next', time: Date.now() });
    
    await page.keyboard.press('Enter');
    console.log('[X-LOGIN] ✓ Enter pressed');
    logs.steps.push({ step: 3, status: 'success', time: Date.now() });
    await sleep(8000);
    
    const pageInfo2 = await getPageDebugInfo(page);
    console.log('[X-LOGIN] === PAGE INFO AFTER NEXT ===');
    console.log(JSON.stringify(pageInfo2, null, 2));
    logs.debug.push({ stage: 'after_next', info: pageInfo2 });
    
    // Step 4: パスワード入力
    console.log('[X-LOGIN] Step 4: Finding password input...');
    logs.steps.push({ step: 4, action: 'Find password', time: Date.now() });
    
    const passwordInputIndex = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        if (input.type === 'password' && input.offsetWidth > 0 && input.offsetHeight > 0) {
          console.log(`Found password input at index ${i}`);
          return i;
        }
      }
      return -1;
    });
    
    if (passwordInputIndex === -1) {
      console.error('[X-LOGIN] ⚠ Password field not found');
      
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('[X-LOGIN] Body text:', bodyText.substring(0, 500));
      
      if (bodyText.toLowerCase().includes('unusual') ||
          bodyText.toLowerCase().includes('verify') ||
          bodyText.toLowerCase().includes('phone')) {
        
        logs.errors.push('Additional verification required');
        
        return {
          success: false,
          message: 'Additional verification required',
          needsVerification: true,
          currentUrl: page.url(),
          logs
        };
      }
      
      logs.errors.push('Password field not found');
      
      return {
        success: false,
        message: 'Password field not found',
        currentUrl: page.url(),
        logs
      };
    }
    
    console.log(`[X-LOGIN] Using password input at index: ${passwordInputIndex}`);
    
    const inputs2 = await page.$$('input');
    const passwordInput = inputs2[passwordInputIndex];
    
    console.log('[X-LOGIN] Clicking password input...');
    await passwordInput.click();
    await sleep(1000);
    
    console.log('[X-LOGIN] Typing password...');
    await page.keyboard.type(password, { delay: 150 });
    
    console.log('[X-LOGIN] ✓ Password entered');
    logs.steps.push({ step: 4, status: 'success', time: Date.now() });
    await sleep(2000);
    
    // Step 5: Login
    console.log('[X-LOGIN] Step 5: Submitting login...');
    logs.steps.push({ step: 5, action: 'Submit', time: Date.now() });
    
    await page.keyboard.press('Enter');
    console.log('[X-LOGIN] ✓ Login submitted');
    logs.steps.push({ step: 5, status: 'success', time: Date.now() });
    
    // Step 6: 認証トークン待機
    console.log('[X-LOGIN] Step 6: Waiting for auth_token...');
    logs.steps.push({ step: 6, action: 'Wait for auth', time: Date.now() });
    
    let authToken = null;
    
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      
      const cookies = await page.cookies();
      authToken = cookies.find(c => c.name === 'auth_token');
      
      if (authToken) {
        console.log(`[X-LOGIN] ✅ auth_token found after ${i + 1}s!`);
        logs.steps.push({ step: 6, status: 'success', duration: i + 1, time: Date.now() });
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
          logs.steps.push({ step: 6, status: 'success', duration: i + 1, time: Date.now() });
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
        message: 'Login timeout - auth_token not received',
        currentUrl,
        cookies: finalCookies,
        logs
      };
    }

  } catch (error) {
    console.error('[X-LOGIN] ========== ❌ ERROR ==========');
    console.error('[X-LOGIN] Error:', error.message);
    
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