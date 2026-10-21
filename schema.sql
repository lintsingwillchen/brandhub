-- ============================================================================
-- BrandHub · 飞书品牌资产中心 数据库表结构设计 (PostgreSQL / MySQL 兼容)
-- ============================================================================

-- 1. 飞书免登用户与权限表 (无需注册，首次打开飞书免登自动写入/更新)
CREATE TABLE feishu_users (
    open_id          VARCHAR(64) PRIMARY KEY,          -- 飞书应用内唯一标识 (ou_xxx)
    union_id         VARCHAR(64),                      -- 飞书跨应用统一标识 (on_xxx)
    name             VARCHAR(128) NOT NULL,            -- 员工姓名
    en_name          VARCHAR(128),                     -- 英文名
    avatar_url       TEXT,                             -- 飞书头像链接
    department_id    VARCHAR(64),                      -- 主部门 ID (od_xxx)
    department_name  VARCHAR(128) NOT NULL DEFAULT '未分配部门',
    job_title        VARCHAR(128),                     -- 职务名称
    role             VARCHAR(32) NOT NULL DEFAULT 'member', -- 角色权限: 'admin'(管理员) | 'maintainer'(内容维护员) | 'member'(普通员工-仅前台)
    last_login_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. 品牌素材与文件夹主表 (支持单文件、素材文件夹、外部云文档链接三种形态)
CREATE TABLE brand_assets (
    id               VARCHAR(64) PRIMARY KEY,          -- 素材或文件夹唯一 ID (如 ast_logo_pack)
    title            VARCHAR(255) NOT NULL,            -- 素材或文件夹标题
    category         VARCHAR(64) NOT NULL,             -- 五大分类: '设计素材' | '模板' | '规范' | '视频' | '图形'
    delivery_type    VARCHAR(32) NOT NULL DEFAULT 'folder', -- 'folder'(素材文件夹) | 'download'(单文件直下) | 'link'(飞书云文档/Figma外链)
    is_folder        BOOLEAN NOT NULL DEFAULT TRUE,    -- 是否为包含多个子素材的文件夹
    format_label     VARCHAR(128) NOT NULL,            -- 格式展示文案 (如 '文件夹 (SVG / AI / PNG)')
    size_label       VARCHAR(64) NOT NULL,             -- 大小展示文案 (如 '14.2 MB')
    total_size_bytes BIGINT NOT NULL DEFAULT 0,        -- 字节数（用于统计）
    version          VARCHAR(32) NOT NULL DEFAULT 'v1.0',
    description      TEXT,                             -- 素材使用说明与规范提示
    tags_json        JSONB DEFAULT '[]',               -- 检索标签数组
    oss_bundle_key   TEXT,                             -- 单文件或文件夹预打包 ZIP 在 OSS/S3 中的 Object Key
    external_url     TEXT,                             -- 若为外链类型，存储飞书云文档或 Figma URL
    is_published     BOOLEAN NOT NULL DEFAULT TRUE,    -- 上架状态: TRUE(已上架-前台可见) | FALSE(已下架-仅后台可见)
    is_featured      BOOLEAN NOT NULL DEFAULT FALSE,   -- 是否在首页「最新推荐」专区展示
    download_count   INTEGER NOT NULL DEFAULT 0,       -- 累计总调用次数（含整包下载与文件夹内单文件下载）
    maintainer_name  VARCHAR(128) NOT NULL,            -- 最近维护人姓名
    maintainer_id    VARCHAR(64),                      -- 最近维护人飞书 open_id
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_assets_published_cat ON brand_assets(is_published, category);
CREATE INDEX idx_assets_featured ON brand_assets(is_published, is_featured);

-- 3. 素材文件夹内部子文件明细表 (一对多关联 brand_assets，支持「打开文件夹 -> 单独下载」)
CREATE TABLE asset_folder_files (
    id               VARCHAR(64) PRIMARY KEY,          -- 子文件唯一 ID (如 sub_logo_1)
    asset_id         VARCHAR(64) NOT NULL REFERENCES brand_assets(id) ON DELETE CASCADE,
    file_name        VARCHAR(255) NOT NULL,            -- 子文件名称 (如 '01_品牌主Logo_中英横版.svg')
    file_format      VARCHAR(32) NOT NULL,             -- 子文件格式 (如 'SVG', 'PNG', 'PPTX', 'MP4')
    spec_label       VARCHAR(128),                     -- 尺寸或规格描述 (如 '3840x2160 px' 或 '矢量无限缩放')
    size_label       VARCHAR(64),                      -- 子文件大小展示 (如 '2.4 MB')
    file_size_bytes  BIGINT NOT NULL DEFAULT 0,
    oss_object_key   TEXT NOT NULL,                    -- 该子文件在对象存储 OSS/S3 中的真实路径 Key
    preview_url      TEXT,                             -- 预览缩略图地址
    download_count   INTEGER NOT NULL DEFAULT 0,       -- 该子文件被「单独下载」的累计次数
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_folder_files_asset ON asset_folder_files(asset_id, sort_order);

-- 4. 用户下载与调用行为审计日志表 (支撑后台视觉化分析控制面板)
CREATE TABLE download_audit_logs (
    id               BIGSERIAL PRIMARY KEY,
    user_open_id     VARCHAR(64) NOT NULL,             -- 下载人飞书 open_id
    user_name        VARCHAR(128) NOT NULL,            -- 下载人姓名
    department_name  VARCHAR(128) NOT NULL,            -- 下载时所属飞书部门 (用于部门活跃度排行)
    asset_id         VARCHAR(64) NOT NULL,             -- 关联主素材/文件夹 ID
    sub_file_id      VARCHAR(64),                      -- 若为「文件夹内单独下载」，记录具体子文件 ID；整包下载则为 NULL
    target_title     VARCHAR(512) NOT NULL,            -- 记录下载的具体对象名称
    category         VARCHAR(64) NOT NULL,             -- 五大分类（用于环形占比图聚合）
    action_type      VARCHAR(32) NOT NULL,             -- '下载全部(整包)' | '文件夹内单下' | '文件下载' | '访问外链'
    client_device    VARCHAR(64) DEFAULT '飞书客户端',   -- 客户端环境 (桌面端 / 移动端)
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_logs_created_at ON download_audit_logs(created_at DESC);
CREATE INDEX idx_logs_dept ON download_audit_logs(department_name);
CREATE INDEX idx_logs_category ON download_audit_logs(category);
