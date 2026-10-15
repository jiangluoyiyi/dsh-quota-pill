/**
 * Offline check of the quota pill against the live account payload shape.
 *
 * The bundle is a browser lazy-CJS artifact, so this script evaluates it exactly
 * as the module loader would (register a factory, then call it) and drives it
 * through a small React hook runtime that honours dependency arrays, effect
 * cleanup, and batched re-renders, because the component's correctness lives in
 * which state survives which re-render. It then feeds the payload shapes the
 * DeepSeek Platform actually returned for a signed-in account.
 *
 * What this proves: bundle shape, injected services, Slot registration, Remote
 * metadata fields, envelope handling, wallet parsing and formatting, the
 * "no delta before a second reading" rule, and every failure state.
 *
 * What this does NOT prove: what the browser actually renders. The hook runtime
 * is a stub, so a page-level visual check is still required.
 *
 * Usage: node verify/verify-quota-pill.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const clientPath = path.resolve(here, '..', 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');

/** The revision the bundle stamps on itself, read from source so a version bump is not a test edit. */
const PLUGIN_VERSION = /const PLUGIN_VERSION = '([^']+)'/.exec(source)?.[1];
if (PLUGIN_VERSION === undefined) throw new Error('client.js declares no PLUGIN_VERSION');

/** The account's balance as a verified HTTP 200 response from the Platform carried it. */
const FIRST_PAYLOAD = {
  status: 'ready',
  value: [{ currency: 'CNY', balance: '8.7518069200000000', token_estimation: '0' }],
  bonusWallets: [{ currency: 'CNY', balance: '0', token_estimation: '0' }],
};
/** The same account after 0.42 CNY of work. */
const SECOND_PAYLOAD = {
  status: 'ready',
  value: [{ currency: 'CNY', balance: '8.3318069200000000', token_estimation: '0' }],
  bonusWallets: [{ currency: 'CNY', balance: '0', token_estimation: '0' }],
};

const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}`);
}

/** Compare an epoch millisecond value to an ISO instant, to the second. */
function checkInstant(label, actual, expectedIso) {
  const expected = Date.parse(expectedIso);
  const ok = Math.abs(actual - expected) < 1000;
  if (!ok) failures.push(`${label}: expected ${expectedIso}, got ${new Date(actual).toISOString()}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${new Date(actual).toISOString()}`);
}

/** Compare two numbers within a tolerance, for derived prices. */
function checkClose(label, actual, expected) {
  const ok = Math.abs(actual - expected) < 1e-9;
  if (!ok) failures.push(`${label}: expected ${expected}, got ${actual}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${actual}`);
}

/* ---------------- React hook runtime ---------------- */

const hookSlots = [];
let hookIndex = 0;
let latest = null;
let rerenderQueued = false;
const pendingEffects = [];

const depsEqual = (a, b) =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

const React = {
  createElement: (...args) => args,
  useMemo(fn, deps) {
    const index = hookIndex++;
    let slot = hookSlots[index];
    if (!slot) {
      slot = { deps, value: fn() };
      hookSlots[index] = slot;
    } else if (deps !== undefined && !depsEqual(deps, slot.deps)) {
      slot.deps = deps;
      slot.value = fn();
    }
    return slot.value;
  },
  useCallback(fn, deps) {
    const index = hookIndex++;
    let slot = hookSlots[index];
    if (!slot || (deps !== undefined && !depsEqual(deps, slot.deps))) {
      slot = { deps, value: fn };
      hookSlots[index] = slot;
    }
    return slot.value;
  },
  useRef(initial) {
    const index = hookIndex++;
    if (!hookSlots[index]) hookSlots[index] = { current: initial };
    return hookSlots[index];
  },
  useState(initial) {
    const index = hookIndex++;
    let slot = hookSlots[index];
    if (!slot) {
      slot = { value: typeof initial === 'function' ? initial() : initial };
      hookSlots[index] = slot;
    }
    const setter = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      // Deferred on purpose: React batches, and rendering inside a handler would
      // replace the tree that handler was read from.
      if (latest !== null) rerenderQueued = true;
    };
    return [slot.value, setter];
  },
  useEffect(fn, deps) {
    const index = hookIndex++;
    const slot = hookSlots[index];
    if (slot === undefined) {
      const created = { deps, cleanup: undefined };
      hookSlots[index] = created;
      pendingEffects.push({ slot: created, fn });
      return;
    }
    if (deps !== undefined && depsEqual(deps, slot.deps)) return;
    slot.deps = deps;
    if (typeof slot.cleanup === 'function') slot.cleanup();
    slot.cleanup = undefined;
    pendingEffects.push({ slot, fn });
  },
};

function commit(props) {
  hookIndex = 0;
  pendingEffects.length = 0;
  const tree = entry.component(props);
  latest = { tree, props };
  for (const { slot, fn } of pendingEffects) {
    const cleanup = fn();
    slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  }
  return tree;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

/** Let async work land, then apply any batched re-render, repeatedly. */
async function settle() {
  for (let pass = 0; pass < 6; pass += 1) {
    await flush();
    if (!rerenderQueued) return;
    rerenderQueued = false;
    commit(latest.props);
  }
  throw new Error('render did not settle');

}


/* ---------------- load the bundle as the loader does ---------------- */

let registered = null;
globalThis.window = { __ModuleLoader__: { load: (value) => (registered = value) } };
new Function(source)();

check('factory id', registered?.id, 'dsh-quota-pill');
const plugin = registered.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected import: ${name}`);
});
check('injected services', plugin.inject, ['slots', 'remote', 'remote.account', 'locale']);

/* ---------------- mount into the real Slot API ---------------- */

const slotCalls = [];
const balanceCalls = [];
let entry = null;
let payload = FIRST_PAYLOAD;
/** Swappable behaviour behind the account remote, so scenarios stay independent. */
let balanceImpl = (meta) => {
  void meta;
  return { ok: true, value: payload };
};

const ctx = {
  remote: {
    account: {
      getBalance: async (meta) => {
        balanceCalls.push(meta);
        // Routes through the live implementation so a scenario can replace it; the
        // real carrier always answers with its own envelope, and sending a bare
        // payload here would hide exactly the bug this harness must catch.
        return balanceImpl(meta);
      },
      getState: async () => ({
        ok: true,
        value: { status: 'credential-stored', links: { usageUrl: 'u', topUpUrl: 't' }, attempt: null },
      }),
    },
  },
  locale: { getSnapshot: () => ({ active: 'zh' }) },
  slots: {
    inject(name, cb) {
      slotCalls.push(name);
      cb();
    },
    register(options, component) {
      entry = { options, component };
      return () => {};
    },
  },
};
plugin.apply(ctx);

check('slot injected', slotCalls, ['conversation.composer.dock']);
check('entry id', entry.options.id, 'quota');
check('entry order', entry.options.order, 10);

/**
 * Walk a rendered element tree. Function components are invoked, because this
 * harness has no reconciler: `h(Row, props)` stays a plain call until someone
 * makes it one.
 */
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') return;
  if (Array.isArray(node)) {
    if (typeof node[0] === 'function') {
      walkTree(node[0](node[1] ?? {}), visit);
      return;
    }
    visit(node);
    for (const part of node) walkTree(part, visit);
    return;
  }
  if (typeof node === 'object' && 'children' in node) walkTree(node.children, visit);
}

/** Flatten every string in the rendered tree. */
function pillText(tree) {
  const out = [];
  walkTree(tree, (node) => {
    for (const part of node) {
      if (typeof part === 'string' || typeof part === 'number') out.push(String(part));
    }
  });
  return out.join(' | ');
}

/** Every rendered element whose class name contains `className`. */
function elementsWithClass(tree, className) {
  const found = [];
  walkTree(tree, (node) => {
    if (typeof node[0] === 'string' && typeof node[1]?.className === 'string' && node[1].className.includes(className)) {
      found.push(node[1]);
    }
  });
  return found;
}

/** The first rendered element matching `predicate`, for subtree-scoped assertions. */
function findFirst(tree, predicate) {
  let found = null;
  walkTree(tree, (node) => {
    if (found === null && typeof node[0] === 'string' && predicate(node)) found = node;
  });
  return found;
}

/**
 * The pill's two cells as "label value", read from its column structure, so this
 * also asserts their order: balance first, spend second.
 */
function pillCells(tree) {
  const out = [];
  let inPill = false;
  walkTree(tree, (node) => {
    if (typeof node[1]?.className === 'string' && node[1].className.includes('dqp_pill')) inPill = true;
    if (!inPill) return;
    if (typeof node[1]?.className === 'string' && node[1].className.includes('dqp_metric')) {
      const key = node.find((part) => Array.isArray(part) && part[1]?.className === 'dqp_key')?.[2];
      const value = node.find((part) => Array.isArray(part) && part[1]?.className === 'dqp_val')?.[2];
      if (typeof key === 'string' && typeof value === 'string') out.push(key + ' ' + value);
    }
  });
  return out;
}

/** Every grey footer note in the card, as text, in render order. */
function cardNotes(tree) {
  const out = [];
  walkTree(tree, (node) => {
    if (typeof node[1]?.className === 'string' && node[1].className.includes('dqp_note')) {
      // node[0] is the element type, so only later string children are copy.
      for (const part of node.slice(1)) if (typeof part === 'string' && part !== node[0]) out.push(part);
    }
  });
  return out;
}

const clickPill = () => elementsWithClass(latest.tree, 'dqp_pill')[0].onClick();
/**
 * Find the card's Refresh control by its rendered label, because two elements can
 * carry the action class and only the labelled one holds the handler.
 */
function clickRefresh() {
  let handler = null;
  walkTree(latest.tree, (node) => {
    if (node[2] === '\u5237\u65b0' && typeof node[1]?.onClick === 'function') handler = node[1].onClick;
  });
  if (handler === null) throw new Error('refresh control not found');
  handler();
}

/* ---------------- scenarios ---------------- */

const props = { sessionId: 'session-test' };
const first = commit(props);
check('mount render does not crash', Array.isArray(first), true);
check('mount phase', first[1]['data-quota-pill'], 'loading');

/* ---------------- peak / off-peak schedule and list prices ---------------- */

// Constructed boundaries in Beijing time, since the schedule is defined there and
// this machine's own zone must not decide the result.
const CN = 8 * 60;
const atBeijing = (iso, hour, minute = 0) => Date.parse(`${iso}T00:00:00Z`) + (hour * 60 + minute - CN) * 60_000;
const testApi = plugin.__test;
check('schedule helpers exported', typeof testApi?.isPeakAt, 'function');

// A normal Wednesday, across every boundary of the two peak windows.
const wed = '2026-10-14';
check('Wed 08:59 is off-peak', testApi.isPeakAt(atBeijing(wed, 8, 59)), false);
check('Wed 09:00 is peak', testApi.isPeakAt(atBeijing(wed, 9, 0)), true);
check('Wed 11:59 is peak', testApi.isPeakAt(atBeijing(wed, 11, 59)), true);
check('Wed 12:00 is off-peak', testApi.isPeakAt(atBeijing(wed, 12, 0)), false);
check('Wed 13:59 is off-peak', testApi.isPeakAt(atBeijing(wed, 13, 59)), false);
check('Wed 14:00 is peak', testApi.isPeakAt(atBeijing(wed, 14, 0)), true);
check('Wed 17:59 is peak', testApi.isPeakAt(atBeijing(wed, 17, 59)), true);
check('Wed 18:00 is off-peak', testApi.isPeakAt(atBeijing(wed, 18, 0)), false);
check('Wed 23:30 is off-peak', testApi.isPeakAt(atBeijing(wed, 23, 30)), false);

// Weekends are off-peak in full, including hours that are peak on a weekday.
check('Sat 10:00 is off-peak', testApi.isPeakAt(atBeijing('2026-10-17', 10, 0)), false);
check('Sun 15:00 is off-peak', testApi.isPeakAt(atBeijing('2026-10-18', 15, 0)), false);

// The boundary the badge reports, in the reader's own timezone.
checkInstant(
  'Wed 10:00 counts down to 12:00 Beijing',
  testApi.peakWindowBounds(atBeijing(wed, 10, 0)).until,
  '2026-10-14T04:00:00Z',
);
checkInstant(
  'Wed 20:00 counts down to Thursday 09:00 Beijing',
  testApi.peakWindowBounds(atBeijing(wed, 20, 0)).until,
  '2026-10-15T01:00:00Z',
);
checkInstant(
  'Saturday counts down to Monday 09:00 Beijing',
  testApi.peakWindowBounds(atBeijing('2026-10-17', 12, 0)).until,
  '2026-10-19T01:00:00Z',
);
checkInstant(
  'Friday evening counts down to Monday 09:00 Beijing',
  testApi.peakWindowBounds(atBeijing('2026-10-16', 22, 0)).until,
  '2026-10-19T01:00:00Z',
);
check('peak window reports its kind', testApi.peakWindowBounds(atBeijing(wed, 10, 0)).kind, 'peak');

// The offset is a parameter, so one instant classifies differently per timezone:
// 01:00Z is 09:00 Beijing, which is the first peak window, and 01:00 for a
// schedule priced in UTC, which is inside neither window.
check('01:00Z is peak under Beijing rules', testApi.isPeakAt(Date.parse('2026-10-14T01:00:00Z')), true);
check('01:00Z is off-peak under UTC rules', testApi.isPeakAt(Date.parse('2026-10-14T01:00:00Z'), 0), false);

/* ---------------- list prices ---------------- */

// Every rate keeps two decimals, so the three rows stay aligned whatever the magnitude.
check('rate formatting keeps two decimals on a cent rate', testApi.formatRate(0.02), '\u00a50.02');
check('rate formatting pads whole yuan', testApi.formatRate(2), '\u00a52.00');
check('rate formatting pads one decimal', testApi.formatRate(4.5), '\u00a54.50');
check('rate formatting pads a large rate', testApi.formatRate(27), '\u00a527.00');
check('rate formatting keeps a hundredth', testApi.formatRate(13.5), '\u00a513.50');

// The window countdown: hours with zero-padded minutes, minutes alone under an hour.
check('countdown pads minutes to two digits', testApi.formatCountdown(66 * 60_000), '1h06m');
check('countdown drops minutes when they are zero', testApi.formatCountdown(2 * 60 * 60_000), '2h');
check('countdown stays in minutes under an hour', testApi.formatCountdown(5 * 60_000), '5m');
check('countdown never goes negative', testApi.formatCountdown(-1), '0m');
check('countdown floors a partial minute', testApi.formatCountdown(90_000), '1m');
check('countdown handles a long weekend window', testApi.formatCountdown(62 * 60 * 60_000), '62h');
checkClose('off-peak flash output is half of peak', testApi.PRICE_TABLE['deepseek-flash'].output.offPeak * 2, testApi.PRICE_TABLE['deepseek-flash'].output.peak);
checkClose('off-peak pro cache-hit is half of peak', testApi.PRICE_TABLE['deepseek-v4-pro'].cacheHit.offPeak * 2, testApi.PRICE_TABLE['deepseek-v4-pro'].cacheHit.peak);
checkClose('off-peak pro cache-miss is half of peak', testApi.PRICE_TABLE['deepseek-v4-pro'].cacheMiss.offPeak * 2, testApi.PRICE_TABLE['deepseek-v4-pro'].cacheMiss.peak);
checkClose('off-peak pro output is half of peak', testApi.PRICE_TABLE['deepseek-v4-pro'].output.offPeak * 2, testApi.PRICE_TABLE['deepseek-v4-pro'].output.peak);
checkClose('off-peak flash cache-hit is half of peak', testApi.PRICE_TABLE['deepseek-flash'].cacheHit.offPeak * 2, testApi.PRICE_TABLE['deepseek-flash'].cacheHit.peak);
checkClose('off-peak flash cache-miss is half of peak', testApi.PRICE_TABLE['deepseek-flash'].cacheMiss.offPeak * 2, testApi.PRICE_TABLE['deepseek-flash'].cacheMiss.peak);


await settle();

// The pill carries the marker, and it always states exactly one of the two windows.
// Asserted on the pill subtree only: the open card names both windows in its copy,
// so a whole-tree search would match both markers.
{
  const pillNode = findFirst(latest.tree, (node) => node[1]?.className?.includes?.('dqp_pill'));
  const pillOnly = pillText(pillNode);
  check('pill marker present', pillOnly.includes('\u5cf0') || pillOnly.includes('\u8c37'), true);
  check('pill states exactly one period', pillOnly.includes('\u5cf0') !== pillOnly.includes('\u8c37'), true);
}
check('exactly one balance call on mount', balanceCalls.length, 1);
check('metadata version', balanceCalls[0].version, '0.2.0-rc.2');
check('metadata locale', balanceCalls[0].locale, 'zh');
check('metadata offset is numeric', Number.isFinite(balanceCalls[0].timezoneOffsetSeconds), true);
check('phase after the first read', latest.tree[1]['data-quota-pill'], 'ready');
check('shows the real balance', pillText(latest.tree).includes('\u00a58.75'), true);
// The pill is limited to the two figures: no revision stamp, no other copy.
check('pill carries no version stamp', pillText(latest.tree[1]).includes('v0.1'), false);
// The first sample is not evidence of spending, so the spend cell shows an em
// dash rather than a fabricated zero.
check('spend cell shows an em dash before any delta', pillCells(latest.tree), ['\u4f59\u989d \u00a58.75', '\u6d88\u8017 \u2014']);

// Open the card: it carries the per-wallet rows and the manual refresh control.
clickPill();
await settle();
check('card shows the wallet split', pillText(latest.tree).includes('\u5145\u503c\u94b1\u5305'), true);
// The card stays to the essentials: the active window and its three rates.
check('card quotes cache-hit pricing', pillText(latest.tree).includes('\u7f13\u5b58\u547d\u4e2d'), true);
check('card quotes cache-miss pricing', pillText(latest.tree).includes('\u7f13\u5b58\u672a\u547d\u4e2d'), true);
check('card quotes output pricing', pillText(latest.tree).includes('\u8f93\u51fa'), true);
check('card notes the price unit in small grey text', pillText(latest.tree).includes('\u5355\u4f4d\uff1a\u5143 / \u767e\u4e07 tokens'), true);
// The period cell counts the window down instead of naming the clock time it ends at.
check('card shows a window countdown', /(\d+h)?\d+m\b/.test(pillText(latest.tree)), true);
// Rates are all two-decimal, so no rate may render as a bare integer.
check('no rate renders without decimals', /¥\d+\s/.test(pillText(latest.tree).replace(/¥\d+\.\d{2}/g, '')), false);
// The version rides the action row now, and the prose the reader removed stays gone.
{
  const notes = cardNotes(latest.tree);
  check('grey footer omits the old account explanation', notes.some((line) => line.includes('\u4e0e\u8bbe\u7f6e')), false);
  check('card no longer explains the holiday rule', pillText(latest.tree).includes('\u672a\u8ba1\u5165'), false);
  check('card no longer names the pricing model', pillText(latest.tree).includes('\u4ef7\u683c\u4f9d\u636e'), false);
}
check('card still carries the version marker', pillText(latest.tree).includes('v' + PLUGIN_VERSION), true);

// A second read with no movement reports an explicit zero delta rather than
// holding the figure back.
clickRefresh();
await settle();
check('unchanged balance reports zero spend', pillCells(latest.tree), ['\u4f59\u989d \u00a58.75', '\u6d88\u8017 \u00a50.00']);

// A third read moves the balance: the baseline the first read recorded stands,
// so the delta is the whole session's usage.
payload = SECOND_PAYLOAD;
clickRefresh();
await settle();
check('phase after the second read', latest.tree[1]['data-quota-pill'], 'ready');
check('spend is the real delta', pillCells(latest.tree), ['\u4f59\u989d \u00a58.33', '\u6d88\u8017 \u00a50.42']);
check('balance updated to the new read', pillText(latest.tree).includes('\u00a58.33'), true);

// Signed out: the Platform answers null.
payload = null;
clickRefresh();
await settle();
check('signed-out phase', latest.tree[1]['data-quota-pill'], 'signed-out');
check('signed-out copy', pillText(latest.tree).includes('\u672a\u767b\u5f55\u8d26\u53f7'), true);

// A failed Remote call is an envelope-level failure, not a Platform verdict: the
// card must say so instead of hiding the reason behind a generic message.
balanceImpl = () => ({ ok: false, error: { code: 'gateway/input-invalid', message: 'bad client metadata' } });
clickRefresh();
await settle();
check('envelope failure phase', latest.tree[1]['data-quota-pill'], 'failed');
check('envelope failure reason surfaced', pillText(latest.tree).includes('gateway/input-invalid'), true);

// A transport failure after a confirmed balance keeps the last number and says why.
balanceImpl = () => ({ ok: true, value: FIRST_PAYLOAD });
clickRefresh();
await settle();
check('recovered phase', latest.tree[1]['data-quota-pill'], 'ready');
balanceImpl = () => {
  throw new Error('network down');
};
clickRefresh();
await settle();
check('failure phase', latest.tree[1]['data-quota-pill'], 'failed');
check('last known balance retained', pillText(latest.tree).includes('\u00a58.75'), true);
check('failure reason shown', pillText(latest.tree).includes('network down'), true);

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n` + failures.join('\n'));
  process.exit(1);
}
console.log('\nall checks passed');
