import { useEffect, useMemo, useState } from 'react';
import { MSG, REASON, PLATFORM_LABELS } from '../lib/protocol.js';
import { summarize, REASON_LABELS } from '../lib/events.js';
import { mockEvents } from '../lib/mock.js';
import { rpc } from '../lib/rpc.js';

export default function App() {
  const [events, setEvents] = useState(null);
  const [useMock, setUseMock] = useState(false);

  const load = () =>
    rpc(MSG.GET_EVENTS)
      .then((res) => setEvents(res.events || []))
      .catch(() => setEvents([]));

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      setEvents([]);
      return;
    }
    load();
    const onChange = (changes, area) => {
      if (area === 'local' && changes.events) setEvents(changes.events.newValue || []);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const isMock = useMock || (events !== null && events.length === 0);
  const data = useMemo(() => (isMock ? mockEvents() : events || []), [isMock, events]);
  const s = useMemo(() => summarize(data), [data]);

  if (events === null) return <div className="loading">Loading…</div>;

  return (
    <div className="dash">
      <header>
        <div>
          <h1>What this session did to your feed</h1>
          <p className="sub">
            {s.total} posts scored over {s.sessionMinutes} min
            {isMock && ' · sample data'}
          </p>
        </div>
        <div className="actions">
          <button onClick={() => setUseMock((v) => !v)}>
            {useMock ? 'Show real data' : 'Show sample data'}
          </button>
          <button
            className="ghost"
            onClick={() => rpc(MSG.CLEAR_EVENTS).then(load)}
            disabled={isMock}
          >
            Clear log
          </button>
        </div>
      </header>

      {isMock && events.length === 0 && (
        <p className="banner">
          No real events yet — scroll X, Reddit or LinkedIn with the extension on and this fills in live.
          Showing sample data meanwhile.
        </p>
      )}

      <div className="tiles">
        <Tile label="Calm score" value={s.calmScore} suffix="/100" big />
        <Tile label="Reached you" value={s.total - s.filtered} suffix={` of ${s.total}`} />
        <Tile label="Filtered" value={s.filtered} />
        <Tile label="You un-hid" value={s.revealed} />
        <Tile label="Avg toxicity" value={Math.round(s.avgToxicity * 100)} suffix="%" />
      </div>

      <section>
        <h2>Exposure over time</h2>
        <p className="hint">
          Each bar is 5 minutes. The dark portion is what was filtered out; the line is
          average toxicity of everything scored in that window.
        </p>
        <Timeline timeline={s.timeline} />
      </section>

      <div className="split">
        <section>
          <h2>Why posts were filtered</h2>
          <Bars
            rows={Object.values(REASON).map((r) => ({
              label: REASON_LABELS[r],
              value: s.byReason[r] || 0,
            }))}
          />
        </section>

        <section>
          <h2>Topics you muted, ranked by how often they showed up</h2>
          {s.topTriggers.length ? (
            <Bars rows={s.topTriggers.map((t) => ({ label: t.phrase, value: t.count }))} />
          ) : (
            <p className="hint">No semantic triggers matched yet.</p>
          )}
        </section>
      </div>

      <section>
        <h2>Where it came from</h2>
        <Bars
          rows={Object.entries(s.byPlatform).map(([p, n]) => ({
            label: PLATFORM_LABELS[p] || p,
            value: n,
          }))}
        />
      </section>

      <p className="footnote">
        Calm score is a presentational summary of filter rate and average toxicity — not a model
        output. Every score behind it came from our own classifiers.
      </p>
    </div>
  );
}

function Tile({ label, value, suffix, big }) {
  return (
    <div className="tile" data-big={String(!!big)}>
      <div className="tile-value">
        {value}
        {suffix && <span className="tile-suffix">{suffix}</span>}
      </div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function Timeline({ timeline }) {
  if (!timeline.length) return <p className="hint">Nothing logged yet.</p>;

  const W = 900;
  const H = 220;
  const PAD = { t: 12, r: 12, b: 26, l: 34 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const maxTotal = Math.max(1, ...timeline.map((b) => b.total));
  const barW = Math.max(2, innerW / timeline.length - 3);

  const x = (i) => PAD.l + (i * innerW) / timeline.length;
  const y = (v) => PAD.t + innerH - (v / maxTotal) * innerH;
  const toxY = (v) => PAD.t + innerH - v * innerH;

  const linePath = timeline
    .map((b, i) => `${i ? 'L' : 'M'}${(x(i) + barW / 2).toFixed(1)},${toxY(b.avgToxicity).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Posts scored and filtered over time">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(maxTotal * f)} y2={y(maxTotal * f)} className="grid" />
          <text x={PAD.l - 6} y={y(maxTotal * f) + 4} className="axis" textAnchor="end">
            {Math.round(maxTotal * f)}
          </text>
        </g>
      ))}

      {timeline.map((b, i) => (
        <g key={b.t}>
          <rect x={x(i)} y={y(b.total)} width={barW} height={PAD.t + innerH - y(b.total)} className="bar-total" />
          <rect x={x(i)} y={y(b.filtered)} width={barW} height={PAD.t + innerH - y(b.filtered)} className="bar-filtered" />
        </g>
      ))}

      <path d={linePath} className="tox-line" fill="none" />

      <text x={PAD.l} y={H - 8} className="axis">
        {fmtTime(timeline[0].t)}
      </text>
      <text x={W - PAD.r} y={H - 8} className="axis" textAnchor="end">
        {fmtTime(timeline[timeline.length - 1].t)}
      </text>
    </svg>
  );
}

function Bars({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bar-num">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

const fmtTime = (t) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
