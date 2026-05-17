(function attachBackgroundStep6(root, factory) {
  root.MultiPageBackgroundStep6 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep6Module() {
  const DEFAULT_REGISTRATION_SUCCESS_WAIT_MS = 20000;
  const DEFAULT_PLUS_FREE_OFFER_CHECK_TIMEOUT_MS = 15000;
  const SIGNUP_PAGE_SOURCE = 'signup-page';
  const STEP6_COOKIE_CLEAR_DOMAINS = [
    'chatgpt.com',
    'chat.openai.com',
    'openai.com',
    'auth.openai.com',
    'auth0.openai.com',
    'accounts.openai.com',
  ];
  const STEP6_COOKIE_CLEAR_ORIGINS = [
    'https://chatgpt.com',
    'https://chat.openai.com',
    'https://auth.openai.com',
    'https://auth0.openai.com',
    'https://accounts.openai.com',
    'https://openai.com',
  ];

  function normalizeStep6CookieDomain(domain) {
    return String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  }

  function shouldClearStep6Cookie(cookie) {
    const domain = normalizeStep6CookieDomain(cookie?.domain);
    if (!domain) return false;
    return STEP6_COOKIE_CLEAR_DOMAINS.some((target) => (
      domain === target || domain.endsWith(`.${target}`)
    ));
  }

  function buildStep6CookieRemovalUrl(cookie) {
    const host = normalizeStep6CookieDomain(cookie?.domain);
    const rawPath = String(cookie?.path || '/');
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return `https://${host}${path}`;
  }

  async function collectStep6Cookies(chromeApi) {
    if (!chromeApi.cookies?.getAll) {
      return [];
    }

    const stores = chromeApi.cookies.getAllCookieStores
      ? await chromeApi.cookies.getAllCookieStores()
      : [{ id: undefined }];
    const cookies = [];
    const seen = new Set();

    for (const store of stores) {
      const storeId = store?.id;
      const batch = await chromeApi.cookies.getAll(storeId ? { storeId } : {});
      for (const cookie of batch || []) {
        if (!shouldClearStep6Cookie(cookie)) continue;
        const key = [
          cookie.storeId || storeId || '',
          cookie.domain || '',
          cookie.path || '',
          cookie.name || '',
          cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : '',
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push(cookie);
      }
    }

    return cookies;
  }

  async function removeStep6Cookie(chromeApi, cookie, getErrorMessage) {
    const details = {
      url: buildStep6CookieRemovalUrl(cookie),
      name: cookie.name,
    };
    if (cookie.storeId) {
      details.storeId = cookie.storeId;
    }
    if (cookie.partitionKey) {
      details.partitionKey = cookie.partitionKey;
    }

    try {
      const result = await chromeApi.cookies.remove(details);
      return Boolean(result);
    } catch (error) {
      console.warn('[MultiPage:step6] remove cookie failed', {
        domain: cookie?.domain,
        name: cookie?.name,
        message: getErrorMessage(error),
      });
      return false;
    }
  }

  function createStep6Executor(deps = {}) {
    const {
      addLog = async () => {},
      chrome: chromeApi = globalThis.chrome,
      completeStepFromBackground,
      ensureContentScriptReadyOnTab,
      getTabId,
      getErrorMessage = (error) => error?.message || String(error || '未知错误'),
      isTabAlive,
      plusFreeOfferCheckTimeoutMs = DEFAULT_PLUS_FREE_OFFER_CHECK_TIMEOUT_MS,
      registrationSuccessWaitMs = DEFAULT_REGISTRATION_SUCCESS_WAIT_MS,
      sendToContentScriptResilient,
      setState,
      SIGNUP_PAGE_INJECT_FILES = [],
      sleepWithStop = async (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
    } = deps;

    function buildPlusFreeOfferStateUpdate(result = {}) {
      return {
        plusFreeOfferAvailable: Boolean(result?.plusFreeOfferAvailable),
        plusFreeOfferLabel: String(result?.plusFreeOfferLabel || '').trim(),
        plusFreeOfferCheckedAt: String(result?.plusFreeOfferCheckedAt || new Date().toISOString()).trim(),
        plusFreeOfferUrl: String(result?.url || '').trim(),
      };
    }

    async function clearCookiesIfEnabled(state = {}) {
      if (!state?.step6CookieCleanupEnabled) {
        return;
      }
      if (!chromeApi?.cookies?.getAll || !chromeApi.cookies?.remove) {
        await addLog('步骤 6：当前浏览器不支持 cookies API，跳过第六步 Cookies 清理。', 'warn');
        return;
      }

      try {
        await addLog('步骤 6：已开启 Cookies 清理，正在清理 ChatGPT / OpenAI cookies...', 'info');
        const cookies = await collectStep6Cookies(chromeApi);
        let removedCount = 0;
        for (const cookie of cookies) {
          if (await removeStep6Cookie(chromeApi, cookie, getErrorMessage)) {
            removedCount += 1;
          }
        }

        if (chromeApi.browsingData?.removeCookies) {
          try {
            await chromeApi.browsingData.removeCookies({
              since: 0,
              origins: STEP6_COOKIE_CLEAR_ORIGINS,
            });
          } catch (error) {
            await addLog(`步骤 6：browsingData 补扫 cookies 失败：${getErrorMessage(error)}`, 'warn');
          }
        }

        await addLog(`步骤 6：已清理 ${removedCount} 个 ChatGPT / OpenAI cookies。`, 'ok');
      } catch (error) {
        await addLog(`步骤 6：Cookies 清理失败，已跳过并继续后续流程：${getErrorMessage(error)}`, 'warn');
      }
    }

    async function checkPlusFreeOfferAfterRegistration() {
      if (
        typeof getTabId !== 'function'
        || typeof ensureContentScriptReadyOnTab !== 'function'
        || typeof sendToContentScriptResilient !== 'function'
        || typeof setState !== 'function'
      ) {
        return null;
      }

      const tabId = await getTabId(SIGNUP_PAGE_SOURCE);
      if (!Number.isInteger(tabId)) {
        await addLog('步骤 6：未找到 ChatGPT 注册页标签，跳过 Plus 试用入口检测。', 'warn');
        return null;
      }

      if (typeof isTabAlive === 'function' && !await isTabAlive(SIGNUP_PAGE_SOURCE)) {
        await addLog('步骤 6：ChatGPT 注册页标签已关闭，跳过 Plus 试用入口检测。', 'warn');
        return null;
      }

      try {
        await ensureContentScriptReadyOnTab(SIGNUP_PAGE_SOURCE, tabId, {
          inject: SIGNUP_PAGE_INJECT_FILES,
          injectSource: SIGNUP_PAGE_SOURCE,
          timeoutMs: 10000,
          logMessage: '步骤 6：正在等待 ChatGPT 首页脚本就绪，用于检测 Plus 试用入口...',
          logStep: 6,
          logStepKey: 'wait-registration-success',
        });

        const result = await sendToContentScriptResilient(SIGNUP_PAGE_SOURCE, {
          type: 'CHECK_PLUS_FREE_OFFER',
          source: 'background',
          payload: {
            timeoutMs: 10000,
            intervalMs: 500,
          },
        }, {
          timeoutMs: Math.max(1000, Number(plusFreeOfferCheckTimeoutMs) || DEFAULT_PLUS_FREE_OFFER_CHECK_TIMEOUT_MS),
          responseTimeoutMs: Math.max(12000, Number(plusFreeOfferCheckTimeoutMs) || DEFAULT_PLUS_FREE_OFFER_CHECK_TIMEOUT_MS),
          retryDelayMs: 700,
          logMessage: '步骤 6：ChatGPT 首页暂时无响应，正在重试 Plus 试用入口检测...',
          logStep: 6,
          logStepKey: 'wait-registration-success',
        });

        if (result?.error) {
          throw new Error(result.error);
        }

        const updates = buildPlusFreeOfferStateUpdate(result);
        await setState(updates);
        if (updates.plusFreeOfferAvailable) {
          await addLog(`步骤 6：检测到 Plus 试用入口（${updates.plusFreeOfferLabel || 'Free offer'}），当前账号有试用资格。`, 'ok');
        } else {
          await addLog('步骤 6：未检测到 Free offer / Claim offer，当前账号可能没有 Plus 试用资格。', 'warn');
        }
        return updates;
      } catch (error) {
        await addLog(`步骤 6：Plus 试用入口检测失败，已记录为未确认并继续流程：${getErrorMessage(error)}`, 'warn');
        return null;
      }
    }

    async function executeStep6(state = {}) {
      const waitMs = Math.max(0, Math.floor(Number(registrationSuccessWaitMs) || 0));
      if (waitMs > 0) {
        await addLog(`步骤 6：等待 ${Math.round(waitMs / 1000)} 秒，确认注册成功并让页面稳定...`, 'info');
        await sleepWithStop(waitMs);
      }
      await checkPlusFreeOfferAfterRegistration();
      await clearCookiesIfEnabled(state);
      await addLog('步骤 6：注册成功等待完成，准备继续后续步骤。', 'ok');
      await completeStepFromBackground(6);
    }

    return { executeStep6 };
  }

  return { createStep6Executor };
});
