import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import WebSocket from '../../apps/server/node_modules/ws/index.js';

const requireFromServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { PrismaClient } = requireFromServer('@prisma/client');

const baseUrl = required('E2E_BASE_URL').replace(/\/$/, '');
const databaseUrl = required('E2E_DATABASE_URL');
const root = resolve(required('E2E_RUN_ROOT'));
const fixtureSource = resolve(required('E2E_FIXTURE_SOURCE'));
const fixtureRepo = resolve(required('E2E_GIT_FIXTURE'));
const agentExecutable = resolve(required('E2E_AGENT_EXECUTABLE'));
const agentConfigPath = resolve(required('E2E_AGENT_CONFIG'));
const agentLogPath = resolve(required('E2E_AGENT_LOG'));
const adminPassword = required('E2E_ADMIN_PASSWORD');

const csrfCookieName = process.env.E2E_CSRF_COOKIE_NAME ?? 'e2e_csrf';
const adminUsername = 'e2e-admin';
const userPassword = 'E2E user password 2026 🔐';
const otherUserPassword = 'E2E other password 2026 🔐';
const config = { channel: 'release-e2e', retries: 2 };
const schema = [
  {
    name: 'channel',
    label: 'Channel',
    type: 'input',
    required: true,
  },
  {
    name: 'retries',
    label: 'Retries',
    type: 'number',
    required: true,
  },
];

let agentProcess;
let clientLogSocket;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(label, operation, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await operation();
    if (predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function cookieValues(response) {
  const values =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.get('set-cookie')
        ? [response.headers.get('set-cookie')]
        : [];
  return values
    .map((value) => value.split(';')[0])
    .reduce((result, pair) => {
      const separator = pair.indexOf('=');
      if (separator > 0) result[pair.slice(0, separator)] = pair.slice(separator + 1);
      return result;
    }, {});
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await parseBody(response);
  return { response, body, cookies: cookieValues(response) };
}

function expectStatus(result, expected, label) {
  if (result.response.status !== expected) {
    throw new Error(
      `${label} returned HTTP ${result.response.status} (${result.body.code ?? 'unknown'})`,
    );
  }
  return result.body;
}

async function login(username, password) {
  const result = await api('/api/auth/login', { method: 'POST', body: { username, password } });
  const body = expectStatus(result, 200, 'login');
  return { token: body.accessToken, cookies: result.cookies };
}

async function refresh(session) {
  const result = await api('/api/auth/refresh', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(session.cookies),
      'X-CSRF-Token': session.cookies[csrfCookieName],
    },
  });
  const body = expectStatus(result, 200, 'refresh');
  return { token: body.accessToken, cookies: { ...session.cookies, ...result.cookies } };
}

async function logout(session) {
  const result = await api('/api/auth/logout', {
    method: 'POST',
    headers: {
      Cookie: cookieHeader(session.cookies),
      'X-CSRF-Token': session.cookies[csrfCookieName],
    },
  });
  expectStatus(result, 200, 'logout');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${command} command failed`);
  return result.stdout.trim();
}

async function createGitFixture() {
  await mkdir(fixtureRepo, { recursive: true });
  await copyFile(fixtureSource, join(fixtureRepo, 'build-fixture.mjs'));
  await writeFile(join(fixtureRepo, 'README.md'), 'T6.4 isolated deterministic fixture\n', 'utf8');
  run('git', ['init'], fixtureRepo);
  run('git', ['config', 'user.name', 'Build Platform E2E'], fixtureRepo);
  run('git', ['config', 'user.email', 'buildplatform-e2e@example.test'], fixtureRepo);
  run('git', ['add', '.'], fixtureRepo);
  run('git', ['commit', '-m', 'e2e fixture'], fixtureRepo);
  run('git', ['branch', '-M', 'main'], fixtureRepo);
  return run('git', ['rev-parse', 'HEAD'], fixtureRepo);
}

function tomlString(value) {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

function writeAgentConfig(token) {
  return writeFile(
    agentConfigPath,
    [
      `server_url = ${tomlString(baseUrl)}`,
      `token = ${JSON.stringify(token)}`,
      `workspace_root = ${tomlString(join(root, 'agent-workspace'))}`,
      'log_level = "warn"',
      'minimum_free_space_bytes = 0',
      `state_file = ${tomlString(join(root, 'agent-state.json'))}`,
      'log_buffer_max_bytes = 1048576',
      '',
    ].join('\n'),
    'utf8',
  );
}

function startAgent() {
  const output = createWriteStream(agentLogPath, { flags: 'a' });
  const processHandle = spawn(agentExecutable, ['--config', agentConfigPath], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processHandle.stdout.pipe(output, { end: false });
  processHandle.stderr.pipe(output, { end: false });
  const exit = new Promise((resolveExit) => processHandle.once('exit', resolveExit));
  processHandle.once('exit', () => output.end());
  processHandle.exitPromise = exit;
  agentProcess = processHandle;
  return processHandle;
}

async function stopAgent() {
  const current = agentProcess;
  if (!current || current.exitCode !== null) return;
  current.kill();
  await Promise.race([current.exitPromise, sleep(5_000)]);
  if (current.exitCode === null) current.kill('SIGKILL');
  await Promise.race([current.exitPromise, sleep(2_000)]);
  agentProcess = undefined;
}

async function createTemplate(adminToken, name, command, gitUrl) {
  const result = await api('/api/admin/build-templates', {
    method: 'POST',
    token: adminToken,
    body: {
      name,
      description: 'T6.4 isolated fixture',
      agentId: process.env.E2E_AGENT_ID,
      gitUrl: 'https://example.invalid/t6-4.git',
      command,
      artifactDir: 'dist',
      formSchema: schema,
      timeoutSeconds: 60,
    },
  });
  const body = expectStatus(result, 201, 'create build template');
  const id = body.template.id;
  await prisma.buildTemplate.update({ where: { id }, data: { gitUrl } });
  return id;
}

async function createProject(userToken, templateId, name) {
  const result = await api('/api/projects', {
    method: 'POST',
    token: userToken,
    body: {
      name,
      description: 'T6.4 project',
      buildTemplateId: templateId,
      branch: 'main',
      config,
    },
  });
  return expectStatus(result, 201, 'create project').project;
}

async function taskFor(userToken, projectId) {
  const result = await api(`/api/projects/${projectId}/tasks`, {
    method: 'POST',
    token: userToken,
    body: {},
  });
  return expectStatus(result, 201, 'create task').task;
}

async function getTask(userToken, taskId) {
  const result = await api(`/api/tasks/${taskId}`, { token: userToken });
  return expectStatus(result, 200, 'get task').task;
}

async function waitForTask(userToken, taskId, statuses = undefined, timeoutMs = 120_000) {
  return waitFor(
    `task ${taskId}`,
    () => getTask(userToken, taskId),
    (task) => {
      if (!statuses) return ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(task.status);
      return statuses.includes(task.status);
    },
    timeoutMs,
  );
}

async function agentSummary(adminToken) {
  const result = await api(`/api/admin/agents/${process.env.E2E_AGENT_ID}`, { token: adminToken });
  return expectStatus(result, 200, 'get agent').agent;
}

function websocketUrl(path) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = path;
  url.search = '';
  return url.toString();
}

async function connectClientLogs(accessToken) {
  const socket = new WebSocket(websocketUrl('/ws/client'));
  const messages = [];
  let authResolve;
  let authReject;
  const authenticated = new Promise((resolveAuth, rejectAuth) => {
    authResolve = resolveAuth;
    authReject = rejectAuth;
  });
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    messages.push(message);
    if (message.type === 'auth.ok') authResolve();
  });
  socket.on('error', authReject);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });
  socket.send(JSON.stringify({ type: 'auth', accessToken }));
  await Promise.race([
    authenticated,
    sleep(5_000).then(() => {
      throw new Error('client log auth timeout');
    }),
  ]);
  clientLogSocket = socket;
  return { socket, messages };
}

function subscribeClientLogs(client, taskId) {
  client.socket.send(JSON.stringify({ type: 'task.log.subscribe', taskId, offset: 0 }));
}

function closeClientLogs() {
  if (clientLogSocket && clientLogSocket.readyState === WebSocket.OPEN) clientLogSocket.close();
  clientLogSocket = undefined;
}

function parseZipEntries(buffer) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = buffer.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record is missing');
  const count = buffer.readUInt16LE(endOffset + 10);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('ZIP central record is invalid');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error('ZIP local record is invalid');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : inflateRawSync(compressed);
    entries.set(name, Buffer.from(content));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
async function downloadBytes(path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(response.status === 200, `download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function runSuccessScenario(adminToken, userToken, templateId, expectedCommit, client) {
  const project = await createProject(userToken, templateId, 'T6.4 success project');
  const projectRead = await api(`/api/projects/${project.id}`, { token: userToken });
  const refreshedProject = expectStatus(projectRead, 200, 'read project after refresh').project;
  assert(
    JSON.stringify(refreshedProject.config) === JSON.stringify(config),
    'project config did not survive refresh',
  );
  const saved = await api(`/api/projects/${project.id}/config`, {
    method: 'PUT',
    token: userToken,
    body: { config },
  });
  expectStatus(saved, 200, 'save project config');

  const task = await taskFor(userToken, project.id);
  subscribeClientLogs(client, task.id);
  const finalTask = await waitForTask(userToken, task.id);
  assert(
    finalTask.status === 'SUCCEEDED',
    `success fixture did not succeed: ${finalTask.status} ${finalTask.statusReason ?? ''}`,
  );
  assert(
    finalTask.sourceCommit === expectedCommit,
    'task source commit does not match fixture commit',
  );
  assert(finalTask.branch === 'main', 'task branch does not match project branch');
  assert(finalTask.leaseExpiresAt === null, 'successful task retained lease');
  const summary = await agentSummary(adminToken);
  assert(summary.activeTaskId === null, 'successful task retained agent activeTaskId');

  const history = await api(`/api/tasks/${task.id}/logs?offset=0&limit=1048576`, {
    token: userToken,
  });
  const logEntries = expectStatus(history, 200, 'read complete task history').entries;
  const logText = logEntries.map((entry) => entry.chunk).join('');
  assert(logText.includes('e2e fixture stdout'), 'stdout was not persisted');
  assert(logText.includes('e2e fixture stderr'), 'stderr was not persisted');
  assert(
    client.messages.some((message) => message.type === 'task.log' && message.taskId === task.id),
    'client did not receive task.log',
  );

  const artifactResult = await api(`/api/tasks/${task.id}/artifacts?pageSize=100`, {
    token: userToken,
  });
  const artifacts = expectStatus(artifactResult, 200, 'list task artifacts').items;
  const paths = new Set(artifacts.map((artifact) => artifact.relativePath));
  for (const path of ['branch.txt', 'nested/unicode/结果 文件.txt', 'platform-config-copy.json']) {
    assert(paths.has(path), `missing artifact ${path}`);
  }
  const configArtifact = artifacts.find(
    (artifact) => artifact.relativePath === 'platform-config-copy.json',
  );
  const configBytes = await downloadBytes(
    `/api/artifacts/${configArtifact.id}/download`,
    userToken,
  );
  assert(
    JSON.stringify(JSON.parse(configBytes.toString('utf8'))) === JSON.stringify(config),
    'materialized config differs from project config',
  );
  const archive = await downloadBytes(`/api/tasks/${task.id}/artifacts/archive`, userToken);
  const zipEntries = parseZipEntries(archive);
  assert(
    Buffer.from(zipEntries.get('branch.txt') ?? '')
      .toString('utf8')
      .trim() === 'main',
    'ZIP branch artifact is incorrect',
  );
  assert(zipEntries.has('nested/unicode/结果 文件.txt'), 'ZIP Unicode artifact is missing');
  assert(zipEntries.has('platform-config-copy.json'), 'ZIP config artifact is missing');
  assert(
    zipEntries.get('nested/unicode/结果 文件.txt').toString('utf8').includes('channel=release-e2e'),
    'ZIP artifact content is incomplete',
  );
  return { task, project, artifacts };
}

async function main() {
  await mkdir(root, { recursive: true });
  const expectedCommit = await createGitFixture();
  const cli = required('E2E_ADMIN_CLI');
  const initialized = spawnSync(
    process.execPath,
    [cli, '--username', adminUsername, '--password-stdin'],
    {
      cwd: resolve(root, '..', '..'),
      env: process.env,
      input: `${adminPassword}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  if (initialized.status !== 0) throw new Error('isolated administrator initialization failed');

  const admin = await login(adminUsername, adminPassword);
  const adminMe = await api('/api/auth/me', { token: admin.token });
  assert(expectStatus(adminMe, 200, 'admin me').role === 'ADMIN', 'admin role was not returned');

  const agentCreated = await api('/api/admin/agents', {
    method: 'POST',
    token: admin.token,
    body: { name: 'T6.4 Windows E2E Agent' },
  });
  const agent = expectStatus(agentCreated, 201, 'create E2E agent');
  process.env.E2E_AGENT_ID = agent.agent.id;
  await writeAgentConfig(agent.registrationToken);
  startAgent();
  await waitFor(
    'Agent online',
    () => agentSummary(admin.token),
    (summary) => summary.status === 'ONLINE',
  );

  const userCreated = await api('/api/admin/users', {
    method: 'POST',
    token: admin.token,
    body: { username: 'e2e-user', password: userPassword, role: 'USER' },
  });
  const user = expectStatus(userCreated, 201, 'create E2E user');
  const otherCreated = await api('/api/admin/users', {
    method: 'POST',
    token: admin.token,
    body: { username: 'e2e-other', password: otherUserPassword, role: 'USER' },
  });
  expectStatus(otherCreated, 201, 'create other E2E user');
  const userSession = await login('e2e-user', userPassword);
  const refreshedSession = await refresh(userSession);
  const userMe = await api('/api/auth/me', { token: refreshedSession.token });
  assert(expectStatus(userMe, 200, 'user me').id === user.id, 'refreshed user session is invalid');
  const otherSession = await login('e2e-other', otherUserPassword);

  const successTemplate = await createTemplate(
    admin.token,
    'T6.4 success template',
    'node build-fixture.mjs success',
    fixtureRepo,
  );
  const client = await connectClientLogs(refreshedSession.token);
  const first = await runSuccessScenario(
    admin.token,
    refreshedSession.token,
    successTemplate,
    expectedCommit,
    client,
  );
  const hiddenProject = await api(`/api/projects/${first.project.id}`, {
    token: otherSession.token,
  });
  assert(
    hiddenProject.response.status === 404 && hiddenProject.body.code === 'RESOURCE_NOT_FOUND',
    'cross-user project access was not hidden',
  );
  const hiddenTask = await api(`/api/tasks/${first.task.id}`, { token: otherSession.token });
  assert(
    hiddenTask.response.status === 404 && hiddenTask.body.code === 'RESOURCE_NOT_FOUND',
    'cross-user task access was not hidden',
  );
  const hiddenArtifact = await api(`/api/artifacts/${first.artifacts[0].id}/download`, {
    token: otherSession.token,
  });
  assert(
    hiddenArtifact.response.status === 404 && hiddenArtifact.body.code === 'RESOURCE_NOT_FOUND',
    'cross-user artifact access was not hidden',
  );

  await stopAgent();
  await waitFor(
    'Agent offline',
    () => agentSummary(admin.token),
    (summary) => summary.status === 'OFFLINE',
  );
  const offlineProject = await createProject(
    refreshedSession.token,
    successTemplate,
    'T6.4 offline recovery project',
  );
  const offlineTask = await taskFor(refreshedSession.token, offlineProject.id);
  assert(offlineTask.status === 'WAITING_AGENT', 'offline task did not wait for Agent');
  startAgent();
  await waitFor(
    'Agent reconnect',
    () => agentSummary(admin.token),
    (summary) => summary.status === 'ONLINE',
  );
  const recovered = await waitForTask(refreshedSession.token, offlineTask.id);
  assert(recovered.status === 'SUCCEEDED', 'offline task did not complete after reconnect');

  const cancelTemplate = await createTemplate(
    admin.token,
    'T6.4 cancel template',
    'node build-fixture.mjs cancel',
    fixtureRepo,
  );
  const cancelProject = await createProject(
    refreshedSession.token,
    cancelTemplate,
    'T6.4 cancel project',
  );
  const cancelTask = await taskFor(refreshedSession.token, cancelProject.id);
  await waitForTask(refreshedSession.token, cancelTask.id, ['PREPARING', 'RUNNING'], 60_000);
  const cancelResult = await api(`/api/tasks/${cancelTask.id}/cancel`, {
    method: 'POST',
    token: refreshedSession.token,
    body: { reason: 'E2E cancellation' },
  });
  expectStatus(cancelResult, 200, 'cancel running task');
  const canceled = await waitForTask(refreshedSession.token, cancelTask.id, ['CANCELED', 'FAILED']);
  assert(canceled.status === 'CANCELED', 'running cancellation did not reach CANCELED');
  assert(
    (await agentSummary(admin.token)).activeTaskId === null,
    'canceled task retained execution slot',
  );

  const emptyTemplate = await createTemplate(
    admin.token,
    'T6.4 empty template',
    'node build-fixture.mjs empty',
    fixtureRepo,
  );
  const emptyProject = await createProject(
    refreshedSession.token,
    emptyTemplate,
    'T6.4 empty artifact project',
  );
  const emptyTask = await taskFor(refreshedSession.token, emptyProject.id);
  const emptyFinal = await waitForTask(refreshedSession.token, emptyTask.id, ['FAILED']);
  assert(emptyFinal.status === 'FAILED', 'empty artifact build did not fail');
  assert(emptyFinal.leaseExpiresAt === null, 'failed task retained lease');
  assert(
    (await agentSummary(admin.token)).activeTaskId === null,
    'failed task retained execution slot',
  );

  const rootResponse = await fetch(`${baseUrl}/`);
  const projects = await fetch(`${baseUrl}/projects`);
  const apiFallback = await fetch(`${baseUrl}/api/not-a-route`);
  assert(
    rootResponse.status === 200 && (await rootResponse.text()).includes('<html'),
    'Web root did not load',
  );
  assert(
    projects.status === 200 && (await projects.text()).includes('<html'),
    'Web history route did not load',
  );
  assert(apiFallback.status === 404, 'API path was captured by SPA fallback');

  closeClientLogs();
  await logout(refreshedSession);
  await logout(admin);
  process.stdout.write(
    'T6.4 E2E PASS: auth, Agent registration, project config, success build, logs, artifacts, offline recovery, cancellation, empty-artifact failure, ownership and SPA hosting\n',
  );
}

try {
  await main();
} finally {
  closeClientLogs();
  await stopAgent().catch(() => undefined);
  await prisma.$disconnect();
}
