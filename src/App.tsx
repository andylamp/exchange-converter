import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  addCurrency,
  convertAmount,
  createDefaultState,
  effectiveRate,
  formatAmount,
  isValidAmount,
  isValidMarkupPercent,
  markupAmount,
  mergeQuotes,
  reconcileState,
  removeCurrency,
  setCustomRate,
} from './core';
import { fetchLatest, loadBundledLatest } from './api';
import { clearSavedState, readSavedState, writeSavedState } from './storage';
import type { LatestData, SavedState } from './types';
import { CurrencyPicker, RateEditor } from './components/Dialogs';
import { HistoryChart } from './components/HistoryChart';
import { Icon } from './components/Icons';

const DAY = 24 * 60 * 60 * 1000;
const readableDate = (date: string) =>
  new Date(date.length === 10 ? `${date}T12:00:00Z` : date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function App() {
  const [latest, setLatest] = useState<LatestData | null>(null);
  const [state, setState] = useState<SavedState | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ code: string; text: string } | null>(null);
  const [markupDraft, setMarkupDraft] = useState<string | null>(null);
  const stateRef = useRef<SavedState | null>(null);
  const refreshingRef = useRef(false);
  const shouldPersist = useRef(false);
  const hasPersistence = useRef(false);
  const refreshController = useRef<AbortController | null>(null);
  stateRef.current = state;

  const cancelRefresh = useCallback(() => {
    refreshController.current?.abort();
    refreshController.current = null;
    refreshingRef.current = false;
    setRefreshing(false);
  }, []);

  const updateState = useCallback((update: (previous: SavedState) => SavedState) => {
    hasPersistence.current = true;
    shouldPersist.current = true;
    setState((previous) => (previous ? update(previous) : previous));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingError('');
    loadBundledLatest(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const saved = readSavedState();
        hasPersistence.current = Boolean(saved.state);
        if (saved.warning) setWarning(saved.warning);
        const result = saved.state
          ? reconcileState(saved.state, data)
          : { state: createDefaultState(data), replacedCustom: [] };
        setLatest(data);
        setState(result.state);
        if (result.replacedCustom.length)
          setNotice(
            `Newer provider rates replaced your custom rates for ${result.replacedCustom.join(', ')}.`,
          );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setLoadingError(
            'The default exchange rates could not be loaded. Check your connection and try again.',
          );
      });
    return () => controller.abort();
  }, [bootAttempt]);

  useEffect(() => {
    if (!state || !shouldPersist.current) return;
    shouldPersist.current = false;
    if (!writeSavedState(state))
      setWarning(
        'Your browser could not save these preferences. You can keep converting in this session.',
      );
  }, [state]);

  const refreshRates = useCallback(async (manual = false) => {
    const current = stateRef.current;
    if (!current || refreshingRef.current) return;
    if (!manual && current.lastChecked && Date.now() - Date.parse(current.lastChecked) < DAY)
      return;
    refreshingRef.current = true;
    setRefreshing(true);
    const controller = new AbortController();
    refreshController.current = controller;
    if (manual) setNotice('');
    try {
      const incoming = await fetchLatest(current.selected, controller.signal);
      if (controller.signal.aborted) return;
      const checkedAt = new Date().toISOString();
      setState((previous) => {
        if (!previous) return previous;
        const complete = previous.selected.every((code) => code === 'EUR' || incoming[code]);
        const result = mergeQuotes(previous, incoming, complete ? checkedAt : undefined);
        if (manual) {
          hasPersistence.current = true;
          shouldPersist.current = true;
        } else if (hasPersistence.current) shouldPersist.current = true;
        const replaced = result.replacedCustom.length
          ? ` Newer provider rates replaced your custom rates for ${result.replacedCustom.join(', ')}.`
          : '';
        if (!complete) {
          setNotice(
            `Some rates could not be refreshed. Your existing rates are still available.${replaced}`,
          );
        } else if (manual || replaced) {
          setNotice(`Rates checked successfully. Daily rates may be unchanged.${replaced}`);
        } else {
          setNotice((previousNotice) =>
            previousNotice.startsWith('The rate provider is unavailable.') ||
            previousNotice.startsWith('Some rates could not be refreshed.')
              ? ''
              : previousNotice,
          );
        }
        return result.state;
      });
    } catch {
      if (!controller.signal.aborted)
        setNotice(
          'The rate provider is unavailable. Using saved or default rates. Try refreshing again later.',
        );
    } finally {
      if (refreshController.current === controller) {
        refreshController.current = null;
        refreshingRef.current = false;
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!latest) return;
    void refreshRates();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRates();
    };
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(onVisible, 60 * 60 * 1000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
      refreshController.current?.abort();
    };
  }, [latest, refreshRates]);

  const selectionKey = state?.selected.join(',');
  useEffect(() => {
    if (selectionKey) void refreshRates();
  }, [selectionKey, refreshRates]);

  function clearState() {
    if (!latest) return;
    cancelRefresh();
    clearSavedState();
    hasPersistence.current = false;
    shouldPersist.current = false;
    setState(createDefaultState(latest));
    setDraft(null);
    setMarkupDraft(null);
    setWarning('');
    setNotice(
      'Saved state cleared. Default currencies restored. Your next change will start a new saved session.',
    );
  }

  const ratesDates = state
    ? state.selected
        .filter((code) => code !== 'EUR')
        .map((code) => state.quotes[code]?.date)
        .filter((date): date is string => Boolean(date))
        .sort()
    : [];
  const oldestDate = ratesDates[0];
  const newestDate = ratesDates.at(-1);
  const rateDateLabel = oldestDate
    ? oldestDate === newestDate
      ? readableDate(oldestDate)
      : `${readableDate(oldestDate)} – ${readableDate(newestDate!)}`
    : 'Awaiting rates';
  const stale = Boolean(oldestDate && Date.now() - Date.parse(oldestDate) > 7 * DAY);
  const invalidMarkup = Boolean(
    state?.markup.enabled && markupDraft !== null && !isValidMarkupPercent(markupDraft),
  );

  return (
    <>
      <a class="skip-link" href="#converter">
        Skip to converter
      </a>
      <header class="site-header page-width">
        <a class="brand" href={import.meta.env.BASE_URL} aria-label="Exchange Converter home">
          <span class="brand-mark">
            <Icon name="arrow" width="24" height="24" />
          </span>
          <span>
            exchange<span class="brand-light"> / converter</span>
          </span>
        </a>
        <span class="header-note">
          <Icon name="shield" width="15" height="15" /> Saved in your browser
        </span>
      </header>
      <main class="page-width">
        <section class="hero" aria-labelledby="page-heading">
          <h1 id="page-heading">Currency converter</h1>
          <p>Enter an amount to convert it across your selected currencies.</p>
        </section>
        {!state || !latest ? (
          <section id="converter" class="boot-state" aria-live="polite">
            {loadingError ? (
              <>
                <h2>Unable to load rates</h2>
                <p>{loadingError}</p>
                <button class="button primary" onClick={() => setBootAttempt((value) => value + 1)}>
                  Retry loading
                </button>
              </>
            ) : (
              <>
                <span class="loading-line" />
                <p>Loading exchange rates…</p>
              </>
            )}
          </section>
        ) : (
          <>
            {warning && (
              <div class="notice warning" role="status">
                <span>{warning}</span>
                <button
                  class="icon-button"
                  aria-label="Dismiss browser storage message"
                  onClick={() => setWarning('')}
                >
                  <Icon name="close" width="17" height="17" />
                </button>
              </div>
            )}
            <section id="converter" class="converter-section" aria-labelledby="converter-heading">
              <div class="converter-toolbar">
                <div>
                  <h2 id="converter-heading">
                    Your currencies <span class="count-badge">{state.selected.length}</span>
                  </h2>
                </div>
                <div class="rate-controls">
                  <span class={`rate-status ${stale ? 'stale' : ''}`}>
                    <span class="status-dot" />
                    {stale ? 'Older rates · ' : 'Daily rates · '}
                    {rateDateLabel}
                  </span>
                  <button
                    class="button refresh-button"
                    onClick={() => void refreshRates(true)}
                    disabled={refreshing}
                  >
                    <Icon
                      name="refresh"
                      class={refreshing ? 'spinning' : ''}
                      width="16"
                      height="16"
                    />
                    {refreshing ? 'Refreshing…' : 'Refresh rates'}
                  </button>
                </div>
              </div>
              {notice && (
                <div class="notice" role="status">
                  <span>{notice}</span>
                  <button
                    class="icon-button"
                    aria-label="Dismiss rate message"
                    onClick={() => setNotice('')}
                  >
                    <Icon name="close" width="17" height="17" />
                  </button>
                </div>
              )}
              <div class={`markup-controls ${state.markup.enabled ? 'markup-enabled' : ''}`}>
                <div class="markup-description">
                  <label class="markup-toggle">
                    <input
                      type="checkbox"
                      checked={state.markup.enabled}
                      aria-label="Add markup"
                      aria-describedby="markup-help"
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        setMarkupDraft(null);
                        updateState((previous) => ({
                          ...previous,
                          markup: { ...previous.markup, enabled },
                        }));
                      }}
                    />
                    <span class="switch-track" aria-hidden="true" />
                    <span>Add markup</span>
                  </label>
                  <p id="markup-help">Add the same percentage to each amount.</p>
                </div>
                <label class="markup-percentage" for="markup-percentage">
                  <span>Markup percentage</span>
                  <span class="markup-input-wrap">
                    <input
                      id="markup-percentage"
                      aria-label="Markup percentage"
                      inputMode="decimal"
                      autoComplete="off"
                      spellcheck={false}
                      maxLength={10}
                      disabled={!state.markup.enabled}
                      value={markupDraft ?? state.markup.percent}
                      aria-invalid={invalidMarkup}
                      aria-describedby={invalidMarkup ? 'markup-error' : 'markup-help'}
                      onFocus={(event) => setMarkupDraft(event.currentTarget.value)}
                      onInput={(event) => {
                        const percent = event.currentTarget.value;
                        setMarkupDraft(percent);
                        if (isValidMarkupPercent(percent))
                          updateState((previous) => ({
                            ...previous,
                            markup: { ...previous.markup, percent },
                          }));
                      }}
                      onBlur={() => setMarkupDraft(null)}
                    />
                    <span aria-hidden="true">%</span>
                  </span>
                </label>
                {invalidMarkup && (
                  <p id="markup-error" class="markup-error">
                    Enter a percentage from 0 to 1,000. Using the last valid percentage.
                  </p>
                )}
              </div>
              <div class="currency-grid">
                {state.selected.map((code) => {
                  const currency = latest.currencies.find((item) => item.code === code);
                  const converted = convertAmount(state.amount, state.source, code, state);
                  const displayed =
                    draft?.code === code
                      ? draft.text
                      : code === state.source
                        ? state.amount
                        : converted === null
                          ? ''
                          : formatAmount(converted, code);
                  const markedUp =
                    state.markup.enabled && converted !== null
                      ? markupAmount(converted, state.markup.percent)
                      : null;
                  const rate = effectiveRate(state, code);
                  const custom = state.custom[code];
                  const invalidDraft =
                    draft?.code === code && draft.text !== '' && !isValidAmount(draft.text);
                  return (
                    <article
                      class={`currency-card ${state.source === code ? 'source-card' : ''}`}
                      key={code}
                    >
                      <div class="currency-card-heading">
                        <span class={`currency-emblem emblem-${code.toLowerCase()}`}>
                          {currency?.symbol || code.slice(0, 1)}
                        </span>
                        <div class="currency-identity">
                          <h3>{code}</h3>
                          <p>{currency?.name || code}</p>
                        </div>
                        <button
                          class="icon-button remove-currency"
                          disabled={state.selected.length <= 2}
                          aria-label={`Remove ${code}`}
                          title={
                            state.selected.length <= 2
                              ? 'Keep at least two currencies'
                              : `Remove ${code}`
                          }
                          onClick={() => {
                            cancelRefresh();
                            setDraft(null);
                            updateState((previous) => removeCurrency(previous, code));
                          }}
                        >
                          <Icon name="close" width="16" height="16" />
                        </button>
                      </div>
                      <div class="amount-heading">
                        <label for={`amount-${code}`}>
                          {state.markup.enabled
                            ? 'Original amount'
                            : state.source === code
                              ? 'Your amount'
                              : 'Converted amount'}
                        </label>
                      </div>
                      <div class="amount-input-wrap">
                        <input
                          class={`amount-input ${displayed.length > 12 ? 'compact-amount' : ''}`}
                          id={`amount-${code}`}
                          aria-label={`${code} amount`}
                          aria-invalid={Boolean(invalidDraft)}
                          aria-describedby={invalidDraft ? `amount-help-${code}` : undefined}
                          inputMode="decimal"
                          autoComplete="off"
                          spellcheck={false}
                          maxLength={32}
                          value={displayed}
                          placeholder="0.00"
                          onFocus={(event) => setDraft({ code, text: event.currentTarget.value })}
                          onInput={(event) => {
                            const text = event.currentTarget.value;
                            setDraft({ code, text });
                            if (isValidAmount(text))
                              updateState((previous) => ({
                                ...previous,
                                source: code,
                                amount: text,
                              }));
                          }}
                          onBlur={() => setDraft(null)}
                        />
                        <span class="amount-code">{code}</span>
                      </div>
                      <div class="amount-help" id={`amount-help-${code}`}>
                        {invalidDraft
                          ? 'Use a number with a decimal point. Other amounts retain the last valid value.'
                          : converted === null
                            ? 'No rate available. Refresh to try again.'
                            : '\u00a0'}
                      </div>
                      {state.markup.enabled && (
                        <div class="markup-result">
                          <span>
                            With{' '}
                            {Number(state.markup.percent).toLocaleString('en-GB', {
                              maximumFractionDigits: 9,
                            })}
                            % markup
                          </span>
                          <div>
                            <output aria-label={`${code} amount with markup`} aria-live="off">
                              {markedUp === null ? '—' : formatAmount(markedUp, code)}
                            </output>
                            <span>{code}</span>
                          </div>
                        </div>
                      )}
                      <div class="currency-card-footer">
                        {code === 'EUR' ? (
                          <span class="base-rate-label">1 EUR = 1 EUR</span>
                        ) : (
                          <button
                            class="rate-edit-button"
                            aria-label={`Edit ${code} exchange rate`}
                            onClick={(event) => {
                              event.currentTarget.focus();
                              setEditingRate(code);
                            }}
                          >
                            <span>
                              1 EUR ={' '}
                              {rate
                                ? Number(rate).toLocaleString('en-GB', {
                                    maximumSignificantDigits: 7,
                                  })
                                : '—'}{' '}
                              {code}
                            </span>
                            <Icon name="edit" width="13" height="13" />
                          </button>
                        )}
                        {custom && <span class="custom-badge">Custom</span>}
                      </div>
                      <span class="quote-date">
                        {custom
                          ? `Your rate · ${readableDate(custom.editedAt)}`
                          : state.quotes[code]
                            ? `Observed ${readableDate(state.quotes[code].date)}`
                            : code === 'EUR'
                              ? 'All quotes are relative to EUR'
                              : 'Awaiting a provider quote'}
                      </span>
                    </article>
                  );
                })}
              </div>
              <div class="converter-bottom">
                <button
                  class="button add-currency"
                  onClick={(event) => {
                    event.currentTarget.focus();
                    setPickerOpen(true);
                  }}
                  disabled={state.selected.length >= 12}
                >
                  <Icon name="plus" width="17" height="17" />
                  {state.selected.length >= 12 ? '12 currencies selected' : 'Add currency'}
                  <span>{state.selected.length}/12</span>
                </button>
              </div>
            </section>
            <HistoryChart
              state={state}
              currencies={latest.currencies}
              onChange={(chart) => updateState((previous) => ({ ...previous, chart }))}
            />
            <section class="good-to-know" aria-label="About these rates">
              <div class="info-icon">
                <Icon name="globe" width="22" height="22" />
              </div>
              <div>
                <h2>About the exchange rates</h2>
                <p>
                  Rates from{' '}
                  <a href="https://frankfurter.dev/" target="_blank" rel="noreferrer">
                    Frankfurter
                  </a>{' '}
                  are reference rates, updated on business days. Your bank or payment provider may
                  use a different rate and add fees. Set a custom rate using the pencil on any
                  currency.
                </p>
              </div>
            </section>
            {pickerOpen && (
              <CurrencyPicker
                currencies={latest.currencies}
                selected={state.selected}
                onClose={() => setPickerOpen(false)}
                onAdd={(code) => {
                  cancelRefresh();
                  updateState((previous) => addCurrency(previous, code, latest));
                  setPickerOpen(false);
                }}
              />
            )}
            {editingRate && (
              <RateEditor
                code={editingRate}
                initialRate={effectiveRate(state, editingRate) || ''}
                providerRate={state.quotes[editingRate]?.rate}
                isCustom={Boolean(state.custom[editingRate])}
                onClose={() => setEditingRate(null)}
                onSave={(rate) => {
                  const code = editingRate;
                  updateState((previous) => setCustomRate(previous, code, rate));
                  setEditingRate(null);
                  setNotice(
                    `Your custom ${code} rate is saved. A provider observation dated after today (UTC) will replace it.`,
                  );
                }}
                onReset={() => {
                  const code = editingRate;
                  updateState((previous) => {
                    const custom = { ...previous.custom };
                    delete custom[code];
                    return { ...previous, custom };
                  });
                  setEditingRate(null);
                  setNotice(`${code} now uses its provider rate.`);
                }}
              />
            )}
          </>
        )}
      </main>
      <footer class="site-footer page-width">
        <div>
          <a class="footer-brand" href={import.meta.env.BASE_URL}>
            exchange / converter
          </a>
        </div>
        <div class="footer-links">
          {state && (
            <button class="text-button" onClick={clearState}>
              Clear saved state
            </button>
          )}
          <a href="https://github.com/andylamp/exchange-converter" target="_blank" rel="noreferrer">
            View on GitHub <Icon name="external" width="13" height="13" />
          </a>
          <a href="https://frankfurter.dev/license/" target="_blank" rel="noreferrer">
            Data sources <Icon name="external" width="13" height="13" />
          </a>
        </div>
        <p class="privacy-note">
          No account. No analytics. Preferences and saved rates use only browser cookies, which
          accompany matching requests to this static site. Amounts and custom rates are never sent
          to the rate provider.
        </p>
      </footer>
    </>
  );
}
