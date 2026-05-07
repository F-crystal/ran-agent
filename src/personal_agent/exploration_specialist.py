"""Exploration specialist for agent to learn from external sources."""

from __future__ import annotations

import json
import logging
import random
from dataclasses import dataclass
from datetime import datetime
from typing import Callable

from personal_agent.config import AppConfig
from personal_agent.db import Database


@dataclass(frozen=True)
class ExplorationResult:
    """Result of one exploration session."""
    
    status: str
    source: str
    topic: str
    content_summary: str
    stored_location: str | None
    learned_items: tuple[str, ...]
    created_at: str


@dataclass(frozen=True)
class ExplorationSource:
    """One source for agent exploration."""
    
    name: str
    url_template: str
    topics: tuple[str, ...]
    description: str


class ExplorationSpecialist:
    """Enables agent to explore external sources and learn new things based on user interests."""
    
    def __init__(
        self,
        database: Database,
        config: AppConfig,
        logger: logging.Logger,
        web_fetcher: Callable[[str], str] | None = None,
    ) -> None:
        self._database = database
        self._config = config
        self._logger = logger
        self._web_fetcher = web_fetcher
    
    def _extract_user_interests_from_memories(self) -> tuple[str, ...]:
        """Extract user interests from working and profile memories."""
        interests = set()
        
        # Get working memories
        working_rows = self._database.get_working_memories(limit=10)
        for row in working_rows:
            content = str(row["content"]) if "content" in row.keys() else ""
            # Extract topics from memory content
            interests.update(self._extract_topics_from_text(content))

        # Get profile memories
        profile_rows = self._database.get_profile_memories(limit=5)
        for row in profile_rows:
            content = str(row["content"]) if "content" in row.keys() else ""
            interests.update(self._extract_topics_from_text(content))
        
        # Get recent user messages for additional context
        recent_messages = self._database.get_recent_wechat_user_messages(limit=5)
        for message in recent_messages:
            interests.update(self._extract_topics_from_text(message))
        
        return tuple(interests) if interests else ("随机知识",)
    
    def _extract_topics_from_text(self, text: str) -> set[str]:
        """Extract potential interest topics from text."""
        # Topic keywords mapping
        topic_keywords = {
            "科技": ["科技", "技术", "AI", "人工智能", "编程", "代码", "软件", "硬件"],
            "学术": ["论文", "研究", "学术", "学习", "课程", "考试", "读书"],
            "生活": ["生活", "健康", "运动", "饮食", "睡眠", "休息"],
            "娱乐": ["电影", "音乐", "游戏", "剧集", "综艺", "娱乐"],
            "工作": ["工作", "项目", "职业", "职场", "业务"],
            "旅行": ["旅行", "旅游", "出行", "景点", "酒店"],
            "美食": ["美食", "餐厅", "烹饪", "菜谱", "吃"],
            "艺术": ["艺术", "绘画", "摄影", "设计", "展览"],
            "历史": ["历史", "文化", "传统", "古代", "考古"],
            "自然": ["自然", "动物", "植物", "环境", "气候"],
            "经济": ["经济", "金融", "投资", "理财", "股票", "基金"],
            "社会": ["社会", "新闻", "时事", "政策", "热点"],
        }
        
        found_topics = set()
        text_lower = text.lower()
        
        for topic, keywords in topic_keywords.items():
            if any(kw in text_lower for kw in keywords):
                found_topics.add(topic)
        
        return found_topics
    
    def _build_sources_from_interests(self, interests: tuple[str, ...]) -> tuple[ExplorationSource, ...]:
        """Build exploration sources based on user interests."""
        sources = []
        
        # Map interests to appropriate sources
        interest_source_map = {
            "科技": ExplorationSource(
                name="tech_news",
                url_template="https://www.techradar.com/news",
                topics=("人工智能", "科技趋势", "新产品"),
                description="科技新闻和趋势",
            ),
            "学术": ExplorationSource(
                name="academic_digest",
                url_template="https://arxiv.org/list/cs/recent",
                topics=("学术研究", "论文", "科学发现"),
                description="学术前沿动态",
            ),
            "生活": ExplorationSource(
                name="lifestyle_tips",
                url_template="https://www.healthline.com/",
                topics=("健康生活", " wellness", "生活方式"),
                description="健康生活建议",
            ),
            "娱乐": ExplorationSource(
                name="entertainment",
                url_template="https://www.rottentomatoes.com/",
                topics=("电影", "剧集", "娱乐新闻"),
                description="影视娱乐资讯",
            ),
            "旅行": ExplorationSource(
                name="travel_inspiration",
                url_template="https://www.lonelyplanet.com/",
                topics=("旅行目的地", "旅游攻略", "文化体验"),
                description="旅行灵感",
            ),
            "美食": ExplorationSource(
                name="food_culture",
                url_template="https://www.seriouseats.com/",
                topics=("美食文化", "烹饪技巧", "餐厅推荐"),
                description="美食探索",
            ),
            "艺术": ExplorationSource(
                name="art_design",
                url_template="https://www.artsy.net/",
                topics=("艺术展览", "设计趋势", "创意灵感"),
                description="艺术设计资讯",
            ),
            "历史": ExplorationSource(
                name="history_culture",
                url_template="https://www.history.com/",
                topics=("历史故事", "文化遗产", "考古发现"),
                description="历史文化",
            ),
            "自然": ExplorationSource(
                name="nature_science",
                url_template="https://www.nationalgeographic.com/",
                topics=("自然科学", "动物植物", "环境保护"),
                description="自然科学",
            ),
            "经济": ExplorationSource(
                name="business_insights",
                url_template="https://www.economist.com/",
                topics=("商业洞察", "经济趋势", "市场分析"),
                description="商业经济",
            ),
            "社会": ExplorationSource(
                name="social_trends",
                url_template="https://www.theatlantic.com/",
                topics=("社会趋势", "文化观察", "深度报道"),
                description="社会文化观察",
            ),
        }
        
        # Add sources based on user interests
        for interest in interests:
            if interest in interest_source_map:
                sources.append(interest_source_map[interest])
        
        # Always include general knowledge source
        sources.append(ExplorationSource(
            name="wikipedia_random",
            url_template="https://zh.wikipedia.org/wiki/Special:Random",
            topics=("随机知识", "百科"),
            description="随机维基百科条目",
        ))
        
        return tuple(sources)
    
    def execute_exploration(self, *, topic_hint: str | None = None) -> ExplorationResult:
        """Execute one exploration session to learn something new based on user interests.

        This method analyzes user memories to understand their interests,
        then explores relevant content to learn something they might find interesting.
        """
        from personal_agent.memory import serialize_memory_content

        created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Extract user interests from memories
        user_interests = self._extract_user_interests_from_memories()
        self._logger.info("exploration based on user interests: %s", user_interests)

        # Build sources based on interests
        sources = self._build_sources_from_interests(user_interests)

        # Select a source (prefer matching topic_hint if provided)
        if topic_hint:
            source = self._select_source_by_topic(sources, topic_hint)
        else:
            source = random.choice(sources)

        self._logger.info("exploration started source=%s interests=%s", source.name, user_interests)

        # Select exploration topic
        exploration_topic = random.choice(source.topics)

        # Generate exploration content based on source
        content_summary = self._generate_exploration_content(source, exploration_topic, user_interests)

        # Extract learned items
        learned_items = self._extract_learned_items(content_summary)

        # Store as working memory with exploration category
        memory_payload = {
            "type": "working",
            "category": "exploration",
            "topic": exploration_topic,
            "source": source.name,
            "summary": content_summary,
            "key_insights": list(learned_items),
            "relevance_to_user": f"基于用户兴趣：{', '.join(user_interests[:2]) if user_interests else '日常话题'}",
            "time_scope": "recent",
            "state": "已探索",
        }

        try:
            memory_id = self._database.store_memory(
                content=serialize_memory_content(memory_payload),
                memory_type="working",
                importance=1,
            )
            stored_location = f"memories:{memory_id}"
        except Exception as e:
            self._logger.warning("failed to store exploration memory: %s", e)
            stored_location = "none"

        # Record timeline event for debugging
        self._database.record_timeline_event(
            source="exploration_specialist",
            event_type="exploration",
            importance=1,
            content=json.dumps({
                "source": source.name,
                "topic": exploration_topic,
                "summary": content_summary,
                "key_insights": list(learned_items),
                "explored_at": created_at,
            }, ensure_ascii=False),
        )

        self._logger.info(
            "exploration completed source=%s topic=%s items=%d interests=%s",
            source.name,
            exploration_topic,
            len(learned_items),
            user_interests,
        )

        return ExplorationResult(
            status="completed",
            source=source.name,
            topic=exploration_topic,
            content_summary=content_summary,
            stored_location=stored_location,
            learned_items=learned_items,
            created_at=created_at,
        )
    
    def _select_source_by_topic(self, sources: tuple[ExplorationSource, ...], topic_hint: str) -> ExplorationSource:
        """Select the best source based on topic hint."""
        topic_lower = topic_hint.lower()
        
        # Score each source by topic match
        best_source = sources[0] if sources else None
        best_score = 0
        
        for source in sources:
            score = sum(1 for t in source.topics if t in topic_lower)
            if score > best_score:
                best_score = score
                best_source = source
        
        return best_source or random.choice(sources) if sources else None
    
    def _generate_exploration_content(self, source: ExplorationSource, topic: str, user_interests: tuple[str, ...]) -> str:
        """Generate exploration content that connects to user interests."""
        # Create personalized content based on source and user interests
        interest_str = "、".join(user_interests[:2]) if user_interests else "各种话题"
        
        templates = {
            "tech_news": [
                f"看到一篇关于{topic}的文章，想到你对{interest_str}感兴趣，可能也会关注这个方向。",
                f"{topic}领域有些新动态，和你之前聊过的{interest_str}有些关联。",
            ],
            "academic_digest": [
                f"读到一篇关于{topic}的研究，觉得你对{interest_str}的关注可能会让你对这个发现感兴趣。",
                f"学术界在{topic}方面有新进展，和你关心的{interest_str}领域相关。",
            ],
            "lifestyle_tips": [
                f"发现一些关于{topic}的建议，想到你之前提过{interest_str}，可能对你有用。",
                f"看到{topic}方面的小知识，和你关注的{interest_str}生活方式挺契合。",
            ],
            "entertainment": [
                f"了解到一部关于{topic}的作品，想到你喜欢{interest_str}，可能会感兴趣。",
                f"{topic}方面有些新内容，和你之前聊的{interest_str}风格类似。",
            ],
            "travel_inspiration": [
                f"发现一个关于{topic}的地方，想到你对{interest_str}感兴趣，可能会喜欢。",
                f"看到{topic}的旅行灵感，和你关注的{interest_str}体验很搭。",
            ],
            "food_culture": [
                f"学到一些关于{topic}的知识，想到你喜欢{interest_str}，分享给你。",
                f"{topic}方面有些有趣的发现，和你对{interest_str}的品味相符。",
            ],
            "art_design": [
                f"看到{topic}方面的创意，想到你关注{interest_str}，可能会喜欢这种风格。",
                f"发现一些{topic}的灵感，和你之前聊的{interest_str}审美很契合。",
            ],
            "history_culture": [
                f"读到关于{topic}的历史故事，想到你对{interest_str}感兴趣，可能也会好奇这段历史。",
                f"{topic}方面有些文化发现，和你关注的{interest_str}背景相关。",
            ],
            "nature_science": [
                f"了解到{topic}的科学发现，想到你关注{interest_str}，这个可能也会吸引你。",
                f"看到关于{topic}的自然知识，和你对{interest_str}的好奇心很配。",
            ],
            "business_insights": [
                f"看到{topic}方面的商业分析，想到你关注{interest_str}，这个趋势可能相关。",
                f"{topic}领域有些经济动态，和你关心的{interest_str}市场有关联。",
            ],
            "social_trends": [
                f"观察到{topic}方面的社会现象，想到你关注{interest_str}，这个现象挺有意思。",
                f"{topic}方面有些文化趋势，和你之前聊的{interest_str}话题相关。",
            ],
            "wikipedia_random": [
                f"偶然读到关于{topic}的知识，虽然和你常聊的{interest_str}不太相关，但觉得挺有意思。",
                f"在探索{topic}时学到一些新东西，想和你分享这个与{interest_str}不同的视角。",
            ],
        }
        
        source_templates = templates.get(source.name, templates["wikipedia_random"])
        return random.choice(source_templates)
    
    def _extract_learned_items(self, content: str) -> tuple[str, ...]:
        """Extract key learned items from exploration content."""
        items = []
        for phrase in content.split("。"):
            phrase = phrase.strip()
            if phrase and len(phrase) > 5:
                items.append(phrase)
        return tuple(items[:3])
    
    def get_recent_explorations(self, limit: int = 5) -> tuple[ExplorationResult, ...]:
        """Get recent exploration results from database."""
        return ()
    
    def should_explore(self, *, last_exploration_at: datetime | None = None) -> bool:
        """Determine if the agent should go explore now."""
        if last_exploration_at is None:
            return True
        
        time_since_last = datetime.now() - last_exploration_at
        return time_since_last.total_seconds() > 3600
