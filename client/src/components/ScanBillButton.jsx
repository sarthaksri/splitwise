import { useRef, useState } from 'react';
import { scanReceipt } from '../lib/scanReceipt.js';

/**
 * "Scan a bill" — photograph a receipt and have the dishes filled in.
 *
 * `capture="environment"` puts a phone straight into the rear camera, which is
 * the whole point of the feature: you are standing at the table with the bill
 * in your hand. On a laptop the same input is an ordinary file picker.
 *
 * Everything it produces lands in the editable form below it, so a misread
 * costs a correction rather than a wrong balance.
 */
export function ScanBillButton({ onScanned, disabled }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [engine, setEngine] = useState(null);
  const [error, setError] = useState(null);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    // Clear immediately, so picking the same photo again still fires a change.
    event.target.value = '';
    if (!file) return;

    setBusy(true);
    setError(null);
    setEngine(null);
    setProgress(0);

    try {
      const result = await scanReceipt(file, { onProgress: setProgress, onEngine: setEngine });
      onScanned(result);
    } catch (err) {
      setError(err.message ?? 'That scan failed. Try again, or add the dishes by hand.');
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
        aria-hidden="true"
        tabIndex={-1}
      />

      <button
        type="button"
        className="btn-secondary w-full border-dashed"
        disabled={busy || disabled}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <span className="inline-block size-4 animate-spin rounded-full border-2 border-line border-t-brand-500" />
            {engine === 'tesseract' ? 'Reading on your phone…' : 'Reading the bill…'}
          </span>
        ) : (
          <span className="flex items-center justify-center gap-2">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M3 7V5a2 2 0 012-2h2M17 7V5a2 2 0 00-2-2h-2M3 13v2a2 2 0 002 2h2M17 13v2a2 2 0 01-2 2h-2" strokeLinecap="round" />
              <path d="M3 10h14" strokeLinecap="round" />
            </svg>
            Scan a bill
          </span>
        )}
      </button>

      {busy && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-sunken">
          <div
            className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}

      {busy && engine === 'tesseract' && (
        <p className="mt-1.5 text-xs text-fg-subtle">
          Reading it here on your device, so the photo is never uploaded. The first scan
          downloads the recogniser, so it takes a few seconds — and it&apos;s rougher than
          the online reader, so check the rows carefully.
        </p>
      )}

      {error && (
        <p className="mt-1.5 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
