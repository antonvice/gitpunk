import { boardProfile, draftDiff } from './board-data.js';
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
const short = hash => hash?.slice(0, 10) || '—';
const label = state => ({ awaiting_approval: 'needs review', lease_expired: 'claim expired', handed_off: 'handed off' })[state] || state.replaceAll('_', ' ');
const actor = value => `${value?.agent_id || 'agent'} · ${value?.owner_id || 'owner'}`;
let session, timer, busy = false;
function empty(id, text) { $(id).replaceChildren(node('p', text, 'empty')); }
function details(title, text) { $('detail-title').textContent = title; $('details').textContent = text; $('detail-panel').hidden = false; }
async function request(current, route) {
  const response = await fetch(`/v1/repos/${encodeURIComponent(current.repo)}/${route}`, { headers: { Authorization: `Bearer ${current.token}` }, cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (session !== current) throw new Error('Connection changed.');
  if (!response.ok || !body.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
  return body.data;
}
function render(status, current) {
  $('branch-label').textContent = `${current.repo} / ${status.branch}`;
  $('summary').replaceChildren(...[
    [status.intents.filter(item => ['active', 'blocked'].includes(item.state)).length, 'Active intents'],
    [status.checkpoints.length, 'Saved drafts'],
    [status.integration.submissions.filter(item => item.state === 'integrated').length, 'Integrated changes'],
    [short(status.git.target_commit), 'Canonical commit'],
  ].map(([value, title]) => { const metric = node('div', '', 'metric'); metric.append(node('strong', String(value)), node('small', title)); return metric; }));
  $('intents').replaceChildren();
  if (!status.intents.length) empty('intents', 'Declare work from your agent. Its intent, files, and saved drafts will appear here.');
  for (const intent of [...status.intents].reverse()) {
    const card = node('article', ''), head = node('div', '', 'head');
    head.append(node('small', intent.type.toUpperCase()), node('span', label(intent.state), `state ${intent.state}`));
    card.append(head, node('h3', intent.title), node('div', actor(intent.actor), 'meta'), node('p', intent.summary));
    const files = node('div', '', 'files'); files.append(...intent.files.map(file => node('code', file))); card.append(files);
    const latest = new Map(status.checkpoints.filter(item => item.intent_id === intent.id).map(draft => [draft.path, draft]));
    const actions = node('div', '', 'actions');
    for (const draft of latest.values()) {
      const button = node('button', `View WIP · ${draft.path}`, 'secondary');
      button.addEventListener('click', async () => { try { const data = await request(current, `checkpoints/${encodeURIComponent(draft.id)}`); details(`Saved draft · ${draft.path}`, draftDiff(data)); } catch (error) { if (session === current) $('message').textContent = error.message; } });
      actions.append(button);
    }
    if (intent.done_when?.length) {
      const button = node('button', 'Completion criteria', 'secondary');
      button.addEventListener('click', () => details(intent.title, intent.done_when.map(item => `• ${item}`).join('\n'))); actions.append(button);
    }
    card.append(actions); $('intents').append(card);
  }
  $('checks').replaceChildren();
  if (!status.integration.submissions.length) empty('checks', 'Upload a normal Git commit. Checks run against the combined candidate; approval is a separate step.');
  for (const submission of [...status.integration.submissions].reverse()) {
    const upload = status.uploads.find(item => item.id === submission.id), check = status.integration.checks.find(item => item.id === submission.check_id);
    const card = node('article', '');
    card.append(node('span', label(submission.state), `state ${submission.state}`), node('h3', status.intents.find(item => item.id === upload?.manifest.intent_id)?.title || submission.id), node('div', `Target ${short(check?.target)} → ${short(check?.candidate)}`, 'meta'));
    if (submission.reason) card.append(node('p', submission.reason));
    if (check) { const button = node('button', 'View check evidence', 'secondary'); button.addEventListener('click', () => details('Exact candidate check', JSON.stringify(check, null, 2))); card.append(button); }
    $('checks').append(card);
  }
  $('decisions').replaceChildren();
  if (!status.decisions.length) empty('decisions', 'Record a shared contract or architecture choice.');
  for (const decision of [...status.decisions].reverse()) {
    const item = node('div', '', 'note'); item.append(node('span', decision.state, 'state'), node('p', decision.title), node('small', decision.description)); $('decisions').append(item);
  }
  $('handoffs').replaceChildren();
  if (!status.handoffs.length) empty('handoffs', 'Hand off pinned code, agreed decisions, and unfinished criteria to another agent.');
  for (const handoff of [...status.handoffs].reverse()) {
    const item = node('article', '');
    const decisionCount = handoff.decision_ids?.length || 0;
    item.append(node('span', handoff.state, 'state'), node('h3', `${handoff.from_run_id} → ${handoff.to_run_id}`), node('p', `${handoff.checkpoint_ids?.length || 0} pinned files · ${decisionCount} ${decisionCount === 1 ? 'decision' : 'decisions'}`));
    for (const criterion of handoff.remaining_criteria || []) item.append(node('p', criterion)); $('handoffs').append(item);
  }
}
function renderActivity(current) {
  $('activity').replaceChildren();
  const names = { 'intent.changed': 'Intent updated', 'draft.changed': 'Draft saved', 'decision.proposed': 'Decision proposed', 'decision.agreed': 'Decision agreed', 'handoff.offered': 'Handoff offered', 'handoff.accepted': 'Handoff accepted', 'commit.uploaded': 'Commit uploaded', 'checks.finished': 'Checks completed', 'integration.approved': 'Integration approved', 'integration.finished': 'Change integrated' };
  if (!current.events.length) empty('activity', 'Live updates will appear here.');
  for (const event of current.events.slice(-16).reverse()) {
    const item = node('div', '', 'log-entry');
    item.append(node('b', names[event.type] || event.type.replaceAll('.', ' ').replaceAll('_', ' ')), node('small', `${actor(event.actor)} · ${new Date(event.created_at).toLocaleTimeString()}`)); $('activity').append(item);
  }
}
async function refresh() {
  if (!session || busy) return;
  const current = session; busy = true;
  try {
    const status = await request(current, `status?branch=${encodeURIComponent(current.branch)}`);
    const page = await request(current, `events?after=${current.cursor}&branch=${encodeURIComponent(current.branch)}`);
    current.cursor = page.next_cursor;
    current.events = [...current.events, ...page.events.map(({ seq, type, actor, created_at }) => ({ seq, type, actor, created_at }))].slice(-32);
    render(status, current); renderActivity(current);
    $('connection-state').textContent = 'LIVE · LOCAL'; $('connection-title').textContent = `${current.repo} / ${current.branch}`;
    $('message').textContent = `Updated ${new Date().toLocaleTimeString()} · ${status.kafka.configured ? status.kafka.last_error ? 'Kafka retrying' : status.kafka.pending ? `${status.kafka.pending} events awaiting Kafka` : 'Kafka connected' : 'Cursor polling'} · ${status.integration.approval === 'manual' ? 'Owner approval required' : 'Checks not configured'}`;
  } catch (error) { if (session === current) { $('connection-state').textContent = 'DISCONNECTED'; $('message').textContent = error.message; } }
  finally { busy = false; }
}
function connect(data) {
  clearInterval(timer); session = { ...data, cursor: 0, events: [] };
  $('details').textContent = ''; $('detail-panel').hidden = true;
  void refresh(); timer = setInterval(refresh, 2000);
}
$('profile').addEventListener('change', async event => {
  const file = event.target.files[0];
  try { if (!file || file.size > 16_384) throw new Error('Choose a board profile of at most 16 KiB.'); connect(boardProfile(JSON.parse(await file.text()), location.origin)); }
  catch (error) { $('message').textContent = error.message; }
  finally { event.target.value = ''; }
});
$('connect').addEventListener('submit', event => { event.preventDefault(); connect({ repo: $('repo').value, branch: $('branch').value, token: $('token').value }); $('token').value = ''; });
$('close-details').addEventListener('click', () => { $('detail-panel').hidden = true; $('details').textContent = ''; });
$('disconnect').addEventListener('click', () => {
  clearInterval(timer); session = null;
  for (const id of ['summary', 'intents', 'checks', 'decisions', 'handoffs', 'activity', 'details']) $(id).replaceChildren();
  $('detail-panel').hidden = true; $('connection-title').textContent = 'Connect your workspace'; $('connection-state').textContent = 'LOCAL MVP'; $('branch-label').textContent = 'Awaiting connection'; $('message').textContent = 'Disconnected. Token cleared.';
});
