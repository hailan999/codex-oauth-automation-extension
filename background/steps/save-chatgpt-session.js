(function attachBackgroundStepSaveChatGptSession(root, factory) {
  root.MultiPageBackgroundSaveChatGptSession = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundSaveChatGptSessionModule() {
  const CHATGPT_SESSION_STORAGE_KEY = 'chatgptSessionSnapshots';
  const DEFAULT_LOCAL_HELPER_BASE_URL = 'http://127.0.0.1:17373';
  const MAX_SESSION_SNAPSHOTS = 200;

  function createSaveChatGptSessionExecutor(deps = {}) {
    const {
      addLog = async () => {},
      chrome: chromeApi = globalThis.chrome,
      completeStepFromBackground,
      fetch: fetchApi = globalThis.fetch,
      getState = async () => ({}),
    } = deps;

    function normalizeHelperBaseUrl(value = '') {
      const raw = String(value || '').trim() || DEFAULT_LOCAL_HELPER_BASE_URL;
      return raw.replace(/\/+(?:sync-chatgpt-session-snapshots)?\/?$/i, '');
    }

    function buildHelperEndpoint(baseUrl, path) {
      return `${normalizeHelperBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
    }

    async function findChatGptTab() {
      const tabs = await chromeApi.tabs.query({
        url: [
          'https://chatgpt.com/*',
          'https://chat.openai.com/*',
        ],
      });
      return (tabs || [])
        .filter((tab) => Number.isInteger(tab?.id))
        .sort((left, right) => Number(right.active) - Number(left.active))[0] || null;
    }

    async function fetchSessionFromTab(tabId) {
      const [result] = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const response = await fetch('https://chatgpt.com/api/auth/session', {
            credentials: 'include',
            cache: 'no-store',
          });
          const text = await response.text();
          let payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch {
            payload = { raw: text };
          }
          return {
            ok: response.ok,
            status: response.status,
            payload,
          };
        },
        world: 'MAIN',
      });
      return result?.result || null;
    }

    function buildSnapshot(state, sessionResult) {
      const now = new Date().toISOString();
      const accountIdentifier = String(state.accountIdentifier || state.email || state.signupPhoneNumber || '').trim();
      const proxyAddress = buildProxyAddressFromState(state);
      const hotmailCredentials = resolveCurrentHotmailCredentials(state);
      return {
        id: `${accountIdentifier || 'chatgpt'}:${Date.now()}`,
        savedAt: now,
        accountIdentifierType: state.accountIdentifierType || (state.email ? 'email' : ''),
        accountIdentifier,
        email: String(state.email || '').trim(),
        phoneNumber: String(state.signupPhoneNumber || '').trim(),
        password: String(state.password || state.customPassword || ''),
        proxyAddress,
        hotmailClientId: hotmailCredentials.clientId,
        hotmailRefreshToken: hotmailCredentials.refreshToken,
        session: sessionResult.payload,
        sessionStatus: Number(sessionResult.status) || 0,
      };
    }

    function buildProxyAddressFromState(state = {}) {
      const current = state.ipProxyCurrent && typeof state.ipProxyCurrent === 'object'
        ? state.ipProxyCurrent
        : null;
      const host = String(current?.host || state.ipProxyAppliedHost || state.ipProxyHost || '').trim();
      const port = Number(current?.port || state.ipProxyAppliedPort || state.ipProxyPort || 0);
      if (!host || !port) {
        return '';
      }

      const protocol = String(current?.protocol || state.ipProxyProtocol || 'http').trim() || 'http';
      const username = String(current?.username || state.ipProxyUsername || '').trim();
      const password = String(current?.password || state.ipProxyPassword || '');
      const auth = username
        ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
        : '';
      return `${protocol}://${auth}${host}:${port}`;
    }

    function resolveCurrentHotmailCredentials(state = {}) {
      const currentId = String(state.currentHotmailAccountId || '').trim();
      const accounts = Array.isArray(state.hotmailAccounts) ? state.hotmailAccounts : [];
      const account = currentId
        ? accounts.find((item) => String(item?.id || '').trim() === currentId)
        : null;
      return {
        clientId: String(account?.clientId || '').trim(),
        refreshToken: String(account?.refreshToken || ''),
      };
    }

    async function persistSnapshot(snapshot) {
      const stored = await chromeApi.storage.local.get(CHATGPT_SESSION_STORAGE_KEY);
      const current = Array.isArray(stored?.[CHATGPT_SESSION_STORAGE_KEY])
        ? stored[CHATGPT_SESSION_STORAGE_KEY]
        : [];
      const next = [snapshot, ...current].slice(0, MAX_SESSION_SNAPSHOTS);
      await chromeApi.storage.local.set({ [CHATGPT_SESSION_STORAGE_KEY]: next });
      return next;
    }

    async function syncSnapshotsToProject(snapshots, state = {}) {
      if (typeof fetchApi !== 'function') {
        throw new Error('当前环境不支持请求本地 helper，无法写入项目目录。');
      }

      let response;
      try {
        response = await fetchApi(buildHelperEndpoint(state.accountRunHistoryHelperBaseUrl, '/sync-chatgpt-session-snapshots'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            generatedAt: new Date().toISOString(),
            snapshots,
          }),
        });
      } catch (error) {
        throw new Error(`写入项目目录失败：请先启动本地 helper（start-hotmail-helper.bat）。${error?.message || error}`);
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error(`写入项目目录失败：本地 helper 返回了无法解析的响应（${error?.message || error}）。`);
      }

      if (!response.ok || payload?.ok === false) {
        throw new Error(`写入项目目录失败：${payload?.error || `HTTP ${response.status}`}`);
      }

      return String(payload?.filePath || '');
    }

    async function executeSaveChatGptSession(stateOverride = {}) {
      await addLog('步骤 7：正在读取 ChatGPT Session...', 'info');
      const tab = await findChatGptTab();
      if (!tab?.id) {
        throw new Error('未找到 ChatGPT 页面，无法读取 /api/auth/session。');
      }

      const sessionResult = await fetchSessionFromTab(tab.id);
      if (!sessionResult?.ok) {
        throw new Error(`读取 ChatGPT Session 失败：HTTP ${sessionResult?.status || 'unknown'}`);
      }

      const state = {
        ...(await getState()),
        ...(stateOverride || {}),
      };
      const snapshot = buildSnapshot(state, sessionResult);
      const snapshots = await persistSnapshot(snapshot);
      const filePath = await syncSnapshotsToProject(snapshots, state);
      await addLog(`步骤 7：ChatGPT Session 已保存到项目目录：${filePath}`, 'ok');
      await completeStepFromBackground(Number(stateOverride.visibleStep) || 7, {
        chatgptSessionSavedAt: snapshot.savedAt,
        chatgptSessionFilePath: filePath,
      });
      return { ...snapshot, filePath };
    }

    return { executeSaveChatGptSession };
  }

  return {
    CHATGPT_SESSION_STORAGE_KEY,
    createSaveChatGptSessionExecutor,
  };
});
