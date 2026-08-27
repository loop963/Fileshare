const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = Number(process.env.PORT || 30286);
const FILES_DIR = path.resolve(process.env.FILES_DIR || '/app/files');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/app/data');
// 临时上传文件必须位于 /app/files 所在卷内，否则 Docker volume 与容器层之间 rename 会触发 EXDEV。
const UPLOAD_DIR = path.join(FILES_DIR, '.fileshare-tmp');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const guestSessions = new Map();

for (const dir of [FILES_DIR, DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  try {
    const a = crypto.scryptSync(String(password), record.salt, 64);
    const b = Buffer.from(record.hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function safeRelative(input = '') {
  // 根目录可能来自前端的 ''、'/' 或 '\\'，这些都应统一表示为空相对路径。
  let raw = String(input ?? '').trim().replaceAll('\\', '/');
  if (!raw || /^\/+$/u.test(raw)) return '';

  // 去掉开头的斜杠，避免把用户输入当成宿主机绝对路径。
  raw = raw.replace(/^\/+/, '');
  const normalized = path.posix.normalize(raw);

  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0')) {
    throw new Error('非法路径');
  }
  return normalized;
}
function safeName(input) {
  const n = String(input || '').trim();
  if (!n || n === '.' || n === '..' || /[\\/\0]/.test(n)) throw new Error('非法名称');
  return n;
}
function safePath(input = '') {
  const rel = safeRelative(input);
  const target = path.resolve(FILES_DIR, rel);
  if (target !== FILES_DIR && !target.startsWith(FILES_DIR + path.sep)) throw new Error('非法路径');
  return target;
}
function statusOf(share) {
  if (!share.enabled) return '已取消';
  if (share.expiresAt && Date.now() >= share.expiresAt) return '已过期';
  if (share.maxDownloads > 0 && share.downloads >= share.maxDownloads) return '次数用尽';
  return '正常';
}
function newToken() { return crypto.randomBytes(24).toString('base64url'); }
function baseUrl(req) { return `${req.protocol}://${req.get('host')}`; }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

let shares = loadJson(SHARES_FILE, {});
let config = loadJson(CONFIG_FILE, null);
let configSource = 'file';
const DEFAULT_STORAGE = { maxFileSizeMB: 102400, maxStorageGB: 0 };

// 管理员密码初始化：
// 1) 有有效 config.json 时优先使用持久化密码；
// 2) config.json 不存在/损坏时使用 ADMIN_PASSWORD，并尽力写入；
// 3) 如果 Docker/OpenWrt 的 /app/data 因权限问题无法写入，也保留内存配置，
//    这样首次启动不会出现“密码明明正确却始终错误”。
function initializeAdminConfig() {
  const envPassword = process.env.ADMIN_PASSWORD;

  if (config && config.admin && config.admin.salt && config.admin.hash) {
    configSource = 'file';
    return;
  }

  if (!envPassword) {
    console.error(`[FileShare] ERROR: ${CONFIG_FILE} 不存在或无效，而且未设置 ADMIN_PASSWORD。`);
    console.error('[FileShare] 请在 Docker 环境变量中设置 ADMIN_PASSWORD 后重新创建/启动容器。');
    process.exit(1);
  }

  config = {
    admin: hashPassword(envPassword),
    guestAccounts: [],
    createdAt: Date.now(),
    version: 1
  };
  configSource = 'environment';

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    saveJson(CONFIG_FILE, config);
    configSource = 'file';
    console.log(`[FileShare] 已创建管理员配置：${CONFIG_FILE}`);
  } catch (err) {
    console.warn(`[FileShare] 警告：无法写入 ${CONFIG_FILE}：${err.message}`);
    console.warn('[FileShare] 将使用 ADMIN_PASSWORD 的内存配置继续运行；请检查 /app/data 的挂载和写权限。');
  }
}

initializeAdminConfig();

function normalizeGuestAccounts() {
  if (!Array.isArray(config.guestAccounts)) config.guestAccounts = [];
  config.guestAccounts = config.guestAccounts.filter(x => x && x.username && x.password).map(x => ({
    id: String(x.id || newToken()), username: String(x.username), password: x.password, enabled: x.enabled !== false, createdAt: Number(x.createdAt || Date.now()), lastLoginAt: Number(x.lastLoginAt || 0)
  }));
}
normalizeGuestAccounts();

function normalizeStorageConfig() {
  if (!config.storage || typeof config.storage !== 'object') config.storage = {};
  let maxFileSizeMB = Number(config.storage.maxFileSizeMB);
  let maxStorageGB = Number(config.storage.maxStorageGB);
  if (!Number.isFinite(maxFileSizeMB) || maxFileSizeMB < 1) maxFileSizeMB = DEFAULT_STORAGE.maxFileSizeMB;
  if (!Number.isFinite(maxStorageGB) || maxStorageGB < 0) maxStorageGB = DEFAULT_STORAGE.maxStorageGB;
  config.storage.maxFileSizeMB = Math.min(Math.floor(maxFileSizeMB), 1048576);
  config.storage.maxStorageGB = Math.min(Math.floor(maxStorageGB), 1048576);
}
normalizeStorageConfig();

function storageLimits() {
  return {
    maxFileSizeMB: config.storage.maxFileSizeMB,
    maxFileSizeBytes: config.storage.maxFileSizeMB * 1024 * 1024,
    maxStorageGB: config.storage.maxStorageGB,
    maxStorageBytes: config.storage.maxStorageGB > 0 ? config.storage.maxStorageGB * 1024 * 1024 * 1024 : 0
  };
}
function persistConfig() {
  saveJson(CONFIG_FILE, config);
  configSource = 'file';
}

function persistShares() { saveJson(SHARES_FILE, shares); }
// 服务重启时清理上次异常中断遗留的临时上传文件。
(async () => {
  try {
    const entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true });
    await Promise.all(entries.map(e => fsp.rm(path.join(UPLOAD_DIR, e.name), { recursive: true, force: true })));
  } catch {}
})();
function newSessionToken() { return crypto.randomBytes(32).toString('base64url'); }
function getGuest(req) {
  const token = req.get('X-Guest-Token') || req.query.guestToken || '';
  const session = guestSessions.get(token);
  if (!session || session.expiresAt < Date.now()) { if (token) guestSessions.delete(token); return null; }
  const account = config.guestAccounts.find(x => x.id === session.accountId && x.enabled !== false);
  if (!account) return null;
  return account;
}
function requireGuest(req, res, next) {
  const guest = getGuest(req);
  if (!guest) return res.status(401).json({ error: '来宾登录已失效，请重新登录' });
  req.guest = guest;
  next();
}
function requireAdminOrGuest(req, res, next) {
  const supplied = req.get('X-Admin-Password') || '';
  if (verifyPassword(supplied, config.admin)) { req.role = 'admin'; return next(); }
  const guest = getGuest(req);
  if (guest) { req.role = 'guest'; req.guest = guest; return next(); }
  return res.status(401).json({ error: '请先登录' });
}

function makeDownloadTicket(relPath, role = 'admin', accountId = '') {
  const ts = Date.now();
  const raw = `${role}.${accountId}.${relPath}.${ts}`;
  const sig = crypto.createHmac('sha256', config.admin.hash).update(raw).digest('base64url');
  return `${ts}.${sig}`;
}
function verifyDownloadTicket(relPath, ticket, role = 'admin', accountId = '') {
  const [ts, sig] = String(ticket || '').split('.');
  const timestamp = Number(ts);
  if (!timestamp || Date.now() - timestamp > 5 * 60 * 1000 || Date.now() < timestamp - 30 * 1000) return false;
  const expected = crypto.createHmac('sha256', config.admin.hash).update(`${role}.${accountId}.${relPath}.${timestamp}`).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(String(sig || '')), Buffer.from(expected));
}

function requireAdmin(req, res, next) {
  const supplied = req.get('X-Admin-Password') || '';
  if (!verifyPassword(supplied, config.admin)) return res.status(401).json({ error: '管理员密码错误' });
  next();
}

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.upload`)
});
function uploadMiddleware(req, res, next) {
  const limits = storageLimits();
  multer({
    storage: uploadStorage,
    limits: { files: 5000, fileSize: limits.maxFileSizeBytes }
  }).array('files', 5000)(req, res, err => {
    if (err) {
      for (const file of (req.files || [])) { try { fs.rmSync(file.path, { force: true }); } catch {} }
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `单个文件不能超过 ${limits.maxFileSizeMB} MB` });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(413).json({ error: '一次最多上传 5000 个文件' });
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    next();
  });
}

async function uniqueDestination(target) {
  try { await fsp.access(target); } catch { return target; }
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    try { await fsp.access(candidate); } catch { return candidate; }
  }
  throw new Error('文件名冲突过多');
}

function decodeUploadFilename(originalName) {
  const input = String(originalName || '');
  if (!input) return input;

  // Multer/Busboy 在现代 Node.js 环境下通常已经正确返回 UTF-8。
  // 只有检测到典型的 UTF-8 被错误按 Latin-1 解码（mojibake）时才修复。
  // 不能无条件执行 latin1 -> utf8，否则正常中文会再次被破坏。
  const suspicious = /[\u00C0-\u00FF\u0080-\u009F]/.test(input) || /[ÃÂâ€š™œž]/.test(input);
  if (!suspicious) return input;

  try {
    const repaired = Buffer.from(input, 'latin1').toString('utf8');
    if (repaired.includes('\uFFFD')) return input;

    const cjkCount = value => (value.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const badCount = value => (value.match(/[\u0000-\u001F\u007F-\u009FÃÂ]/g) || []).length;

    // 只有修复后 CJK 字符明显增加、异常字符减少，才采用修复结果。
    if (cjkCount(repaired) > cjkCount(input) || badCount(repaired) < badCount(input)) {
      return repaired;
    }
  } catch {}

  return input;
}
function uploadedRelativeName(originalName) {
  const decodedName = decodeUploadFilename(originalName);
  const normalized = String(decodedName || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const rel = path.posix.normalize(normalized);
  if (rel === '.' || rel === '..' || rel.startsWith('../') || rel.includes('\0')) throw new Error('上传文件路径非法');
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) throw new Error('上传文件名为空');
  parts.forEach(safeName);
  return parts.join('/');
}

async function calculateStorage(dir) {
  let total = 0, files = 0, folders = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (dir === FILES_DIR && e.name === '.fileshare-tmp') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { folders++; const x = await calculateStorage(p); total += x.total; files += x.files; folders += x.folders; }
    else if (e.isFile()) { files++; total += (await fsp.stat(p)).size; }
  }
  return { total, files, folders };
}

async function listItems(relPath) {
  const current = safeRelative(relPath);
  const dir = safePath(current);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    // 隐藏上传临时目录，避免用户在文件列表中看到它。
    if (current === '' && e.name === '.fileshare-tmp') continue;
    const childRel = current ? `${current}/${e.name}` : e.name;
    const p = path.join(dir, e.name);
    const st = await fsp.stat(p);
    items.push({
      name: e.name,
      path: childRel,
      type: e.isDirectory() ? 'dir' : 'file',
      size: e.isDirectory() ? null : st.size,
      mtime: st.mtimeMs
    });
  }
  items.sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : (a.type === 'dir' ? -1 : 1));
  return { path: current, items };
}

app.get('/api/health', (_req, res) => {
  let dataWritable = false;
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    dataWritable = true;
  } catch {}
  res.json({
    ok: true,
    version: '1.2.0',
    port: PORT,
    configExists: fs.existsSync(CONFIG_FILE),
    configSource,
    dataWritable
  });
});

app.post('/api/guest/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const account = config.guestAccounts.find(x => x.username === username && x.enabled !== false);
  if (!account || !verifyPassword(password, account.password)) return res.status(401).json({ error: '来宾账号或密码错误' });
  const token = newSessionToken();
  guestSessions.set(token, { accountId: account.id, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  account.lastLoginAt = Date.now();
  try { persistConfig(); } catch {}
  res.json({ ok: true, token, username: account.username, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
});
app.post('/api/guest/logout', requireGuest, (req, res) => {
  const token = req.get('X-Guest-Token') || ''; guestSessions.delete(token); res.json({ ok: true });
});
app.get('/api/guest/files', requireGuest, async (req, res) => {
  try { res.json(await listItems(req.query.path || '')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/admin/guests', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(username)) return res.status(400).json({ error: '账号需为 2～32 位字母、数字、点、下划线或短横线' });
  if (password.length < 6) return res.status(400).json({ error: '来宾密码至少 6 位' });
  if (config.guestAccounts.some(x => x.username === username)) return res.status(409).json({ error: '来宾账号已存在' });
  const account = { id: newToken(), username, password: hashPassword(password), enabled: true, createdAt: Date.now(), lastLoginAt: 0 };
  config.guestAccounts.push(account); persistConfig();
  res.json({ ok: true, account: { id: account.id, username, enabled: true, createdAt: account.createdAt, lastLoginAt: 0 } });
});
app.get('/api/admin/guests', requireAdmin, (_req, res) => {
  res.json({ accounts: config.guestAccounts.map(x => ({ id:x.id, username:x.username, enabled:x.enabled !== false, createdAt:x.createdAt, lastLoginAt:x.lastLoginAt || 0 })) });
});
app.patch('/api/admin/guests/:id', requireAdmin, (req, res) => {
  const a = config.guestAccounts.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: '来宾账号不存在' });
  if (req.body.enabled !== undefined) a.enabled = !!req.body.enabled;
  if (req.body.password !== undefined) { const password = String(req.body.password || ''); if (password.length < 6) return res.status(400).json({ error: '来宾密码至少 6 位' }); a.password = hashPassword(password); }
  persistConfig();
  for (const [token, session] of guestSessions) if (session.accountId === a.id && !a.enabled) guestSessions.delete(token);
  res.json({ ok: true });
});
app.delete('/api/admin/guests/:id', requireAdmin, (req, res) => {
  const before = config.guestAccounts.length; config.guestAccounts = config.guestAccounts.filter(x => x.id !== req.params.id);
  if (before === config.guestAccounts.length) return res.status(404).json({ error: '来宾账号不存在' });
  persistConfig(); for (const [token, session] of guestSessions) if (session.accountId === req.params.id) guestSessions.delete(token); res.json({ ok: true });
});
app.post('/api/admin/download-ticket', requireAdmin, async (req, res) => {
  try { const rel = safeRelative(req.body.path); const st = await fsp.stat(safePath(rel)); if (!st.isFile() && !st.isDirectory()) throw new Error('无法下载'); res.json({ ok:true, url:`/file-download?path=${encodeURIComponent(rel)}&ticket=${encodeURIComponent(makeDownloadTicket(rel))}` }); }
  catch(e){ res.status(400).json({error:e.message}); }
});

app.get('/api/files', requireAdmin, async (req, res) => {
  try { res.json(await listItems(req.query.path || '')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/folders', requireAdmin, async (_req, res) => {
  const folders = [''];
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (rel === '' && e.name === '.fileshare-tmp') continue;
      if (!e.isDirectory()) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      folders.push(child); await walk(path.join(dir,e.name), child);
    }
  }
  try { await walk(FILES_DIR,''); folders.sort((a,b)=>a.localeCompare(b,'zh-CN')); res.json({folders}); } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/storage', requireAdmin, async (_req, res) => {
  try {
    const x = await calculateStorage(FILES_DIR);
    const limits = storageLimits();
    const percent = limits.maxStorageBytes ? Math.min(100, x.total / limits.maxStorageBytes * 100) : 0;
    res.json({ used: x.total, usedText: formatBytes(x.total), files: x.files, folders: x.folders,
      maxFileSizeMB: limits.maxFileSizeMB, maxFileSizeText: formatBytes(limits.maxFileSizeBytes),
      maxStorageGB: limits.maxStorageGB, maxStorageText: limits.maxStorageBytes ? formatBytes(limits.maxStorageBytes) : '不限',
      percent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/storage', requireAdmin, (_req, res) => {
  const limits = storageLimits();
  res.json({ maxFileSizeMB: limits.maxFileSizeMB, maxStorageGB: limits.maxStorageGB });
});

app.patch('/api/admin/storage', requireAdmin, async (req, res) => {
  try {
    const maxFileSizeMB = Number(req.body.maxFileSizeMB);
    const maxStorageGB = Number(req.body.maxStorageGB);
    if (!Number.isFinite(maxFileSizeMB) || maxFileSizeMB < 1 || maxFileSizeMB > 1048576)
      return res.status(400).json({ error: '单个文件大小必须为 1～1048576 MB' });
    if (!Number.isFinite(maxStorageGB) || maxStorageGB < 0 || maxStorageGB > 1048576)
      return res.status(400).json({ error: '整个空间大小必须为 0～1048576 GB，0 表示不限' });
    const previous = config.storage;
    config.storage = { maxFileSizeMB: Math.floor(maxFileSizeMB), maxStorageGB: Math.floor(maxStorageGB) };
    try { persistConfig(); }
    catch (err) { config.storage = previous; return res.status(500).json({ error: `存储设置保存失败：${err.message}` }); }
    res.json({ ok: true, ...config.storage });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/upload', requireAdmin, uploadMiddleware, async (req, res) => {
  const results = [];
  try {
    const base = safeRelative(req.body.path ?? '');
    const limits = storageLimits();
    const files = req.files || [];
    if (!files.length) throw new Error('没有收到上传文件');
    if (files.some(f => f.size > limits.maxFileSizeBytes)) throw new Error(`单个文件不能超过 ${limits.maxFileSizeMB} MB`);
    if (limits.maxStorageBytes) {
      const current = await calculateStorage(FILES_DIR);
      const incoming = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
      if (current.total + incoming > limits.maxStorageBytes)
        throw new Error(`存储空间不足：当前已使用 ${formatBytes(current.total)}，空间上限 ${formatBytes(limits.maxStorageBytes)}`);
    }
    for (const file of files) {
      const relativeName = uploadedRelativeName(file.originalname);
      const destination = safePath(base ? `${base}/${relativeName}` : relativeName);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      const finalTarget = await uniqueDestination(destination);
      await fsp.rename(file.path, finalTarget);
      results.push({ name: path.relative(FILES_DIR, finalTarget).replaceAll(path.sep, '/'), ok: true });
    }
    res.json({ ok: true, uploaded: results.length, results });
  } catch (e) {
    for (const file of (req.files || [])) { try { await fsp.rm(file.path, { force: true }); } catch {} }
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/folder', requireAdmin, async (req, res) => {
  try {
    const parent = safeRelative(req.body.path || '');
    const folder = safeName(req.body.name);
    const target = safePath(parent ? `${parent}/${folder}` : folder);
    await fsp.mkdir(target, { recursive: false });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.code === 'EEXIST' ? '文件夹已存在' : e.message }); }
});

app.post('/api/rename', requireAdmin, async (req, res) => {
  try {
    const oldRel = safeRelative(req.body.path);
    const newName = safeName(req.body.name);
    const oldPath = safePath(oldRel);
    const newPath = path.join(path.dirname(oldPath), newName);
    if (newPath !== FILES_DIR && !newPath.startsWith(FILES_DIR + path.sep)) throw new Error('非法路径');
    await fsp.rename(oldPath, newPath);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.code === 'EEXIST' ? '目标已存在' : e.message }); }
});

app.post('/api/move', requireAdmin, async (req, res) => {
  try {
    const source = safeRelative(req.body.path);
    const targetDir = safeRelative(req.body.destination || '');
    if (!source) throw new Error('不能移动根目录');
    const sourcePath = safePath(source);
    const stat = await fsp.stat(sourcePath);
    const targetDirPath = safePath(targetDir);
    const targetStat = await fsp.stat(targetDirPath);
    if (!targetStat.isDirectory()) throw new Error('目标位置不是文件夹');
    if (stat.isDirectory() && (targetDir === source || targetDir.startsWith(source + '/'))) throw new Error('不能移动到自身或子文件夹');
    const target = await uniqueDestination(path.join(targetDirPath, path.basename(sourcePath)));
    await fsp.rename(sourcePath, target);
    res.json({ ok:true, path:path.relative(FILES_DIR,target).replaceAll(path.sep,'/') });
  } catch(e) { res.status(400).json({error:e.message}); }
});

app.post('/api/delete', requireAdmin, async (req, res) => {
  try {
    const rel = safeRelative(req.body.path);
    if (!rel) throw new Error('不能删除根目录');
    await fsp.rm(safePath(rel), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/check', (req, res) => {
  if (verifyPassword(req.body.password, config.admin)) return res.json({ ok: true });
  res.status(401).json({ error: '密码错误' });
});
app.post('/api/admin/password', async (req, res) => {
  if (!verifyPassword(req.body.current, config.admin)) return res.status(401).json({ error: '当前密码错误' });
  const next = String(req.body.newPassword || '');
  if (next.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  const previous = config.admin;
  config.admin = hashPassword(next);
  try {
    persistConfig();
    res.json({ ok: true });
  } catch (err) {
    config.admin = previous;
    res.status(500).json({ error: `密码保存失败：${err.message}` });
  }
});

app.post('/api/shares', requireAdmin, async (req, res) => {
  try {
    const rel = safeRelative(req.body.path);
    if (!rel) throw new Error('不能分享根目录');
    const stat = await fsp.stat(safePath(rel));
    const expiresIn = Math.max(0, Math.floor(Number(req.body.expiresIn || 0)));
    const maxDownloads = Math.max(0, Math.floor(Number(req.body.maxDownloads || 0)));
    const token = newToken();
    shares[token] = {
      token, path: rel, type: stat.isDirectory() ? 'dir' : 'file',
      password: req.body.password ? hashPassword(req.body.password) : null,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : 0,
      maxDownloads, downloads: 0, createdAt: Date.now(), enabled: true
    };
    persistShares();
    res.json({ ok: true, token, url: `${baseUrl(req)}/s/${token}` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/shares', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const list = Object.values(shares)
    .filter(s => !q || s.path.toLowerCase().includes(q))
    .sort((a,b) => b.createdAt - a.createdAt)
    .map(s => ({
      token: s.token, path: s.path, status: statusOf(s), hasPassword: !!s.password,
      expiresAt: s.expiresAt, downloads: s.downloads, maxDownloads: s.maxDownloads,
      createdAt: s.createdAt, url: `${baseUrl(req)}/s/${s.token}`
    }));
  res.json({ shares: list });
});

app.patch('/api/shares/:token', requireAdmin, async (req, res) => {
  try {
    const s = shares[req.params.token];
    if (!s) return res.status(404).json({ error: '分享不存在' });
    if (req.body.expiresIn !== undefined) {
      const seconds = Math.max(0, Math.floor(Number(req.body.expiresIn || 0)));
      s.expiresAt = seconds ? Date.now() + seconds * 1000 : 0;
    }
    if (req.body.maxDownloads !== undefined) s.maxDownloads = Math.max(0, Math.floor(Number(req.body.maxDownloads || 0)));
    if (req.body.passwordMode === 'remove') s.password = null;
    if (req.body.passwordMode === 'set') s.password = req.body.password ? hashPassword(req.body.password) : null;
    persistShares();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/shares/:token', requireAdmin, (_req, res) => {
  const s = shares[_req.params.token];
  if (s) { s.enabled = false; persistShares(); }
  res.json({ ok: true });
});
app.post('/api/shares/batch', requireAdmin, (req, res) => {
  for (const token of (Array.isArray(req.body.tokens) ? req.body.tokens : [])) if (shares[token]) shares[token].enabled = false;
  persistShares();
  res.json({ ok: true });
});

function signTicket(token, timestamp) {
  const raw = `${token}.${timestamp}`;
  const sig = crypto.createHmac('sha256', config.admin.hash).update(raw).digest('base64url');
  return `${timestamp}.${sig}`;
}
function verifyTicket(token, ticket) {
  const [ts, sig] = String(ticket || '').split('.');
  const timestamp = Number(ts);
  if (!timestamp || Date.now() - timestamp > 10 * 60 * 1000 || Date.now() < timestamp - 60 * 1000) return false;
  try {
    const expected = crypto.createHmac('sha256', config.admin.hash).update(`${token}.${timestamp}`).digest('base64url');
    const a = Buffer.from(String(sig || ''));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function sharePage(s, req, error = '') {
  const status = statusOf(s);
  const passwordNeeded = !!s.password;
  const downloadUrl = `/download/${encodeURIComponent(s.token)}${passwordNeeded ? '' : ''}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>FileShare - 分享</title><style>body{font-family:system-ui;margin:0;background:#f5f8ff;color:#172033;display:grid;place-items:center;min-height:100vh}.box{background:#fff;border:1px solid #e6eaf2;border-radius:20px;padding:34px;width:min(520px,calc(100% - 32px));box-shadow:0 16px 50px #1d4ed81a}h1{margin:0 0 10px;color:#2563eb}.path{background:#f6f8fc;padding:14px;border-radius:12px;word-break:break-all}.err{color:#dc2626;background:#fef2f2;padding:10px;border-radius:9px}.meta{color:#64748b;font-size:14px}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d8deea;border-radius:10px;margin:8px 0 12px}button,a{display:inline-block;border:0;border-radius:10px;padding:11px 16px;background:#2563eb;color:#fff;text-decoration:none;cursor:pointer}button:hover,a:hover{filter:brightness(.96)}</style></head><body><div class="box"><h1>FileShare</h1><p>文件分享</p><div class="path">${escapeHtml(s.path)}</div><p class="meta">下载：${s.downloads}/${s.maxDownloads || '∞'}　·　${status}</p>${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}${status !== '正常' ? '' : passwordNeeded ? `<form method="post"><label>请输入分享密码</label><input name="password" type="password" autofocus required><button>验证并下载</button></form>` : `<a href="${downloadUrl}">开始下载</a>`}</div></body></html>`;
}

app.get('/s/:token', async (req, res) => {
  const s = shares[req.params.token];
  if (!s) return res.status(404).send('分享不存在');
  try { await fsp.access(safePath(s.path)); } catch { return res.status(404).send('分享文件不存在'); }
  res.status(statusOf(s) === '正常' ? 200 : 410).send(sharePage(s, req));
});
app.post('/s/:token', async (req, res) => {
  const s = shares[req.params.token];
  if (!s) return res.status(404).send('分享不存在');
  if (statusOf(s) !== '正常') return res.status(410).send(sharePage(s, req));
  if (!s.password || !verifyPassword(req.body.password, s.password)) return res.status(401).send(sharePage(s, req, '密码错误'));
  const ticket = signTicket(s.token, Date.now());
  res.redirect(`/download/${encodeURIComponent(s.token)}?ticket=${encodeURIComponent(ticket)}`);
});

async function reserveDownload(s) {
  if (statusOf(s) !== '正常') throw new Error(`分享${statusOf(s)}`);
  s.downloads += 1;
  persistShares();
}
function releaseDownload(_s) {}

async function sendDownload(res, fp) {
  const stat = await fsp.stat(fp);
  const name = path.basename(fp);
  if (stat.isDirectory()) {
    res.statusCode=200; res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name+'.zip')}`);
    const archive=archiver('zip',{zlib:{level:6}}); archive.on('error',err=>{if(!res.headersSent)res.status(500);res.end();}); archive.pipe(res); archive.directory(fp,false); await archive.finalize();
  } else {
    res.setHeader('Content-Type','application/octet-stream'); res.setHeader('Content-Length',stat.size); res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(name)}`); fs.createReadStream(fp).on('error',()=>{if(!res.headersSent)res.status(500).end();}).pipe(res);
  }
}
app.get('/file-download', async (req,res)=>{
  try { const rel=safeRelative(req.query.path||''); if(!verifyDownloadTicket(rel,req.query.ticket,'admin','')) return res.status(403).send('下载链接已失效'); const fp=safePath(rel); await fsp.access(fp); await sendDownload(res,fp); }
  catch(e){ if(!res.headersSent)res.status(404).send(e.message||'文件不存在'); }
});
app.get('/guest-download', requireGuest, async (req,res)=>{
  try { const rel=safeRelative(req.query.path||''); const fp=safePath(rel); await fsp.access(fp); await sendDownload(res,fp); }
  catch(e){ if(!res.headersSent)res.status(404).send(e.message||'文件不存在'); }
});

app.get('/download/:token', async (req, res) => {
  const s = shares[req.params.token];
  if (!s) return res.status(404).send('分享不存在');
  if (s.password && !verifyTicket(s.token, req.query.ticket)) return res.status(403).send('请先验证分享密码');
  let fp;
  try { fp = safePath(s.path); await fsp.access(fp); await reserveDownload(s); }
  catch (e) { return res.status(410).send(e.message || '分享不可用'); }
  try {
    const stat = await fsp.stat(fp);
    const name = path.basename(fp);
    if (stat.isDirectory()) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name + '.zip')}`);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', err => { if (!res.headersSent) res.status(500); res.end(); releaseDownload(s); });
      res.on('close', () => releaseDownload(s));
      archive.pipe(res);
      archive.directory(fp, false);
      await archive.finalize();
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      const stream = fs.createReadStream(fp);
      stream.on('error', () => { releaseDownload(s); if (!res.headersSent) res.status(500).end(); });
      res.on('close', () => releaseDownload(s));
      stream.pipe(res);
    }
  } catch (e) { releaseDownload(s); if (!res.headersSent) res.status(500).send('下载失败'); }
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/s/') && !req.path.startsWith('/download/')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});
app.use((err, _req, res, _next) => { console.error(err); res.status(400).json({ error: err.message || '请求失败' }); });

app.listen(PORT, () => {
  console.log(`FileShare listening on :${PORT}`);
  console.log(`[FileShare] DATA_DIR: ${DATA_DIR}`);
  console.log(`[FileShare] CONFIG_FILE: ${CONFIG_FILE}`);
  console.log(`[FileShare] 单文件上限: ${formatBytes(storageLimits().maxFileSizeBytes)}`);
  console.log(`[FileShare] 总空间上限: ${storageLimits().maxStorageGB > 0 ? formatBytes(storageLimits().maxStorageBytes) : '不限'}`);
  console.log(`[FileShare] config.json: ${fs.existsSync(CONFIG_FILE) ? '存在' : '不存在（使用环境变量内存配置）'}`);
  console.log(`[FileShare] /app/data 可写: ${(() => { try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return '是'; } catch { return '否'; } })()}`);
});
