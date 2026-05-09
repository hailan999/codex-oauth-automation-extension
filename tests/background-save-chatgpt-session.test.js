const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/save-chatgpt-session.js', 'utf8');

test('save ChatGPT session executor fetches session in ChatGPT tab and stores snapshot', async () => {
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundSaveChatGptSession;`)(globalScope);
  const logs = [];
  const completed = [];
  const fetchCalls = [];
  let stored = {};
  const chrome = {
    tabs: {
      query: async () => [{ id: 42, active: true, url: 'https://chatgpt.com/' }],
    },
    scripting: {
      executeScript: async ({ target, func, world }) => {
        assert.deepEqual(target, { tabId: 42 });
        assert.equal(world, 'MAIN');
        assert.equal(typeof func, 'function');
        return [{
          result: {
            ok: true,
            status: 200,
            payload: { user: { email: 'saved@example.com' }, expires: '2099-01-01T00:00:00.000Z' },
          },
        }];
      },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: stored[key] }),
        set: async (payload) => {
          stored = { ...stored, ...payload };
        },
      },
    },
  };

  const executor = api.createSaveChatGptSessionExecutor({
    addLog: async (message, level) => logs.push({ message, level }),
    chrome,
    completeStepFromBackground: async (step, payload) => completed.push({ step, payload }),
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, filePath: 'E:\\development\\git_projects\\codex-oauth-automation-extension\\data\\chatgpt-session-snapshots.json' }),
      };
    },
    getState: async () => ({
      email: 'saved@example.com',
      password: 'pw',
      accountIdentifierType: 'email',
      accountIdentifier: 'saved@example.com',
      accountRunHistoryHelperBaseUrl: 'http://127.0.0.1:17373',
      ipProxyCurrent: {
        host: 'proxy.example.com',
        port: 8000,
        protocol: 'http',
        username: 'proxy-user',
        password: 'proxy-pass',
      },
      currentHotmailAccountId: 'hot-1',
      hotmailAccounts: [{
        id: 'hot-1',
        clientId: 'client-id-1',
        refreshToken: 'refresh-token-1',
      }],
    }),
  });

  const snapshot = await executor.executeSaveChatGptSession({ visibleStep: 7 });
  assert.equal(snapshot.email, 'saved@example.com');
  assert.deepEqual(snapshot.session.user, { email: 'saved@example.com' });
  assert.equal(snapshot.proxyAddress, 'http://proxy-user:proxy-pass@proxy.example.com:8000');
  assert.equal(snapshot.hotmailClientId, 'client-id-1');
  assert.equal(snapshot.hotmailRefreshToken, 'refresh-token-1');
  assert.match(snapshot.filePath, /chatgpt-session-snapshots\.json$/);
  assert.equal(stored.chatgptSessionSnapshots.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:17373/sync-chatgpt-session-snapshots');
  const syncPayload = JSON.parse(fetchCalls[0].options.body);
  assert.equal(syncPayload.snapshots.length, 1);
  assert.equal(syncPayload.snapshots[0].proxyAddress, 'http://proxy-user:proxy-pass@proxy.example.com:8000');
  assert.equal(syncPayload.snapshots[0].hotmailClientId, 'client-id-1');
  assert.equal(syncPayload.snapshots[0].hotmailRefreshToken, 'refresh-token-1');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].step, 7);
  assert.match(completed[0].payload.chatgptSessionFilePath, /chatgpt-session-snapshots\.json$/);
  assert.match(logs.at(-1).message, /已保存/);
});
