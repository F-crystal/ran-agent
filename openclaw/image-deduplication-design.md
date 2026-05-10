# 图片去重方案设计

**创建时间**: 2026-05-10  
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
| `src/personal_agent/http_server.py` | `/ingest` 接口入口 | 否（入口不变） |
| `src/personal_agent/inbox_sync.py` | 图片复制到 vault | **是**（加去重逻辑） |
| `vault/inbox/images/` | 图片存储目录 | 否（结构不变） |

### 当前数据结构

**inbox note (Markdown)**:
```markdown
---
type: inbox_note
title: Chat Sync 2026-05-10 12:29:17
created: 2026-05-10 12:29:17
source: chat_sync
channel: wechat
sender_id: o9cq80wdal3W2Wp3NyX1NPCpkfTo@im.wechat
ingest_source: openclaw_gateway
category: images
---

## User Message
看这张图片

## Media References
- image/* .media/images_sync_20260510_122917_554270_wechat_o9cq80wdal3W2Wp3NyX1NPCpkfTo-im-wechat_0.bin

## Agent Reply
[分析内容]
```

**媒体文件**: `vault/inbox/images/.media/*.bin`

---

## 💡 设计方案

### 核心原则

1. **向后兼容**: 不改变现有文件结构和 API 接口
2. **前台透明**: 用户聊天时无任何感知
3. **增量实现**: 分阶段上线，先精确去重，再语义去重

### 方案概述

#### 1. 精确去重 (SHA256)

```
新图片到达 → 计算 SHA256 → 查询索引
    ├── 已存在 → 复用文件，新增引用记录
    └── 不存在 → 存储新文件，创建索引
```

#### 2. 相似图片检测 (pHash) - 可选二期

```
SHA256 不匹配 → 计算 pHash → 相似度检索
    ├── 相似度 > 90% → 创建相似组关联
    └── 相似度 ≤ 90% → 视为新图片
```

### 数据结构设计

#### 媒体索引文件 (新增)

**位置**: `vault/media_index.json`

```json
{
  "version": "1.0",
  "created": "2026-05-10T12:00:00+08:00",
  "media": {
    "sha256:c9928f79d424d880...": {
      "sha256": "c9928f79d424d880fe234a3704e2e18d7309e04d1db1dc5d4d3f99c9a7a58f94",
      "first_seen": "2026-05-10T12:27:37+08:00",
      "original_file": "images/2026-05/.media/vince_cable_homepage.bin",
      "reference_count": 2,
      "references": [
        {
          "timestamp": "2026-05-10T12:27:37+08:00",
          "inbox_note": "images/images_sync_20260510_122737_xxx.md",
          "context": "分享小红书链接"
        },
        {
          "timestamp": "2026-05-10T12:36:30+08:00",
          "inbox_note": "images/images_sync_20260510_123630_xxx.md",
          "context": "讨论去重方案"
        }
      ],
      "phash": "a1b2c3d4e5f6g7h8",  // 二期实现
      "similar_to": []  // 二期实现
    }
  }
}
```

### 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/personal_agent/inbox_sync.py` | 修改 | 在 `_copy_media_to_vault()` 中增加去重逻辑 |
| `src/personal_agent/media_dedup.py` | 新增 | 去重核心逻辑（SHA256 计算、索引查询） |
| `vault/media_index.json` | 新增 | 媒体索引文件（运行时创建） |
| `openclaw/image-deduplication-design.md` | 新增 | 本文档 |

---

## 🔧 实现细节

### 去重逻辑伪代码

```python
# src/personal_agent/media_dedup.py
import hashlib
import json
from pathlib import Path
from datetime import datetime

class MediaDedupService:
    def __init__(self, vault_dir: Path):
        self.vault_dir = vault_dir
        self.index_file = vault_dir / "media_index.json"
        self.index = self._load_index()
    
    def _load_index(self) -> dict:
        """加载媒体索引"""
        if self.index_file.exists():
            return json.loads(self.index_file.read_text())
        return {"version": "1.0", "created": datetime.now().isoformat(), "media": {}}
    
    def _save_index(self):
        """保存媒体索引"""
        self.index_file.write_text(json.dumps(self.index, indent=2))
    
    def calculate_sha256(self, file_path: Path) -> str:
        """计算文件 SHA256"""
        sha256 = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                sha256.update(chunk)
        return sha256.hexdigest()
    
    def process_incoming_media(
        self,
        src_path: Path,
        inbox_note_path: Path,
        context: str = ""
    ) -> tuple[bool, str]:
        """
        处理新到达的媒体文件
        
        Returns:
            (is_duplicate, target_file_path)
        """
        sha256 = self.calculate_sha256(src_path)
        key = f"sha256:{sha256}"
        
        if key in self.index["media"]:
            # 重复图片：复用文件，新增引用
            media_entry = self.index["media"][key]
            media_entry["reference_count"] += 1
            media_entry["references"].append({
                "timestamp": datetime.now().isoformat(),
                "inbox_note": str(inbox_note_path.relative_to(self.vault_dir)),
                "context": context
            })
            self._save_index()
            return (True, media_entry["original_file"])
        else:
            # 新图片：存储文件，创建索引
            # 注意：文件复制由 inbox_sync.py 处理，这里只创建索引
            relative_path = str(src_path.relative_to(self.vault_dir))
            self.index["media"][key] = {
                "sha256": sha256,
                "first_seen": datetime.now().isoformat(),
                "original_file": relative_path,
                "reference_count": 1,
                "references": [{
                    "timestamp": datetime.now().isoformat(),
                    "inbox_note": str(inbox_note_path.relative_to(self.vault_dir)),
                    "context": context
                }]
            }
            self._save_index()
            return (False, relative_path)
```

### inbox_sync.py 修改点

```python
# 在 _copy_media_to_vault() 中增加：
from personal_agent.media_dedup import MediaDedupService

def _copy_media_to_vault(...) -> tuple[str, ...]:
    dedup_service = MediaDedupService(config.vault_dir)
    
    for ref in media_refs:
        # ... 解析 file_path ...
        
        # 检查是否重复
        is_duplicate, target_path = dedup_service.process_incoming_media(
            src_path=path_obj,
            inbox_note_path=note_path,
            context=user_text[:100]  # 前 100 字作为上下文
        )
        
        if is_duplicate:
            # 复用已有文件，不复制
            relative_path = target_path
        else:
            # 新文件，正常复制
            shutil.copy2(path_obj, dest_path)
            relative_path = f".media/{dest_name}"
```

---

## 📊 预期效果

### 存储效率

| 场景 | 当前 | 优化后 |
|------|------|--------|
| 100 张不同图片 | 100 份文件 | 100 份文件 |
| 50 张重复图片 (各发 2 次) | 100 份文件 | 50 份文件 + 引用计数 |
| 节省空间 | 0% | ~50% (重复场景) |

### 用户体验

| 场景 | 当前 | 优化后 |
|------|------|--------|
| 发重复图片 | 正常分析回复 | 正常分析回复（无提示） |
| 查询图片 | 多条相同结果 | 1 条结果 + 引用历史 |
| 知识库体积 | 包含重复文件 | 自动去重 |

---

## 🚀 实施计划

### 第一阶段：精确去重 (SHA256)

- [ ] 创建 `src/personal_agent/media_dedup.py`
- [ ] 修改 `src/personal_agent/inbox_sync.py`
- [ ] 测试：发送重复图片，验证索引更新
- [ ] 测试：验证文件不重复存储

### 第二阶段：相似图片检测 (pHash) - 可选

- [ ] 引入 `imagehash` 库
- [ ] 实现 pHash 计算
- [ ] 实现相似度检索
- [ ] 创建相似组关联

### 第三阶段：查询优化

- [ ] 优化 vault 查询界面
- [ ] 显示引用历史
- [ ] 显示相似图片组

---

## ⚠️ 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| 索引文件损坏 | 去重失效 | 每次启动时校验 JSON 格式，损坏则重建 |
| SHA256 碰撞 | 错误归并 | 概率极低 (2^-256)，可忽略 |
| 性能影响 | 响应延迟 | SHA256 计算 <50ms，异步处理 |
| 向后兼容 | 旧笔记无法关联 | 新逻辑只对新图片生效，旧图片保持原样 |

---

## 📝 测试计划

### 功能测试

1. **重复图片检测**
   - 发送同一张图片 2 次
   - 验证：`media_index.json` 中 `reference_count` = 2
   - 验证：`.media/` 目录只有 1 个文件

2. **新图片处理**
   - 发送新图片
   - 验证：索引中创建新条目
   - 验证：文件正常存储

3. **前台透明性**
   - 发送重复图片
   - 验证：回复内容正常，无"已发过"提示

### 回归测试

1. **现有功能**
   - 图片分析功能正常
   - inbox sync 正常
   - vault 查询正常

2. **性能测试**
   - 批量发送 100 张图片
   - 验证：响应时间 <2 秒

---

## 📚 参考资料

- [SHA-256 维基百科](https://en.wikipedia.org/wiki/SHA-2)
- [imagehash 库](https://github.com/JohannesBuchner/imagehash)
- 现有代码：`src/personal_agent/inbox_sync.py`

---

## 📅 更新日志

| 日期 | 版本 | 更新内容 |
|------|------|---------|
| 2026-05-10 | v0.1 | 初始设计方案 |

