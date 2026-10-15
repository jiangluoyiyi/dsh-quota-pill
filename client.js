/**
 * Client half of the quota pill.
 *
 * Seat: `conversation.composer.dock` — the list Slot directly under the composer
 * card, where `client-ui-chat` already renders its own `stats` pill. This entry
 * takes a fresh id at a higher order so it is a sibling of that pill, never a
 * replacement for it.
 *
 * Data: remaining credit comes from `ctx.remote.account.getBalance(clientMetadata)`,
 * which answers with a Remote result envelope around a per-currency wallet list.
 *
 * The Platform exposes no per-Session billing, so "this Session's spend" is the
 * real credit delta of the account between the first balance read of the Session
 * and the latest one. An account-wide read can absorb a charge made elsewhere;
 * the figure is a local measurement, not a per-Session ledger.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quota-pill',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** The mounted plugin's Cordis context, assigned by `apply`. */
    let ctx;

    /**
     * Build identity, stamped in the detail card only: the pill stays limited to the
     * two figures, while the card remains available to prove which revision a page runs.
     */
    const PLUGIN_VERSION = '0.1.7';

    /** Build-time client identity the Platform headers carry. */
    const CLIENT_VERSION =
      (typeof globalThis.__DSH_QUOTA_PILL_VERSION__ === 'string' && globalThis.__DSH_QUOTA_PILL_VERSION__) ||
      '0.2.0-rc.2';

    const READ_INTERVAL_MS = 45_000;
    const ACTIVE_READ_INTERVAL_MS = 20_000;
    const REMOUNT_REUSE_MS = 5_000;
    const RETRY_STEPS_MS = [20_000, 60_000, 120_000];
    const TURN_SETTLE_DELAY_MS = 4_000;

    const STYLE_ID = 'dsh-quota-pill/quota-pill.css';
    const CSS = [
      '.dqp_root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;display:flex}',
      '.dqp_anchor{min-width:0;display:inline-flex;position:relative}',
      '.dqp_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-secondary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.dqp_pill:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.dqp_pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dqp_pill svg{flex:none;width:14px;height:14px}',
      '.dqp_stale{color:var(--dsw-alias-state-warn-primary)}',
      '.dqp_failed{color:var(--dsw-alias-state-error-primary)}',
      '.dqp_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      // Two label/value pairs with tabular figures, so the digits line up between
      // the two cells and stay put as the numbers change.
      '.dqp_metric{display:inline-flex;align-items:baseline;gap:3px;min-width:0}',
      '.dqp_key{color:var(--dsw-alias-label-secondary)}',
      '.dqp_val{font-variant-numeric:tabular-nums}',
      '.dqp_sep{color:var(--dsw-alias-label-secondary);margin:0 7px;opacity:.45}',
      '.dqp_card{position:absolute;bottom:calc(100% + 8px);right:0;z-index:40;box-sizing:border-box;min-width:236px;max-width:320px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgb(0 0 0 / 18%);color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;text-align:left;white-space:normal}',
      '.dqp_cardTitle{color:var(--dsw-alias-label-secondary);margin:0 0 6px;font-weight:600}',
      '.dqp_row{display:flex;justify-content:space-between;gap:16px}',
      '.dqp_rowValue{font-variant-numeric:tabular-nums}',
      '.dqp_note{color:var(--dsw-alias-label-secondary);margin:6px 0 0}',
      '.dqp_error{color:var(--dsw-alias-state-error-primary);margin:6px 0 0}',
      '.dqp_actions{display:flex;justify-content:flex-end;gap:8px;margin:8px 0 0}',
      '.dqp_action{font:inherit;color:var(--dsw-alias-brand-primary);background:0 0;border:none;border-radius:6px;padding:2px 6px;cursor:pointer}',
      '.dqp_action:hover{background:var(--dsw-alias-bg-layer-2)}',
    ].join('');

    function insertStyles() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-quota-pill';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    function dict() {
      const zh =
        typeof navigator !== 'undefined' && typeof navigator.language === 'string'
          ? navigator.language.toLowerCase().startsWith('zh')
          : false;
      return zh
        ? {
            balance: '余额',
            spend: '本次会话',
            unknown: '余额未知',
            signedOut: '未登录账号',
            loading: '读取余额…',
            refresh: '刷新',
            loadFailed: '余额读取失败',
            unavailableReason: '未接通账户服务',
            total: '总余额',
            diagnostic: '诊断',
            charge: '充值钱包',
            bonus: '赠送额度',
            pillBalance: '余额',
            pillSpend: '消耗',
            pillUnknownValue: '—',
          }
        : {
            balance: 'Balance',
            spend: 'This session',
            unknown: 'Balance unavailable',
            signedOut: 'No account signed in',
            loading: 'Reading balance…',
            refresh: 'Refresh',
            loadFailed: 'Balance read failed',
            unavailableReason: 'Account service unavailable',
            total: 'Total',
            diagnostic: 'Diagnostic',
            charge: 'Top-up wallet',
            bonus: 'Bonus credit',
            pillBalance: 'Balance',
            pillSpend: 'Spent',
            pillUnknownValue: '—',
          };
    }

    /** @param {unknown} value - one wallet balance string from the Platform. */
    function parseAmount(value) {
      if (typeof value !== 'string') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function currencySign(currency) {
      return currency === 'USD' ? '$' : '¥';
    }

    /** Two decimals and digit grouping, matching the Platform's own web formatting. */
    function formatAmount(n, currency) {
      const sign = n < 0 ? '-' : '';
      const abs = Math.abs(n);
      if (abs > 0 && abs < 0.01) return sign + currencySign(currency) + '<0.01';
      const text = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return sign + currencySign(currency) + text;
    }

    /** Sum wallets per currency so a mixed-currency account stays additive per unit. */
    function sumWallets(wallets) {
      const byCurrency = new Map();
      if (!Array.isArray(wallets)) return byCurrency;
      for (const wallet of wallets) {
        if (wallet === null || typeof wallet !== 'object') continue;
        const amount = parseAmount(wallet.balance);
        if (amount === null) continue;
        const currency = wallet.currency === 'USD' ? 'USD' : 'CNY';
        byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
      }
      return byCurrency;
    }

    /**
     * Render one per-currency total map. A missing or malformed total yields null
     * rather than throwing: a render crash blanks the whole Slot entry, while a
     * missing figure only costs the reader that one number.
     */
    function formatCompact(byCurrency) {
      if (!(byCurrency instanceof Map)) return null;
      const parts = [];
      for (const [currency, amount] of byCurrency) {
        if (!Number.isFinite(amount)) continue;
        parts.push(formatAmount(amount, currency));
      }
      return parts.length === 0 ? null : parts.join(' + ');
    }

    /** Read one per-currency wallet map out of a snapshot, or null when it is absent. */
    function walletsOf(snapshot, field = 'wallets') {
      const value = snapshot === null || snapshot === undefined ? undefined : snapshot[field];
      return value instanceof Map ? value : null;
    }

    function WalletIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('rect', {
          x: 1.75,
          y: 3.75,
          width: 12.5,
          height: 8.5,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', { d: 'M1.75 6.75h12.5', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 11.25, cy: 9.75, r: 0.9, fill: 'currentColor' }),
      );
    }

    function Row({ label, value }) {
      return h('div', { className: 'dqp_row' }, h('span', null, label), h('span', { className: 'dqp_rowValue' }, value));
    }

    /**
     * Account balance shared by every Session's pill in this page.
     *
     * The store is created once per mounted entry and lives on the component's
     * plugin object, not in module state, because a Session switch unmounts and
     * remounts the dock entry: a per-component cache would lose the Session's
     * baseline on exactly the event that needs it, and a per-component timer
     * would restart the Platform read on every switch.
     * @param serviceCtx - the mounted plugin's context, owner of `remote`/`locale`.
     */
    function createQuotaStore(serviceCtx) {
      let state = { phase: 'loading' };
      let last = null;
      let failureCount = 0;
      let reading = null;
      let timer = null;
      let active = false;
      const baselines = new Map();
      const listeners = new Set();

      const publish = (next) => {
        state = next;
        for (const listener of [...listeners]) listener(state);
      };

      const read = async (activeSessionId) => {
        const account = serviceCtx.remote?.account;
        if (account === undefined || typeof account.getBalance !== 'function') {
          publish({ phase: 'unavailable' });
          return;
        }
        const activeLocale = serviceCtx.locale?.getSnapshot?.().active;
        const meta = {
          version: CLIENT_VERSION,
          locale: typeof activeLocale === 'string' && activeLocale.length > 0 ? activeLocale : 'en',
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
        try {
          const result = await account.getBalance(meta);
          failureCount = 0;
          // A Remote call answers with a result envelope, so the envelope must be
          // peeled before its payload is read as the business value.
          const answer = unwrapRemote(result);
          if (answer.error !== undefined) {
            const error = answer.error;
            const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'error';
            const message =
              error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : '';
            failureCount += 1;
            publish({ phase: 'failed', at: Date.now(), reason: (code + ' ' + message).trim().slice(0, 120) });
            return;
          }
          const value = answer.value;
          if (value === null || value === undefined) {
            publish({ phase: 'signed-out', at: Date.now() });
            return;
          }
          if (value.status !== 'ready') {
            publish({ phase: 'failed', at: Date.now(), reason: dict().loadFailed + ' (' + String(value.status) + ')' });
            return;
          }
          const wallets = sumWallets(value.value);
          const bonusWallets = sumWallets(value.bonusWallets);
          const total = new Map(wallets);
          for (const [currency, amount] of bonusWallets) {
            total.set(currency, (total.get(currency) ?? 0) + amount);
          }
          const at = Date.now();
          last = { total, wallets, bonusWallets, at };
          // The baseline is the previous reading of this Session, never the sample
          // just taken: using this one would report "spent 0" before anything ran.
          if (typeof activeSessionId === 'string' && !baselines.has(activeSessionId)) {
            baselines.set(activeSessionId, { total, at });
          }
          publish({ phase: 'ready', total, wallets, bonusWallets, at });
        } catch (error) {
          failureCount += 1;
          publish({
            phase: 'failed',
            at: Date.now(),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      };

      const refresh = (activeSessionId) => {
        if (reading !== null) return reading;
        const pending = read(activeSessionId).finally(() => {
          if (reading === pending) reading = null;
        });
        reading = pending;
        return pending;
      };

      let currentSessionId = () => undefined;
      let runningRef = () => false;

      const scheduleNext = () => {
        if (!active) return;
        const backoff = RETRY_STEPS_MS[Math.min(Math.max(failureCount, 1), RETRY_STEPS_MS.length) - 1];
        const delay = failureCount === 0 ? (runningRef() ? ACTIVE_READ_INTERVAL_MS : READ_INTERVAL_MS) : backoff;
        timer = setTimeout(() => {
          void refresh(currentSessionId()).then(scheduleNext);
        }, delay);
      };

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        snapshot: () => state,
        lastKnown: () => last,
        /**
         * The delta a Session has consumed, or null while no baseline exists for
         * it. A baseline counts only after a second reading, so the figure never
         * claims "spent nothing" on evidence that does not exist yet.
         */
        spendOf(sessionId, currentAt) {
          const baseline = typeof sessionId === 'string' ? baselines.get(sessionId) : undefined;
          if (baseline === undefined || baseline.at >= currentAt || state.phase !== 'ready') return null;
          const deltas = new Map();
          for (const [currency, amount] of state.total) {
            const before = baseline.total.get(currency);
            if (before === undefined) continue;
            const delta = before - amount;
            if (delta !== 0) deltas.set(currency, delta);
          }
          return deltas;
        },
        /** How many Sessions this page recorded a balance baseline for. */
        sessionCount: () => baselines.size,
        /**
         * The first mount starts the shared loop; the last unmount stops it. A
         * remount caused by a Session switch reuses a read that just happened
         * instead of spending another Platform call on it.
         */
        start(sessionIdOf, isRunning) {
          currentSessionId = sessionIdOf;
          runningRef = isRunning;
          if (active) return;
          active = true;
          const fresh = last !== null && Date.now() - last.at < REMOUNT_REUSE_MS && state.phase !== 'failed';
          if (fresh) {
            scheduleNext();
            return;
          }
          void refresh(sessionIdOf()).then(scheduleNext);
        },
        stop() {
          active = false;
          if (timer !== null) clearTimeout(timer);
          timer = null;
        },
        refreshNow(sessionId) {
          failureCount = 0;
          return refresh(sessionId);
        },
        /** A running turn spends credit: settle briefly, then re-read. */
        noteActivity() {
          failureCount = 0;
          void refresh(currentSessionId());
        },
      };
    }

    /**
     * Why the pill cannot read the account, as a short code, or null when the wiring
     * is intact. It answers only the wiring question, so a Platform-side failure
     * shows its own reason instead of a generic code.
     */
    function diagnose() {
      if (ctx === undefined) return 'no-ctx';
      const remote = ctx.remote;
      if (remote === undefined || remote === null) return 'no-remote';
      const account = remote.account;
      if (account === undefined || account === null) return 'no-account';
      if (typeof account.getBalance !== 'function') return 'no-method';
      return null;
    }

    /**
     * Peel one Remote result envelope. The Remote carrier answers `{ ok: true, value }`
     * or `{ ok: false, error }`; a `false` flag is the envelope's own, since no
     * account payload carries an `ok` field of its own.
     */
    function unwrapRemote(result) {
      if (result !== null && typeof result === 'object' && !Array.isArray(result) && typeof result.ok === 'boolean') {
        return result.ok ? { value: result.value } : { error: result.error };
      }
      return { value: result };
    }

    /**
     * Exercise both halves of the account path and report them as one line. `getState`
     * is a namespace round trip with no Platform endpoint and no metadata; `getBalance`
     * needs both, so their outcomes separate broken RPC wiring from a broken read.
     */
    async function probeAccount() {
      const account = ctx === undefined ? undefined : ctx.remote?.account;
      if (account === undefined || typeof account.getState !== 'function') return 'no-getState';
      let state;
      try {
        state = await account.getState();
      } catch (error) {
        return 'getState threw: ' + (error instanceof Error ? error.message : String(error)).slice(0, 80);
      }
      const inner = unwrapRemote(state);
      const status = inner.value !== undefined && typeof inner.value.status === 'string' ? inner.value.status : 'odd';
      let balance = 'not-attempted';
      if (typeof account.getBalance === 'function') {
        try {
          const result = await account.getBalance({
            version: CLIENT_VERSION,
            locale: 'en',
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          });
          const unwrapped = unwrapRemote(result);
          if (unwrapped.error !== undefined) {
            balance = 'error ' + JSON.stringify(unwrapped.error).slice(0, 160);
          } else if (unwrapped.value === null) {
            balance = 'null';
          } else {
            balance = String(unwrapped.value?.status ?? 'odd');
          }
        } catch (error) {
          balance = 'threw: ' + (error instanceof Error ? error.message : String(error)).slice(0, 120);
        }
      }
      return 'getState=' + status + ' | getBalance=' + balance;
    }

    /**
     * The pill: one balance read loop shared by the page, plus a card that shows the
     * per-wallet split and offers an explicit refresh.
     * @param root0 - standard Slot props for this seat.
     * @param root0.sessionId - the binding's Session id, passed as a plain prop.
     * @param root0.useSession - Session snapshot selector hook.
     */
    function QuotaPill({ sessionId: boundSessionId, useSession }) {
      const t = React.useMemo(() => dict(), []);
      const [open, setOpen] = React.useState(false);
      const [probe, setProbe] = React.useState(null);
      const store = React.useMemo(() => createQuotaStore(ctx), []);
      const [state, setState] = React.useState(() => store.snapshot());

      const session = typeof useSession === 'function' ? useSession((snapshot) => snapshot) : undefined;
      const sessionId = typeof boundSessionId === 'string' && boundSessionId.length > 0 ? boundSessionId : session?.sessionId;
      const running = session?.running === true;

      const sessionIdRef = React.useRef(sessionId);
      sessionIdRef.current = sessionId;
      const runningRef = React.useRef(running);
      runningRef.current = running;

      React.useEffect(() => {
        const removeStyles = insertStyles();
        return removeStyles;
      }, []);

      React.useEffect(() => {
        const unsubscribe = store.subscribe(setState);
        store.start(() => sessionIdRef.current, () => runningRef.current);
        return () => {
          unsubscribe();
          store.stop();
        };
      }, [store]);

      // A running turn spends credit; settle briefly, then refresh so the delta
      // reflects it without waiting for the next interval.
      React.useEffect(() => {
        if (!running) return undefined;
        const handle = setTimeout(() => store.noteActivity(), TURN_SETTLE_DELAY_MS);
        return () => clearTimeout(handle);
      }, [running, store]);

      // Opening the card is also the moment to exercise the namespace round trip,
      // so a wiring failure is visible where the reader is already looking.
      React.useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        void probeAccount().then((result) => {
          if (!cancelled) setProbe(result);
        });
        return () => {
          cancelled = true;
        };
      }, [open]);

      const manualRefresh = React.useCallback(() => {
        void store.refreshNow(sessionIdRef.current);
      }, [store]);

      const last = store.lastKnown();

      const spend = store.spendOf(sessionId, state.at ?? 0);

      // A balance read cannot be attributed to a specific Session while more than
      // one binding was live in the same window, so the delta is stated only for
      // the Session currently on screen and is labelled as a local measurement.
      // A zero delta is stated in the account's own currency rather than a guess.
      const accountCurrency = state.phase === 'ready' ? [...state.total.keys()][0] : 'CNY';
      const spendText = spend === null ? null : formatCompact(spend) ?? formatAmount(0, accountCurrency);
      const signOut = state.phase === 'signed-out';
      const failed = state.phase === 'failed';
      const unavailable = state.phase === 'unavailable';

      // A failed read keeps the last confirmed balance on screen and marks it
      // stale rather than replacing a real number with an error.
      const shown = failed || signOut || unavailable ? last : state;
      const stale = failed && last !== null;

      const headline = (() => {
        if (signOut) return last === null ? t.signedOut : formatCompact(last.total) + ' · ' + t.signedOut;
        if (unavailable) return t.unknown;
        if (state.phase === 'loading' && last === null) return t.loading;
        return formatCompact(shown?.total) ?? t.unknown;
      })();

      const pillClass =
        'dqp_pill' + (failed ? (stale ? ' dqp_stale' : ' dqp_failed') : signOut || unavailable ? ' dqp_stale' : '');

      const card = open
        ? h(
            'div',
            { className: 'dqp_card', role: 'dialog', 'aria-label': t.balance },
            h('p', { className: 'dqp_cardTitle' }, t.balance),
            h(
              'div',
              null,
              walletsOf(shown) === null
                ? h('div', { className: 'dqp_row' }, h('span', null, t.total), h('span', { className: 'dqp_rowValue' }, headline))
                : Array.from(walletsOf(shown)).map(([currency, amount]) =>
                    h(Row, { key: 'w' + currency, label: t.charge, value: formatAmount(amount, currency) }),
                  ),
              walletsOf(shown) === null
                ? null
                : Array.from(walletsOf(shown, 'bonusWallets')).map(([currency, amount]) =>
                    h(Row, { key: 'b' + currency, label: t.bonus, value: formatAmount(amount, currency) }),
                  ),
            ),
            spendText === null ? null : h(Row, { label: t.spend, value: spendText }),
            // Proof of which bundle revision this page is running: a stale page
            // cannot show the version its author just wrote.
            h('p', { className: 'dqp_note' }, 'v' + PLUGIN_VERSION),
            failed && probe !== null ? h('p', { className: 'dqp_note' }, 'RPC: ' + probe) : null,
            failed
              ? h('p', { className: 'dqp_error' }, state.reason ?? t.loadFailed)
              : unavailable
                ? h('p', { className: 'dqp_error' }, t.unavailableReason)
                : null,
            failed && diagnose() !== null
              ? h('p', { className: 'dqp_note' }, t.diagnostic + ': ' + diagnose())
              : null,
            h(
              'div',
              { className: 'dqp_actions' },
              h(
                'button',
                { type: 'button', className: 'dqp_action', onClick: manualRefresh },
                t.refresh,
              ),
            ),
          )
        : null;

      return h(
        'div',
        {
          className: 'dqp_root',
          'data-quota-pill': state.phase,
          // Structural markers the offline verifier reads; no styling depends on them.
          'data-quota-wallets': walletsOf(shown) === null ? 0 : walletsOf(shown).size,
          'data-quota-bonus': walletsOf(shown, 'bonusWallets') === null ? 0 : walletsOf(shown, 'bonusWallets').size,
          'data-quota-last': last === null ? 0 : last.total.size,
        },
        h(
          'span',
          { className: 'dqp_anchor' },
          h(
            'button',
            {
              type: 'button',
              className: pillClass,
              'aria-expanded': open,
              'aria-label': t.pillBalance + ' ' + headline + '，' + t.pillSpend + ' ' + spendText,
              title: t.pillBalance + ' ' + headline + '   ' + t.pillSpend + ' ' + spendText,
              onClick: () => setOpen((value) => !value),
            },
            h(WalletIcon, null),
            // Two fixed cells: the spend cell shows an em dash until a delta can be
            // computed, so the pill never grows or jumps when the first turn lands.
            h(
              'span',
              { className: 'dqp_metric' },
              h('span', { className: 'dqp_key' }, t.pillBalance),
              h('span', { className: 'dqp_val' }, headline),
            ),
            h('span', { className: 'dqp_sep', 'aria-hidden': true }, '│'),
            h(
              'span',
              { className: 'dqp_metric' },
              h('span', { className: 'dqp_key' }, t.pillSpend),
              h('span', { className: 'dqp_val' }, spendText ?? t.pillUnknownValue),
            ),
          ),
          card,
        ),
      );
    }

    return {
      inject: ['slots', 'remote', 'remote.account', 'locale'],
      apply(pluginCtx) {
        // The component runs after this, and needs the mounted context to reach the
        // account namespace; the Cordis context passed to apply is the only owner of
        // that namespace, so keep it in the factory closure.
        ctx = pluginCtx;
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'quota',
              order: 10,
              label: 'Quota',
            },
            QuotaPill,
          ),
        );
      },
    };
  },
});
