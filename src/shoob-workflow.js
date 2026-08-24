'use strict';
const config = require('./config');

const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
let lastDispatchAt = 0;

function settings() {
  const value = config.githubActions || {};
  return {
    token: String(value.token || '').trim(),
    repository: String(value.repository || 'tomangamez-star/Tempest_rimuru_bot').trim(),
    workflow: String(value.workflow || 'shoob-archive.yml').trim(),
    ref: String(value.ref || 'main').trim(),
  };
}

async function github(path, options = {}) {
  const cfg = settings();
  if (!cfg.token) throw new Error('GITHUB_ACTIONS_TOKEN is not configured on Render');
  if (!/^[^/\s]+\/[^/\s]+$/.test(cfg.repository)) throw new Error('GITHUB_REPOSITORY must be owner/repository');
  const response = await fetch(`https://api.github.com/repos/${cfg.repository}${path}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'User-Agent': 'Rimuru-Shoob-Workflow/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  const text = await response.text();
  if (text) { try { data = JSON.parse(text); } catch (_) { data = { message: text }; } }
  if (!response.ok) {
    const error = new Error((data && data.message) || `GitHub API HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function workflowState() {
  const cfg = settings();
  const path = `/actions/workflows/${encodeURIComponent(cfg.workflow)}/runs?per_page=20&exclude_pull_requests=true`;
  const data = await github(path);
  const runs = Array.isArray(data && data.workflow_runs) ? data.workflow_runs : [];
  const active = runs.find((run) => ACTIVE.has(String(run.status || '').toLowerCase())) || null;
  return { active, latest: runs[0] || null };
}

function runLabel(run) {
  if (!run) return '';
  const number = run.run_number ? ` #${run.run_number}` : '';
  const status = String(run.status || 'unknown').replace(/_/g, ' ').toUpperCase();
  return `${status}${number}`;
}

async function forceStart() {
  const cfg = settings();
  if (!cfg.token) return { ok: false, configuration: true, message: 'GITHUB_ACTIONS_TOKEN is not configured on Render.' };
  try {
    const state = await workflowState();
    if (state.active) {
      return { ok: true, alreadyActive: true, run: state.active,
        message: `Shoob ingestion is already ${runLabel(state.active)}. No overlapping run was added.` };
    }
    if (Date.now() - lastDispatchAt < 60_000) {
      return { ok: true, alreadyActive: true, message: 'A Shoob force-start was already requested within the last minute.' };
    }
    const data = await github(`/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`, {
      method: 'POST', body: { ref: cfg.ref },
    });
    lastDispatchAt = Date.now();
    return { ok: true, started: true, run: data || null,
      message: 'Shoob ingestion force-start accepted by GitHub. It should enter the queue within seconds.' };
  } catch (error) {
    const hint = error.status === 401 || error.status === 403
      ? ' Check that the fine-grained token has Actions: read and write for this repository.'
      : error.status === 404 ? ' Check the repository and workflow filename.' : '';
    return { ok: false, error, message: `${error.message}.${hint}`.replace('..', '.') };
  }
}

module.exports = { forceStart, workflowState, runLabel, _settings: settings, _activeStatuses: ACTIVE };
