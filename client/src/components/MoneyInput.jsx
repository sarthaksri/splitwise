import { useEffect, useRef, useState } from 'react';
import { fromCents, toCents } from '@shared/money.js';

// Two decimals, so a prefilled ₹349.80 reads as "349.80" rather than "349.8".
const asText = (cents) =>
  cents == null || cents === 0 ? '' : fromCents(cents).toFixed(2);

/**
 * A money field that reports integer minor units.
 *
 * It holds its own text so half-typed values like "12." survive a re-render.
 * The tricky part is knowing when to overwrite that text from the outside: a
 * prefilled amount must appear, but a parent echoing back the value you are
 * mid-way through typing must not rewrite it.
 *
 * So we remember the last value this input emitted. Anything different coming
 * back in came from elsewhere — a Settle button prefilling the debt, say — and
 * is worth showing, even while the field has focus. (Gating on focus instead
 * looks right but silently breaks autoFocus fields, which are focused before
 * the parent has finished setting their value.)
 */
export function MoneyInput({
  valueCents,
  onChangeCents,
  className = '',
  placeholder = '0.00',
  ...rest
}) {
  const [text, setText] = useState(() => asText(valueCents));
  const lastEmitted = useRef(valueCents);

  useEffect(() => {
    if (valueCents === lastEmitted.current) return; // our own change, echoed back
    lastEmitted.current = valueCents;
    setText(asText(valueCents));
  }, [valueCents]);

  return (
    <input
      inputMode="decimal"
      className={`input tabular-nums ${className}`}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        // Allow only digits and a single decimal point while typing.
        if (raw !== '' && !/^\d*\.?\d{0,2}$/.test(raw)) return;
        setText(raw);
        const parsed = toCents(raw);
        const cents = Number.isNaN(parsed) ? 0 : parsed;
        lastEmitted.current = cents;
        onChangeCents(cents);
      }}
      {...rest}
    />
  );
}
