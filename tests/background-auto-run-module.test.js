const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports auto-run controller module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/auto-run-controller\.js/);
});

test('auto-run controller module exposes a factory', () => {
  const source = fs.readFileSync('background/auto-run-controller.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageBackgroundAutoRunController;`)(globalScope);

  assert.equal(typeof api?.createAutoRunController, 'function');
});

test('auto-run controller calls round success hook with successful run count', async () => {
  const source = fs.readFileSync('background/auto-run-controller.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundAutoRunController;`)(globalScope);
  const runtimeState = {
    autoRunActive: false,
    autoRunCurrentRun: 0,
    autoRunTotalRuns: 0,
    autoRunAttemptRun: 0,
    autoRunSessionId: 0,
  };
  let state = {
    stepStatuses: {},
    autoRunFallbackThreadIntervalMinutes: 0,
  };
  const eventOrder = [];
  const roundStartPayloads = [];
  const hookPayloads = [];
  const controller = api.createAutoRunController({
    addLog: async () => {},
    appendAccountRunRecord: async () => null,
    AUTO_RUN_MAX_RETRIES_PER_ROUND: 0,
    AUTO_RUN_RETRY_DELAY_MS: 0,
    AUTO_RUN_TIMER_KIND_BEFORE_RETRY: 'before_retry',
    AUTO_RUN_TIMER_KIND_BETWEEN_ROUNDS: 'between_rounds',
    broadcastAutoRunStatus: async () => {},
    broadcastStopToContentScripts: () => {},
    cancelPendingCommands: () => {},
    clearStopRequest: () => {},
    createAutoRunSessionId: () => 1,
    getAutoRunStatusPayload: (phase, payload = {}) => ({ autoRunPhase: phase, ...payload }),
    getErrorMessage: (error) => error?.message || String(error || ''),
    getFirstUnfinishedStep: () => 1,
    getPendingAutoRunTimerPlan: () => null,
    getRunningSteps: () => [],
    getStopRequested: () => false,
    getState: async () => state,
    hasSavedProgress: () => false,
    isAddPhoneAuthFailure: () => false,
    isGpcTaskEndedFailure: () => false,
    isPhoneSmsPlatformRateLimitFailure: () => false,
    isPlusCheckoutNonFreeTrialFailure: () => false,
    isRestartCurrentAttemptError: () => false,
    isStep4Route405RecoveryLimitFailure: () => false,
    isSignupUserAlreadyExistsFailure: () => false,
    isStopError: () => false,
    launchAutoRunTimerPlan: async () => false,
    normalizeAutoRunFallbackThreadIntervalMinutes: () => 0,
    onAutoRunRoundStart: async (payload) => {
      eventOrder.push(`start:${payload.targetRun}`);
      roundStartPayloads.push(payload);
    },
    onAutoRunRoundSuccess: async (payload) => hookPayloads.push(payload),
    persistAutoRunTimerPlan: async () => {},
    resetState: async () => {
      state = { stepStatuses: {}, autoRunFallbackThreadIntervalMinutes: 0 };
    },
    runAutoSequenceFromStep: async (_startStep, payload = {}) => {
      eventOrder.push(`run:${payload.targetRun}`);
    },
    runtime: {
      get: () => ({ ...runtimeState }),
      set: (updates = {}) => Object.assign(runtimeState, updates),
    },
    setState: async (updates = {}) => {
      state = { ...state, ...updates };
    },
    sleepWithStop: async () => {},
    throwIfAutoRunSessionStopped: () => {},
    waitForRunningStepsToFinish: async () => state,
    chrome: {
      runtime: {
        sendMessage: () => Promise.resolve(),
      },
    },
  });

  await controller.autoRunLoop(2, { autoRunSkipFailures: false, mode: 'restart' });

  assert.deepEqual(
    eventOrder,
    ['start:1', 'run:1', 'start:2', 'run:2']
  );
  assert.deepEqual(
    roundStartPayloads.map((payload) => ({
      targetRun: payload.targetRun,
      totalRuns: payload.totalRuns,
      attemptRun: payload.attemptRun,
      continued: payload.continued,
    })),
    [
      { targetRun: 1, totalRuns: 2, attemptRun: 1, continued: false },
      { targetRun: 2, totalRuns: 2, attemptRun: 1, continued: false },
    ]
  );
  assert.deepEqual(
    hookPayloads.map((payload) => ({
      targetRun: payload.targetRun,
      totalRuns: payload.totalRuns,
      attemptRun: payload.attemptRun,
      successfulRuns: payload.successfulRuns,
    })),
    [
      { targetRun: 1, totalRuns: 2, attemptRun: 1, successfulRuns: 1 },
      { targetRun: 2, totalRuns: 2, attemptRun: 1, successfulRuns: 2 },
    ]
  );
});

test('auto-run round reset preserves mode-specific proxy cursor fields', () => {
  const source = fs.readFileSync('background/auto-run-controller.js', 'utf8');
  assert.match(source, /ipProxyAccountCurrentIndex:\s*prevState\.ipProxyAccountCurrentIndex/);
  assert.match(source, /ipProxyAccountCurrent:\s*prevState\.ipProxyAccountCurrent/);
  assert.match(source, /ipProxyApiCurrentIndex:\s*prevState\.ipProxyApiCurrentIndex/);
  assert.match(source, /ipProxyApiCurrent:\s*prevState\.ipProxyApiCurrent/);

  const backgroundSource = fs.readFileSync('background.js', 'utf8');
  assert.match(backgroundSource, /'ipProxyAccountCurrentIndex'/);
  assert.match(backgroundSource, /ipProxyAccountCurrentIndex:\s*normalizeIpProxyCurrentIndex\(prev\.ipProxyAccountCurrentIndex,\s*0\)/);
  assert.match(backgroundSource, /'ipProxyApiCurrentIndex'/);
  assert.match(backgroundSource, /ipProxyApiCurrentIndex:\s*normalizeIpProxyCurrentIndex\(prev\.ipProxyApiCurrentIndex,\s*0\)/);
});
