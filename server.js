/**
 * BrandHub · 飞书品牌资产中心 服务端核心 API 参考实现 (Node.js + Express + PostgreSQL)
 * 包含：
 *  1. 飞书网页应用 OAuth 2.0 免登鉴权 (code -> user_access_token -> open_id & 部门信息)
 *  2. 前后台接口权限隔离中间件 (普通员工仅能访问已上架素材，管理员/内容维护员可访问后台分析与 CMS)
 *  3. 素材文件夹「下载全部(整包)」与「打开文件夹单独下载子文件」接口及实时审计埋点
 *  4. 后台视觉化控制面板聚合统计 API 与素材上下架 CRUD API
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:password@localhost:5432/feishu_brandhub'
});

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || 'replace-with-strong-secret';
const OSS_CDN_BASE = process.env.OSS_CDN_BASE || 'https://brand-assets.example.com';

// ==================== 1. 飞书免登鉴权 API ====================
// 前端在 window.h5sdk.ready 中调用 tt.requestAccess 获取 code 后调用此接口
app.post('/api/auth/feishu-login', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '缺少飞书免登授权码 code' });

    // Step 1: 获取应用 app_access_token
    const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
    }).then(r => r.json());

    // Step 2: 使用预授权码 code 换取 user_access_token (v2 接口)
    const userTokenResp = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: FEISHU_APP_ID,
        client_secret: FEISHU_APP_SECRET,
        code
      })
    }).then(r => r.json());

    // Step 3: 获取飞书登录用户个人信息 (open_id, 姓名, 头像)
    const profileResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${userTokenResp.access_token}` }
    }).then(r => r.json());

    const u = profileResp.data;

    // Step 4: 写入或更新本地 feishu_users 表，并读取该员工在系统内的角色 (admin / maintainer / member)
    const upsertSql = `
      INSERT INTO feishu_users (open_id, union_id, name, en_name, avatar_url, last_login_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (open_id) DO UPDATE
      SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, last_login_at = NOW()
      RETURNING open_id, name, department_name, job_title, role;
    `;
    const dbResult = await pool.query(upsertSql, [u.open_id, u.union_id, u.name, u.en_name, u.avatar_url]);
    const userRecord = dbResult.rows[0];

    const sessionToken = jwt.sign(
      {
        open_id: userRecord.open_id,
        name: userRecord.name,
        department_name: userRecord.department_name,
        role: userRecord.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token: sessionToken, user: userRecord });
  } catch (err) {
    res.status(500).json({ error: '飞书免登鉴权失败', details: err.message });
  }
});

// ==================== 2. 鉴权与前后台隔离中间件 ====================
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '未登录或飞书免登会话已过期' });
  }
}

// 仅允许管理员 (admin) 和内容维护员 (maintainer) 访问后台接口
function requireBackendRole(req, res, next) {
  if (!req.user || !['admin', 'maintainer'].includes(req.user.role)) {
    return res.status(403).json({ error: '权限不足：普通员工仅可访问前台，无法访问后台管理或数据看板' });
  }
  next();
}

// ==================== 3. 前台接口：获取已上架素材与文件夹子文件 ====================
app.get('/api/frontend/assets', requireAuth, async (req, res) => {
  const assetsRes = await pool.query(
    `SELECT * FROM brand_assets WHERE is_published = TRUE ORDER BY is_featured DESC, updated_at DESC`
  );
  const filesRes = await pool.query(
    `SELECT * FROM asset_folder_files ORDER BY sort_order ASC`
  );
  const filesByAsset = {};
  for (const f of filesRes.rows) {
    if (!filesByAsset[f.asset_id]) filesByAsset[f.asset_id] = [];
    filesByAsset[f.asset_id].push(f);
  }
  const list = assetsRes.rows.map(a => ({
    ...a,
    folderFiles: filesByAsset[a.id] || []
  }));
  res.json({ assets: list });
});

// ==================== 4. 下载触发与实时审计记录 API ====================

// 4A. 「下载全部」或「单文件立即下载」
app.post('/api/assets/:id/download', requireAuth, async (req, res) => {
  const assetId = req.params.id;
  const { clientDevice } = req.body;
  const { open_id, name, department_name } = req.user;

  const assetRes = await pool.query(`SELECT * FROM brand_assets WHERE id = $1 AND is_published = TRUE`, [assetId]);
  if (assetRes.rowCount === 0) return res.status(404).json({ error: '素材不存在或已下架' });
  const asset = assetRes.rows[0];

  const actionType = asset.is_folder
    ? '下载全部(整包)'
    : (asset.delivery_type === 'link' ? '访问外链' : '文件下载');

  await pool.query(`UPDATE brand_assets SET download_count = download_count + 1 WHERE id = $1`, [assetId]);
  await pool.query(
    `INSERT INTO download_audit_logs (user_open_id, user_name, department_name, asset_id, target_title, category, action_type, client_device)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [open_id, name, department_name, asset.id, asset.title, asset.category, actionType, clientDevice || '飞书客户端']
  );

  const downloadUrl = asset.delivery_type === 'link'
    ? asset.external_url
    : `${OSS_CDN_BASE}/${asset.oss_bundle_key}?download=1`;

  res.json({ ok: true, downloadUrl, actionType });
});

// 4B. 打开文件夹后「单独下载」其中某个子文件
app.post('/api/assets/:assetId/files/:fileId/download', requireAuth, async (req, res) => {
  const { assetId, fileId } = req.params;
  const { clientDevice } = req.body;
  const { open_id, name, department_name } = req.user;

  const assetRes = await pool.query(`SELECT * FROM brand_assets WHERE id = $1 AND is_published = TRUE`, [assetId]);
  const fileRes = await pool.query(`SELECT * FROM asset_folder_files WHERE id = $1 AND asset_id = $2`, [fileId, assetId]);
  if (assetRes.rowCount === 0 || fileRes.rowCount === 0) {
    return res.status(404).json({ error: '子文件不存在或所属文件夹已下架' });
  }

  const asset = assetRes.rows[0];
  const subFile = fileRes.rows[0];

  await pool.query(`UPDATE asset_folder_files SET download_count = download_count + 1 WHERE id = $1`, [fileId]);
  await pool.query(`UPDATE brand_assets SET download_count = download_count + 1 WHERE id = $1`, [assetId]);
  await pool.query(
    `INSERT INTO download_audit_logs (user_open_id, user_name, department_name, asset_id, sub_file_id, target_title, category, action_type, client_device)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '文件夹内单下', $8)`,
    [
      open_id,
      name,
      department_name,
      asset.id,
      subFile.id,
      `${subFile.file_name} (来自：${asset.title})`,
      asset.category,
      clientDevice || '飞书客户端'
    ]
  );

  const downloadUrl = `${OSS_CDN_BASE}/${subFile.oss_object_key}?download=1`;
  res.json({ ok: true, downloadUrl, subFileName: subFile.file_name });
});

// ==================== 5. 后台管理与视觉化看板 API (仅管理员与维护员可访问) ====================

// 5A. 后台视觉化控制面板统计聚合
app.get('/api/admin/analytics', requireAuth, requireBackendRole, async (req, res) => {
  const byCategory = await pool.query(
    `SELECT category, COUNT(*)::int AS count FROM download_audit_logs GROUP BY category`
  );
  const byDepartment = await pool.query(
    `SELECT department_name, COUNT(*)::int AS count FROM download_audit_logs GROUP BY department_name ORDER BY count DESC`
  );
  const recentLogs = await pool.query(
    `SELECT * FROM download_audit_logs ORDER BY created_at DESC LIMIT 100`
  );
  res.json({
    byCategory: byCategory.rows,
    byDepartment: byDepartment.rows,
    recentLogs: recentLogs.rows
  });
});

// 5B. 后台一键上架 / 下架切换
app.patch('/api/admin/assets/:id/publish', requireAuth, requireBackendRole, async (req, res) => {
  const { is_published } = req.body;
  await pool.query(
    `UPDATE brand_assets SET is_published = $1, maintainer_name = $2, updated_at = NOW() WHERE id = $3`,
    [Boolean(is_published), req.user.name, req.params.id]
  );
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BrandHub Feishu Server listening on port ${PORT}`);
});
