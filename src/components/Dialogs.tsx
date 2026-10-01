import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Currency } from '../types';
import { Icon } from './Icons';

function Modal({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: ComponentChildren;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    ref.current?.showModal();
    ref.current?.querySelector('input')?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      ref.current?.close();
      document.body.style.overflow = previous;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-description"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <button class="icon-button dialog-close" aria-label="Close dialog" onClick={onClose}>
        <Icon name="close" />
      </button>
      <h2 id="dialog-title">{title}</h2>
      <p class="muted" id="dialog-description">
        {description}
      </p>
      {children}
    </dialog>
  );
}

export function CurrencyPicker({
  currencies,
  selected,
  onAdd,
  onClose,
}: {
  currencies: Currency[];
  selected: string[];
  onAdd: (code: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const matches = currencies.filter((currency) =>
    `${currency.code} ${currency.name}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <Modal
      title="Add a currency"
      description={`Search by name or code. ${selected.length} of 12 selected.`}
      onClose={onClose}
    >
      <label class="sr-only" for="currency-search">
        Search currencies
      </label>
      <input
        class="search-input"
        id="currency-search"
        type="search"
        placeholder="Search name or code…"
        value={search}
        onInput={(event) => setSearch(event.currentTarget.value)}
        autoComplete="off"
      />
      <div class="currency-options">
        {matches.map((currency) => {
          const isSelected = selected.includes(currency.code);
          return (
            <button
              key={currency.code}
              class="currency-option"
              disabled={isSelected || selected.length >= 12}
              onClick={() => onAdd(currency.code)}
            >
              <span class={`currency-emblem emblem-${currency.code.toLowerCase()}`}>
                {currency.symbol}
              </span>
              <span class="currency-option-name">
                <strong>{currency.code}</strong>
                <span>{currency.name}</span>
              </span>
              <Icon name={isSelected ? 'check' : 'plus'} />
              {isSelected && <span class="sr-only">Already selected</span>}
            </button>
          );
        })}
        {matches.length === 0 && (
          <p class="empty-search">No currencies match “{search}”. Try a currency code.</p>
        )}
      </div>
    </Modal>
  );
}

export function RateEditor({
  code,
  initialRate,
  providerRate,
  isCustom,
  onSave,
  onReset,
  onClose,
}: {
  code: string;
  initialRate: string;
  providerRate?: string;
  isCustom: boolean;
  onSave: (rate: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [rate, setRate] = useState(initialRate);
  const [error, setError] = useState('');
  return (
    <Modal
      title={`Your ${code} exchange rate`}
      description="Set a custom rate for your calculations. Historical charts show provider rates."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rate.trim()) ||
            !Number.isFinite(Number(rate)) ||
            Number(rate) <= 0 ||
            rate.length > 32
          ) {
            setError('Enter a positive rate, using a decimal point if needed.');
            return;
          }
          try {
            onSave(rate.trim());
          } catch {
            setError('This rate cannot be saved. Enter a positive number.');
          }
        }}
      >
        <label class="field-label" for="custom-rate">
          1 EUR =
        </label>
        <div class="rate-input-wrap">
          <input
            id="custom-rate"
            class="search-input"
            inputMode="decimal"
            value={rate}
            onInput={(event) => {
              setRate(event.currentTarget.value);
              setError('');
            }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'rate-error' : 'rate-policy'}
          />
          <span>{code}</span>
        </div>
        {error && (
          <p id="rate-error" class="field-error" role="alert">
            {error}
          </p>
        )}
        <p class="small muted" id="rate-policy">
          Your rate takes priority today (UTC). A provider rate dated after today replaces it
          automatically.
        </p>
        {providerRate && (
          <p class="provider-note">
            Provider rate:{' '}
            <strong>
              {providerRate} {code}
            </strong>{' '}
            per EUR
          </p>
        )}
        <div class="dialog-actions">
          <button class="button secondary" type="button" disabled={!isCustom} onClick={onReset}>
            Reset to provider
          </button>
          <button class="button primary" type="submit">
            Save rate
          </button>
        </div>
      </form>
    </Modal>
  );
}
