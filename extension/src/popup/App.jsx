import { useCallback, useEffect, useRef, useState } from 'react';
import { MSG, ACTION } from '../lib/protocol.js';
import { makeTrigger, normalize, DEFAULT_SETTINGS } from '../lib/settings.js';
import { rpc } from '../lib/rpc.js';

// True inside the extension, false under `npm run preview`. In preview the popup
// runs on local state only so it can be designed in a normal browser tab —
// every write is a no-op, nothing is persisted.
const LIVE = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

// ---------------------------------------------------------------------------
// UI/UX lead owns the look of this file. The state plumbing below — the debounced
// writer, the optimistic updates, the status poll — is the part that has to stay:
// every write goes through chrome.storage.local, which is what the content script
// and the service worker both read. Restyle freely; keep `update()` as the only
// way state changes.
// ---------------------------------------------------------------------------

export default function App() {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [draftTrigger, setDraftTrigger] = useState('');
  const [testing, setTesting] = useState(false);
  const writeTimer = useRef(null);

  useEffect(() => {
    if (!LIVE) {
      setSettings(normalize(DEFAULT_SETTINGS));
      setStatus({ online: false, error: 'preview mode' });
      return;
    }
    rpc(MSG.GET_SETTINGS).then(setSettings).catch(console.error);
    rpc(MSG.GET_STATUS).then(setStatus).catch(console.error);
  }, []);

  /**
   * Optimistic local update + debounced persist. Sliders fire dozens of times a
   * second; without the debounce every drag would be a storage write, and every
   * storage write invalidates the verdict cache in the service worker.
   */
  const update = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      if (!LIVE) return next;
      clearTimeout(writeTimer.current);
      writeTimer.current = setTimeout(() => {
        rpc(MSG.SAVE_SETTINGS, { patch: next }).catch(console.error);
      }, 180);
      return next;
    });
  }, []);

  const testBackend = async () => {
    if (!LIVE) return;
    setTesting(true);
    try {
      // Persist first so the worker tests the URL actually in the box.
      await rpc(MSG.SAVE_SETTINGS, { patch: settings });
      setStatus(await rpc(MSG.PING_BACKEND, { backendUrl: settings.backendUrl }));
    } catch (err) {
      setStatus({ online: false, error: String(err.message || err) });
    } finally {
      setTesting(false);
    }
  };

  if (!settings) return <div className="loading">Loading…</div>;

  const addTrigger = () => {
    const phrase = draftTrigger.trim();
    if (!phrase) return;
    update({
      triggers: [...settings.triggers, makeTrigger(phrase, settings.defaultTriggerThreshold)],
    });
    setDraftTrigger('');
  };

  const patchTrigger = (id, patch) =>
    update({
      triggers: settings.triggers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });

  return (
    <div className="popup">
      <header>
        <div className="brand">
          <span className="dot" data-on={String(!!status?.online)} />
          <h1>READIT</h1>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span>{settings.enabled ? 'On' : 'Off'}</span>
        </label>
      </header>

      <p className="status">
        {status?.online
          ? `Backend online · ${status.latencyMs}ms`
          : `Backend offline${status?.error ? ` · ${status.error}` : ''} — feed passes through unfiltered`}
      </p>

      <section>
        <h2>Backend</h2>
        <div className="row">
          <input
            className="grow"
            type="text"
            spellCheck={false}
            value={settings.backendUrl}
            placeholder="https://xxxx.ngrok-free.app"
            onChange={(e) => update({ backendUrl: e.target.value })}
          />
          <button onClick={testBackend} disabled={testing}>
            {testing ? '…' : 'Test'}
          </button>
        </div>
      </section>

      <Threshold
        label="Toxicity"
        hint="Hate, harassment, abuse"
        value={settings.toxicity}
        onChange={(toxicity) => update({ toxicity })}
      />
      <Threshold
        label="NSFW"
        hint="Explicit or graphic images"
        value={settings.nsfw}
        onChange={(nsfw) => update({ nsfw })}
      />

      <section>
        <h2>Topics to avoid</h2>
        <p className="hint">
          Plain language. Matched by meaning, not keywords — “arguments about politics” catches
          posts that never use the word.
        </p>
        <div className="row">
          <input
            className="grow"
            type="text"
            value={draftTrigger}
            placeholder="e.g. graphic animal cruelty"
            onChange={(e) => setDraftTrigger(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTrigger()}
          />
          <button onClick={addTrigger}>Add</button>
        </div>

        <ul className="triggers">
          {settings.triggers.map((t) => (
            <li key={t.id}>
              <div className="row">
                <input
                  type="checkbox"
                  checked={t.enabled}
                  onChange={(e) => patchTrigger(t.id, { enabled: e.target.checked })}
                />
                <span className="grow phrase">{t.phrase}</span>
                <button className="ghost" onClick={() =>
                  update({ triggers: settings.triggers.filter((x) => x.id !== t.id) })
                }>
                  ×
                </button>
              </div>
              <div className="row">
                <input
                  type="range"
                  min="0.2"
                  max="0.9"
                  step="0.01"
                  value={t.threshold}
                  onChange={(e) => patchTrigger(t.id, { threshold: Number(e.target.value) })}
                />
                <span className="num">{sensitivityLabel(t.threshold)}</span>
              </div>
            </li>
          ))}
          {!settings.triggers.length && <li className="empty">No topics muted yet.</li>}
        </ul>
      </section>

      <section>
        <h2>Appearance</h2>
        <div className="row">
          <label className="grow">Blur strength</label>
          <input
            type="range"
            min="4"
            max="30"
            step="1"
            value={settings.blurAmount}
            onChange={(e) => update({ blurAmount: Number(e.target.value) })}
          />
          <span className="num">{settings.blurAmount}px</span>
        </div>
        <label className="row">
          <input
            type="checkbox"
            checked={settings.showReason}
            onChange={(e) => update({ showReason: e.target.checked })}
          />
          <span>Say why a post was hidden</span>
        </label>
      </section>

      <footer>
        <button
          onClick={() =>
            LIVE
              ? chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })
              : window.open('/dashboard.html', '_blank')
          }
        >
          Mood dashboard
        </button>
        <button
          className="ghost"
          onClick={() =>
            LIVE
              ? rpc(MSG.RESET_SETTINGS).then(setSettings)
              : setSettings(normalize(DEFAULT_SETTINGS))
          }
        >
          Reset
        </button>
      </footer>
    </div>
  );
}

function Threshold({ label, hint, value, onChange }) {
  return (
    <section>
      <div className="row">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <h2 className="grow">{label}</h2>
        <select
          value={value.action}
          onChange={(e) => onChange({ ...value, action: e.target.value })}
        >
          <option value={ACTION.BLUR}>Blur</option>
          <option value={ACTION.COLLAPSE}>Collapse</option>
          <option value={ACTION.HIDE}>Hide</option>
        </select>
      </div>
      <p className="hint">{hint}</p>
      <div className="row">
        <input
          type="range"
          min="0.1"
          max="0.95"
          step="0.01"
          disabled={!value.enabled}
          value={value.threshold}
          onChange={(e) => onChange({ ...value, threshold: Number(e.target.value) })}
        />
        <span className="num">{Math.round(value.threshold * 100)}%</span>
      </div>
    </section>
  );
}

// Users do not think in cosine similarity. A low threshold catches more, so the
// scale reads backwards from the number.
function sensitivityLabel(v) {
  if (v <= 0.35) return 'Catch a lot';
  if (v <= 0.5) return 'Balanced';
  if (v <= 0.68) return 'Close matches';
  return 'Only exact';
}
