import { useCallback, useEffect, useRef, useState } from 'react';
import { MSG, ACTION } from '../lib/protocol.js';
import { makeTrigger, normalize, DEFAULT_SETTINGS } from '../lib/settings.js';
import { rpc } from '../lib/rpc.js';

const LIVE = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export default function App() {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [draftTrigger, setDraftTrigger] = useState('');
  const [testing, setTesting] = useState(false);
  const [page, setPage] = useState(null);
  const writeTimer = useRef(null);

  useEffect(() => {
    if (!LIVE) {
      setSettings(normalize(DEFAULT_SETTINGS));
      setStatus({ online: false, error: 'preview mode' });
      return;
    }
    rpc(MSG.GET_SETTINGS).then(setSettings).catch(console.error);
    rpc(MSG.GET_STATUS).then(setStatus).catch(console.error);
    chrome.storage.local.get('pageStatus').then((b) => setPage(b.pageStatus || null));
  }, []);

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
          ? `Backend online · ${status.latencyMs}ms${modelName(status) ? ` · ${modelName(status)}` : ''}`
          : `Backend offline${status?.error ? ` · ${status.error}` : ''} — feed passes through unfiltered`}
      </p>

      {isMockBackend(status) && (
        <p className="status" style={{ fontWeight: 700 }}>
          ⚠ Mock backend — no models are loaded. Scores are fake. Stop
          `npm run mock-backend` and run `python app.py`.
        </p>
      )}

      <PageReport page={page} />

      <section>
        <h2>Backend</h2>
        <div className="row">
          <input
            className="grow"
            type="text"
            spellCheck={false}
            value={settings.backendUrl}
            placeholder="http://localhost:8000"
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
      <Threshold
        label="Clickbait"
        hint="Curiosity gaps, outrage hooks, engagement farming — our own trained model"
        value={settings.ragebait}
        onChange={(ragebait) => update({ ragebait })}
        min={0.35}
        max={0.85}
      />
      <Threshold
        label="Boasting"
        hint="Humblebrags, promotion announcements, hustle posts — LinkedIn only"
        value={settings.boast}
        onChange={(boast) => update({ boast })}
        min={0.2}
        max={0.75}
      />
      <label className="row">
        <input
          type="checkbox"
          checked={settings.scanImages}
          onChange={(e) => update({ scanImages: e.target.checked })}
        />
        <span className="grow">Send images for scanning</span>
      </label>
      <p className="hint">
        Off means text only. Images are downloaded and sent to your backend, which is slower.
      </p>

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
                  min="0.15"
                  max="0.7"
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

function PageReport({ page }) {
  if (!page) {
    return (
      <p className="pagereport bad">
        No page report yet. The content script has not run on any supported site
        since the extension was loaded. Open X, Reddit, LinkedIn or Instagram and refresh the tab.
      </p>
    );
  }
  const age = Math.round((Date.now() - page.ts) / 1000);
  const ok = page.matched > 0;
  return (
    <div className={`pagereport ${ok ? 'ok' : 'bad'}`}>
      <div>
        <strong>{page.host}</strong> · {page.platform} · {age}s ago
      </div>
      <div>
        {page.matched} posts matched · {page.seen} sent · {page.painted} filtered
      </div>
      {!ok && page.diag && (
        <button
          className="ghost"
          onClick={() => navigator.clipboard.writeText(JSON.stringify(page.diag, null, 2))}
        >
          Copy diagnostics
        </button>
      )}
    </div>
  );
}

function Threshold({ label, hint, value, onChange, min = 0.1, max = 0.95 }) {
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
          min={min}
          max={max}
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

// The stand-in reports service "MOCK-no-models" and names every model "MOCK".
// Either tell is enough; checking both means a renamed stand-in still gets
// caught rather than quietly passing for the real thing on stage.
function isMockBackend(status) {
  if (!status?.online) return false;
  const service = String(status.service || '');
  const toxicity = String(status.models?.toxicity?.name || '');
  return /mock/i.test(service) || /^mock$/i.test(toxicity);
}

function modelName(status) {
  const n = status?.models?.toxicity?.name;
  return typeof n === 'string' ? n.split('/').pop() : '';
}

function sensitivityLabel(v) {
  if (v <= 0.25) return 'Catch a lot';
  if (v <= 0.38) return 'Balanced';
  if (v <= 0.52) return 'Close matches';
  return 'Near-exact only';
}
