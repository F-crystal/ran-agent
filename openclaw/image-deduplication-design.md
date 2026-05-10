# 图片去重方案设计（v2）

**创建时间**: 2026-05-10  
**更新时间**: 2026-05-10 (v2 - 根据评估改进)  
**作者**: 微臣 (AI Agent)  
**状态**: 设计阶段  

---

## 📋 问题背景

### 当前问题

用户在微信聊天中可能会发送重复的图片，当前系统存在以下问题：

1. **存储浪费**: 每张图片都独立存储，重复图片占用多余空间
2. **知识分散**: 同一张图片的多条引用分散在不同笔记中，无法关联
3. **查询低效**: 搜索时会出现多条相同图片的结果

### 用户需求

1. **前台无感知**: 聊天时不要提示"这张图发过了"，正常回复即可
2. **后台智能归并**: 重复图片自动关联到同一记录，节省空间
3. **历史可追溯**: 查询时能看到图片的完整引用历史

---

## 🔍 现有架构分析

### 图片入库流程

```
微信桥接 → /tmp/weixin-agent/media/inbound/*.bin
    ↓
Node Bridge → mediaContextStore.mjs (artifact 级去重)
    ↓
OpenClaw Gateway → POST /ingest
    ↓
personal_agent/http_server.py → handle_ingest()
    ↓
personal_agent/inbox_sync.py → write_external_exchange_to_inbox()
    ↓
vault/inbox/images/*.md (元数据) + .media/*.bin (图片文件)
```

### 关键代码位置

| 文件 | 功能 | 需要修改 |
|------|------|---------|
| `node_bridge/src/mediaContextStore.mjs` | artifact 级去重（分析结果复用） | 否（已有逻辑） |
| `src/personal_agent/http_server.py` | `/ingest` 接口入口 | 否（入口不变） |
| `src/personal_agent/inbox_sync.py` | 图片复制到 vault | **是**（加存储级去重） |
| `src/personal_agent/db.py` | SQLite 基础设施 | **是**（加 media_dedup 表） |
| `src/personal_agent/media_dedup.py` | **新增**：存储级去重服务 | **新增** |
| `vault/inbox/images/` | 图片存储目录 | 否（结构不变） |

---

## 🏗️ 两层去重架构

### Node Bridge 侧：Artifact 级去重

**位置**: `node_bridge/src/mediaContextStore.mjs`

**功能**:
- `collectInboundMediaAssets`: 按 `content_hash` (SHA256) 去重 inbound 媒体
- `findReusableArtifact`: 查找可复用的已有 artifact（分析结果）

**目的**: 避免对同一张图片重复调用 VLM/OCR 分析，节省 API 调用和计算资源

**数据结构**:
```javascript
{
  "content_hash": "sha256:abc123...",
  "artifact_id": "artifact-xxx",
  "analysis_result": {...},  // VLM/OCR 分析结果
  "first_seen": "2026-05-10T12:27:37Z"
}
```

### Python 侧：Vault 存储级去重

**位置**: `src/personal_agent/media_dedup.py` + `db.py`

**功能**:
- 在 `_copy_media_to_vault()` 时检查 SHA256
- 重复图片不复制文件，复用已有文件路径
- 记录引用历史到 SQLite

**目的**: 避免 vault 中存储重复文件，节省磁盘空间，便于查询关联

**数据结构** (SQLite 表 `media_dedup`):
```sql
CREATE TABLE media_dedup (
    sha256 TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL,
    file_path TEXT NOT NULL,  -- 第一次存储的相对路径（从 vault 根目录）
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    reference_count INTEGER NOT NULL DEFAULT 1,
    phash TEXT,  -- Phase 2: 感知哈希
    similar_to_sha256 TEXT,  -- Phase 2: 相似图片关联
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE media_dedup_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL,
    inbox_note_path TEXT NOT NULL,  -- 引用此媒体的 inbox note 路径
    context TEXT,  -- 可选：用户消息前 100 字
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sha256) REFERENCES media_dedup(sha256)
);

CREATE INDEX idx_media_dedup_refs_sha256 ON media_dedup_refs(sha256);
```

### 两层分工对比

| 层面 | Node Bridge (artifact 级) | Python (存储级) |
|------|-------------------------|----------------|
| **去重对象** | 分析结果 (VLM/OCR) | 文件存储 (.bin) |
| **去重时机** | 分析前检查 | 复制前检查 |
| **存储位置** | `state/` 或内存 | SQLite (`data/personal_agent.db`) |
| **目的** | 节省 API 调用 | 节省磁盘空间 |
| **复用内容** | 分析结果 JSON | 文件路径 |
| **是否必须** | 是（避免浪费） | 是（避免冗余） |
| **相互依赖** | 独立 | 独立（可读取 artifact 结果） |

**注意**: 两层去重互不依赖，但可协同工作：
- Node Bridge 先做 artifact 去重 → 返回 `artifact_id` + `file_path`
- Python 侧做存储去重 → 检查 `sha256` → 决定是否复制文件

---

## 💡 设计方案（v2 改进版）

### 核心原则

1. **向后兼容**: 不改变现有文件结构和 API 接口
2. **前台透明**: 用户聊天时无任何感知
3. **增量实现**: 分阶段上线，先精确去重，再语义去重
4. **通用设计**: `MediaDedupService` 支持图片/音频/视频/文档
5. **SQLite 存储**: 使用项目已有 SQLite 基础设施，避免 JSON 并发问题

### 方案概述

#### Phase 1: 精确去重 (SHA256)

```
新图片到达 → 计算 SHA256 → 查询 SQLite
    ├── 已存在 → 复用文件路径，新增引用记录
    └── 不存在 → 存储新文件，创建索引记录
```

#### Phase 2: 相似图片检测 (pHash) - 可选

```
SHA256 不匹配 → 计算 pHash → 相似度检索
    ├── 相似度 > 90% → 创建相似组关联
    └── 相似度 ≤ 90% → 视为新图片
```

### 关键改进点

| 原设计 (v1) | 改进后 (v2) | 理由 |
|------------|------------|------|
| `vault/media_index.json` | SQLite 表 `media_dedup` | 并发安全、事务支持、性能更好 |
| 只处理图片 | 通用媒体去重 | 音频/视频/文档也可能重复 |
| 无并发保护 | SQLite 天然事务 | 避免竞态条件 |
| 未说明 Node Bridge 关系 | 明确两层分工 | 避免逻辑重叠 |
| `original_file` 跨月引用 | 统一用相对路径（从 vault 根目录） | 路径稳定，不依赖月份子目录 |

---

## 🔧 实现细节

### 数据库 Schema 扩展

**文件**: `src/personal_agent/db.py`

```python
# 在 SCHEMA_STATEMENTS 中新增：
"""
CREATE TABLE IF NOT EXISTS media_dedup (
    sha256 TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    mime_type TEXT,
    reference_count INTEGER NOT NULL DEFAULT 1,
    phash TEXT,
    similar_to_sha256 TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
""",
"""
CREATE TABLE IF NOT EXISTS media_dedup_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL,
    inbox_note_path TEXT NOT NULL,
    context TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sha256) REFERENCES media_dedup(sha256)
)
""",
"""
CREATE INDEX IF NOT EXISTS idx_media_dedup_refs_sha256 
ON media_dedup_refs(sha256)
""",
```

### MediaDedupService 实现

**文件**: `src/personal_agent/media_dedup.py` (新增)

```python
"""Media deduplication service using SQLite for index storage."""

from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

from personal_agent.config import AppConfig
from personal_agent.db import Database


class MediaDedupService:
    """Generic media deduplication service (images, audio, video, documents)."""

    def __init__(self, db: Database, vault_dir: Path) -> None:
        self._db = db
        self._vault_dir = vault_dir

    def calculate_sha256(self, file_path: Path) -> str:
        """Calculate SHA256 hash of a file."""
        sha256 = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                sha256.update(chunk)
        return sha256.hexdigest()

    def check_duplicate(self, sha256: str) -> Optional[str]:
        """
        Check if a file with the given SHA256 already exists.
        
        Returns:
            Existing file path (relative to vault root) if duplicate, None otherwise.
        """
        with self._db.connection() as conn:
            row = conn.execute(
                "SELECT file_path FROM media_dedup WHERE sha256 = ?",
                (sha256,)
            ).fetchone()
        return row["file_path"] if row else None

    def record_new_media(
        self,
        sha256: str,
        file_path: str,  # Relative to vault root
        file_size: int,
        mime_type: str,
    ) -> None:
        """Record a new media file in the dedup index."""
        with self._db.connection() as conn:
            conn.execute(
                """
                INSERT INTO media_dedup 
                (sha256, first_seen_at, file_path, file_size, mime_type)
                VALUES (?, ?, ?, ?, ?)
                """,
                (sha256, datetime.now().isoformat(), file_path, file_size, mime_type)
            )
            conn.commit()

    def add_reference(
        self,
        sha256: str,
        inbox_note_path: str,
        context: str = "",
    ) -> None:
        """Add a reference to an existing media file."""
        with self._db.connection() as conn:
            # Add reference record
            conn.execute(
                """
                INSERT INTO media_dedup_refs (sha256, inbox_note_path, context)
                VALUES (?, ?, ?)
                """,
                (sha256, inbox_note_path, context)
            )
            # Update reference count
            conn.execute(
                """
                UPDATE media_dedup 
                SET reference_count = reference_count + 1, 
                    updated_at = CURRENT_TIMESTAMP
                WHERE sha256 = ?
                """,
                (sha256,)
            )
            conn.commit()

    def process_incoming_media(
        self,
        src_path: Path,
        inbox_note_path: Path,
        mime_type: str,
        context: str = "",
    ) -> Tuple[bool, str]:
        """
        Process an incoming media file.
        
        Args:
            src_path: Source file path (absolute, e.g., /tmp/weixin-agent/...)
            inbox_note_path: Target inbox note path (for reference tracking)
            mime_type: MIME type of the media
            context: Optional context (e.g., user message prefix)
        
        Returns:
            (is_duplicate, target_file_path)
            - is_duplicate: True if file already exists
            - target_file_path: Relative path from vault root
        """
        sha256 = self.calculate_sha256(src_path)
        
        # Check for duplicate
        existing_path = self.check_duplicate(sha256)
        
        if existing_path:
            # Duplicate: reuse existing file, add reference
            self.add_reference(sha256, str(inbox_note_path), context)
            return (True, existing_path)
        else:
            # New file: caller will copy it, then record it
            # Return None to signal "not duplicate, please copy"
            return (False, sha256)

    def record_after_copy(
        self,
        sha256: str,
        dest_path: Path,  # Absolute path after copy
        inbox_note_path: Path,
        mime_type: str,
        context: str = "",
    ) -> None:
        """Record a new media file after it has been copied."""
        # Calculate relative path from vault root
        try:
            rel_path = str(dest_path.relative_to(self._vault_dir))
        except ValueError:
            # dest_path is not under vault_dir, use absolute path
            rel_path = str(dest_path)
        
        file_size = dest_path.stat().st_size
        
        # Record in index
        self.record_new_media(sha256, rel_path, file_size, mime_type)
        
        # Add first reference
        self.add_reference(sha256, str(inbox_note_path), context)
```

### inbox_sync.py 修改点

**文件**: `src/personal_agent/inbox_sync.py`

```python
from personal_agent.media_dedup import MediaDedupService
from personal_agent.db import Database

# 在 write_external_exchange_to_inbox() 中：
def write_external_exchange_to_inbox(...) -> Path:
    # ... 现有代码 ...
    
    # 初始化去重服务
    db = Database(config, logger)
    dedup_service = MediaDedupService(db, config.vault_dir)
    
    # Copy media files to vault inbox and update refs to relative paths
    copied_media_refs = _copy_media_to_vault(
        media_refs=media_refs,
        inbox_dir=inbox_dir,
        note_name=note_name,
        dedup_service=dedup_service,  # 新增参数
        inbox_note_path=note_path,    # 新增参数
    )
    
    # ... 现有代码 ...

# 修改 _copy_media_to_vault():
def _copy_media_to_vault(
    *,
    media_refs: tuple[str, ...],
    inbox_dir: Path,
    note_name: str,
    dedup_service: MediaDedupService,  # 新增
    inbox_note_path: Path,              # 新增
) -> tuple[str, ...]:
    """Copy media files from external paths to vault inbox directory.
    
    Returns updated media refs with relative paths for files that were copied.
    """
    if not media_refs:
        return ()

    copied_refs: list[str] = []
    media_dir = inbox_dir / ".media"
    media_dir.mkdir(exist_ok=True)

    for i, ref in enumerate(media_refs):
        ref = ref.strip()
        if not ref:
            continue

        # Parse media ref format: "mime_type file_path" or just "file_path"
        parts = ref.split(None, 2)
        if len(parts) >= 2 and "/" in parts[0]:
            mime_type = parts[0]
            if len(parts) >= 3:
                file_path = parts[2]
            else:
                file_path = parts[1]
        else:
            mime_type = "application/octet-stream"
            file_path = ref

        path_obj = Path(file_path)
        if not path_obj.is_absolute():
            # Already a relative path, keep as-is
            copied_refs.append(ref)
            continue

        if not path_obj.exists():
            # File doesn't exist, keep original ref
            copied_refs.append(ref)
            continue

        # Check for duplicate using dedup service
        is_duplicate, target_info = dedup_service.process_incoming_media(
            src_path=path_obj,
            inbox_note_path=inbox_note_path,
            mime_type=mime_type,
            context="",  # Could extract from user_text
        )
        
        if is_duplicate:
            # Duplicate: reuse existing file path
            # target_info is the existing relative path
            relative_path = target_info
            copied_refs.append(f"{mime_type} {relative_path}")
        else:
            # New file: copy and record
            file_ext = path_obj.suffix or ".bin"
            dest_name = f"{note_name[:-3]}_{i}{file_ext}"
            dest_path = media_dir / dest_name

            try:
                shutil.copy2(path_obj, dest_path)
                relative_path = f".media/{dest_name}"
                
                # Record in dedup index after successful copy
                sha256 = target_info  # process_incoming_media returned sha256
                dedup_service.record_after_copy(
                    sha256=sha256,
                    dest_path=dest_path,
                    inbox_note_path=inbox_note_path,
                    mime_type=mime_type,
                    context="",
                )
                
                copied_refs.append(f"{mime_type} {relative_path}")
            except (OSError, shutil.Error):
                # Copy failed, keep original ref
                copied_refs.append(ref)

    return tuple(copied_refs)
```

### 路径引用策略

**问题**: 去重后，重复图片不复制到当月目录，如何引用？

**方案**: 统一使用**相对路径（从 vault 根目录）**

- 第一次存储：`images/2026-05/.media/vince_cable.bin`
- 第二次引用：直接写 `images/2026-05/.media/vince_cable.bin`

**优点**:
- 路径稳定，不依赖月份
- inbox note 可以用相对路径 `../../images/2026-05/.media/vince_cable.bin`
- 或者存储绝对相对路径（从 vault 根目录）

**实现细节**:
- `media_dedup.file_path` 存储从 vault 根目录的相对路径
- inbox note 中的引用可以：
  - 方案 A: 直接存 `images/2026-05/.media/xxx.bin`（解析时需拼接 vault 根目录）
  - 方案 B: 存 `.media/xxx.bin`，但通过 symlink 指向实际位置

**推荐**: 方案 A，简单直接。

---

## 📊 预期效果

### 存储效率

| 场景 | 当前 | 优化后 |
|------|------|--------|
| 100 张不同图片 | 100 份文件 | 100 份文件 |
| 50 张重复图片 (各发 2 次) | 100 份文件 | 50 份文件 + 引用计数 |
| 节省空间 | 0% | ~50% (重复场景) |

### 性能对比

| 指标 | JSON (v1) | SQLite (v2) |
|------|-----------|-------------|
| 读取延迟 | O(n) 全量加载 | O(1) 索引查询 |
| 写入延迟 | O(n) 全量保存 | O(1) 单条插入 |
| 并发安全 | ❌ 需额外锁 | ✅ 天然事务 |
| 损坏恢复 | ❌ 全丢 | ✅ 部分损坏可恢复 |
| 扩展性 | 几百条变慢 | 百万级无压力 |

### 用户体验

| 场景 | 当前 | 优化后 |
|------|------|--------|
| 发重复图片 | 正常分析回复 | 正常分析回复（无提示） |
| 查询图片 | 多条相同结果 | 1 条结果 + 引用历史 |
| 知识库体积 | 包含重复文件 | 自动去重 |

---

## 🚀 实施计划

### Phase 1: 精确去重 (SHA256) - 核心功能

- [ ] **db.py**: 新增 `media_dedup` 和 `media_dedup_refs` 表
- [ ] **media_dedup.py**: 实现 `MediaDedupService` 类
- [ ] **inbox_sync.py**: 修改 `_copy_media_to_vault()` 集成去重
- [ ] **测试**: 发送重复图片，验证 SQLite 记录和文件复用
- [ ] **测试**: 验证 inbox note 引用路径正确

### Phase 2: 相似图片检测 (pHash) - 可选增强

- [ ] **环境评估**: 检查 `imagehash` / `Pillow` 安装可行性
- [ ] **备选方案**: 如 imagehash 安装困难，调研纯 Python 替代 (如 `pyphash`)
- [ ] **db.py**: 新增 `phash` 和 `similar_to_sha256` 字段
- [ ] **media_dedup.py**: 实现 pHash 计算和相似度检索
- [ ] **测试**: 验证相似图片检测准确率

### Phase 3: 查询优化 - 用户体验

- [ ] **vault 查询**: 显示图片引用历史
- [ ] **相似组展示**: 显示相似图片列表
- [ ] **统计面板**: 显示去重节省空间

---

## ⚠️ 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| SQLite 表结构变更 | 旧数据不兼容 | 新增表不影响现有功能，支持回滚 |
| SHA256 碰撞 | 错误归并 | 概率极低 (2^-256)，可忽略 |
| 性能影响 | 响应延迟 | SHA256 计算 <50ms，SQLite 查询 <10ms |
| 向后兼容 | 旧笔记无法关联 | 新逻辑只对新图片生效，旧图片保持原样 |
| pHash 依赖安装失败 | Phase 2 受阻 | Phase 1 不依赖 pHash，可独立上线 |
| 跨月路径引用 | 路径失效 | 统一用从 vault 根目录的相对路径 |

---

## 📝 测试计划

### 功能测试

1. **重复图片检测**
   - 发送同一张图片 2 次
   - 验证：`media_dedup` 表中 `reference_count` = 2
   - 验证：`.media/` 目录只有 1 个文件
   - 验证：`media_dedup_refs` 表有 2 条引用记录

2. **新图片处理**
   - 发送新图片
   - 验证：`media_dedup` 表创建新条目
   - 验证：文件正常存储

3. **前台透明性**
   - 发送重复图片
   - 验证：回复内容正常，无"已发过"提示

4. **跨月引用**
   - 5 月发图片 A → 存储到 `images/2026-05/`
   - 6 月发同一图片 A → 复用 5 月路径
   - 验证：6 月的 note 正确引用 5 月的文件

### 回归测试

1. **现有功能**
   - 图片分析功能正常
   - inbox sync 正常
   - vault 查询正常

2. **性能测试**
   - 批量发送 100 张图片
   - 验证：响应时间 <2 秒

3. **并发测试**
   - 同时发送 2 张相同图片（模拟并发）
   - 验证：SQLite 事务正确，无竞态条件

---

## 📚 参考资料

- 现有代码：`src/personal_agent/db.py` (SQLite 基础设施)
- 现有代码：`node_bridge/src/mediaContextStore.mjs` (artifact 级去重)
- [SHA-256 维基百科](https://en.wikipedia.org/wiki/SHA-2)
- [imagehash 库](https://github.com/JohannesBuchner/imagehash)

---

## 📅 更新日志

| 日期 | 版本 | 更新内容 |
|------|------|---------|
| 2026-05-10 | v0.1 | 初始设计方案 (JSON 索引) |
| 2026-05-10 | v2 | 根据评估改进：SQLite 替代 JSON、明确 Node Bridge 分工、通用媒体设计、跨月路径策略 |

