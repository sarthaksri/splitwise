import { useEffect, useRef, useState } from 'react';
import { MAX_PAGES } from '@shared/receipt.js';
import { scanReceipt } from '../lib/scanReceipt.js';

/**
 * "Scan a bill" — photograph a receipt and have the dishes filled in.
 *
 * `capture="environment"` puts a phone straight into the rear camera, which is
 * the whole point of the feature: you are standing at the table with the bill
 * in your hand. On a laptop the same input is an ordinary file picker.
 *
 * One bill is often several photos. A long thermal receipt can't be read in a
 * single shot taken far enough back to fit it all in, and some bills run to a
 * second page — so both ways of giving it more than one are supported:
 *
 *   Pick several at once, from the gallery. `multiple` handles that.
 *   Take one, then another. The camera only ever returns a single shot, so
 *   after a scan the button becomes "Add another photo" and the text of the
 *   photos already read is carried forward.
 *
 * Adding a photo re-reads only the new one and then re-does the whole bill, so
 * the overlap between shots is resolved with every page in view at once.
 *
 * Everything it produces lands in the editable form below it, so a misread
 * costs a correction rather than a wrong balance.
 */
export function ScanBillButton({ onScanned, disabled, scanned }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState(null);
  const [page, setPage] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  // The OCR text of the photos read so far. Kept so that adding a photo costs
  // one recognition rather than all of them again.
  const [pages, setPages] = useState([]);

  // The scan was dismissed, or the form reopened for a different expense: the
  // photos held here belong to a bill nobody is looking at any more.
  useEffect(() => {
    if (!scanned) {
      setPages([]);
      setNote(null);
    }
  }, [scanned]);

  async function handleFiles(event) {
    const files = [...(event.target.files ?? [])];
    // Clear immediately, so picking the same photo again still fires a change.
    event.target.value = '';
    if (files.length === 0) return;

    setBusy(true);
    setError(null);
    setNote(null);
    setStage(null);
    setPage(null);
    setProgress(0);

    try {
      const result = await scanReceipt(files, {
        alreadyRead: pages,
        onProgress: setProgress,
        onStage: setStage,
        onPage: setPage,
      });
      setPages(result.pages);
      if (result.unreadable > 0) {
        setNote(
          result.unreadable === 1
            ? 'One photo had no readable text and was skipped.'
            : `${result.unreadable} photos had no readable text and were skipped.`,
        );
      }
      onScanned(result);
    } catch (err) {
      setError(err.message ?? 'That scan failed. Try again, or add the dishes by hand.');
    } finally {
      setBusy(false);
      setProgress(0);
      setStage(null);
      setPage(null);
    }
  }

  const busyLabel = () => {
    if (stage === 'structuring' || stage === 'local') return 'Working out the dishes…';
    // Which photo, but only when there is more than one — "photo 1 of 1" is
    // noise, and this is the line someone stares at while they wait.
    if (page && page.total > 1) return `Reading photo ${page.index + 1} of ${page.total}…`;
    return 'Reading the bill…';
  };

  const full = pages.length >= MAX_PAGES;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        // Several shots of one long receipt, in the order they were taken. A
        // phone's camera still returns one at a time; the gallery honours this.
        multiple
        capture="environment"
        className="hidden"
        onChange={handleFiles}
        aria-hidden="true"
        tabIndex={-1}
      />

      <button
        type="button"
        className="btn-secondary w-full border-dashed"
        disabled={busy || disabled || full}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <span className="inline-block size-4 animate-spin rounded-full border-2 border-line border-t-brand-500" />
            {busyLabel()}
          </span>
        ) : (
          <span className="flex items-center justify-center gap-2">
            {pages.length === 0 ? (
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M3 7V5a2 2 0 012-2h2M17 7V5a2 2 0 00-2-2h-2M3 13v2a2 2 0 002 2h2M17 13v2a2 2 0 01-2 2h-2" strokeLinecap="round" />
                <path d="M3 10h14" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M10 4v12M4 10h12" strokeLinecap="round" />
              </svg>
            )}
            {pages.length === 0 ? 'Scan a bill' : 'Add another photo'}
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

      {busy && stage === 'reading' && (
        <p className="mt-1.5 text-xs text-fg-subtle">
          The photo is read here on your device and never uploaded. The first scan
          downloads the recogniser, so give it a few seconds.
        </p>
      )}

      {/* Long receipts are the case people struggle with, and nothing on screen
          would otherwise suggest a second photo is allowed. */}
      {!busy && pages.length > 0 && !full && (
        <p className="mt-1.5 text-xs text-fg-subtle">
          {pages.length === 1
            ? 'Read from one photo. If the bill ran off the edge, add the rest of it.'
            : `Read from ${pages.length} photos.`}{' '}
          Overlapping shots are fine — a line photographed twice is only charged once.
        </p>
      )}

      {!busy && full && (
        <p className="mt-1.5 text-xs text-fg-subtle">
          {MAX_PAGES} photos read — as much bill as one scan takes. Dismiss the scan
          note below to start again.
        </p>
      )}

      {note && (
        <p className="mt-1.5 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-fg">{note}</p>
      )}

      {error && (
        <p className="mt-1.5 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
