"""Offline preference-learning reflection for reply quality and user-specific dislikes."""

from __future__ import annotations

import json
import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.db import Database


@dataclass(frozen=True)
class ReflectionMetrics:
    """Compact metrics used for lightweight reply-quality reflection."""

    total_samples: int
    reviewer_trigger_rate: float
    first_pass_success_rate: float
    retry_success_rate: float
    average_retry_per_turn: float
    triggered_count: int
    retry_count: int
    retry_success_count: int
    rule_counts: dict[str, int]


@dataclass(frozen=True)
class PreferenceSignals:
    """Candidate dislike patterns learned from offline observation."""

    disliked_openings: tuple[str, ...]
    disliked_inference_patterns: tuple[str, ...]
    disliked_explanatory_tone: tuple[str, ...]
    disliked_fake_intimacy_patterns: tuple[str, ...]
    casual_advisory_patterns: tuple[str, ...]
    contextual_risk_patterns: tuple[str, ...]


@dataclass(frozen=True)
class PreferencePattern:
    """One low-noise preference item derived from repeated offline signals."""

    key: str
    label: str
    kind: str
    evidence_count: int
    contexts: tuple[str, ...]
    signals: tuple[str, ...]
    last_seen: str


@dataclass(frozen=True)
class PreferenceProfile:
    """Canonical machine-readable preference summary for future adaptive layers."""

    version: int
    updated_at: str
    sample_window: dict[str, int]
    stable_dislikes: tuple[PreferencePattern, ...]
    contextual_risks: tuple[PreferencePattern, ...]
    emerging_patterns: tuple[PreferencePattern, ...]
    json_path: Path
    markdown_path: Path | None


@dataclass(frozen=True)
class ReflectionReport:
    """Structured offline reflection output plus its written file path."""

    metrics: ReflectionMetrics
    top_rules: tuple[tuple[str, int], ...]
    common_failure_patterns: tuple[str, ...]
    possible_false_positive_rules: tuple[str, ...]
    continuity_or_mode_findings: tuple[str, ...]
    preference_signals: PreferenceSignals
    preference_profile: PreferenceProfile
    suggested_experiments: tuple[str, ...]
    report_text: str
    output_path: Path


class ReflectionSpecialist:
    """Low-frequency sidecar that learns failure and preference patterns from logs."""

    def __init__(
        self,
        database: Database,
        config: AppConfig,
        logger: logging.Logger,
    ) -> None:
        self._database = database
        self._config = config
        self._logger = logger

    def execute_background_work(self, *, sample_limit: int | None = None) -> dict[str, object]:
        """Execute background reflection work when opportunity is judged as silent.
        
        This method performs reflection without generating user-facing output.
        It updates internal state and stores insights for future use.
        Importantly, it updates preference_profile.json so Hermes can learn from it.
        """
        limit = sample_limit or self._config.self_reflection_sample_limit
        
        # Get recent observations for analysis
        rows = self._database.get_recent_reply_review_observations(limit=limit)
        if not rows:
            return {"status": "skipped", "reason": "no_observations_available"}
        
        # Build metrics and identify patterns
        metrics = _build_metrics(rows)
        
        # Build preference signals and profile (this updates preference_profile.json!)
        preference_signals = _build_preference_signals(rows, metrics.rule_counts)
        preference_profile = _build_preference_profile(rows, preference_signals, self._config)
        
        # Store reflection summary in database for future reference
        reflection_summary = {
            "total_samples": metrics.total_samples,
            "triggered_count": metrics.triggered_count,
            "retry_count": metrics.retry_count,
            "retry_success_count": metrics.retry_success_count,
            "first_pass_success_rate": metrics.first_pass_success_rate,
            "top_rules": sorted(metrics.rule_counts.items(), key=lambda x: (-x[1], x[0]))[:3],
            "stable_dislikes": list(preference_signals.disliked_openings)[:5],
        }
        
        # Store in database as a reflection event
        self._database.record_timeline_event(
            source="reflection_specialist",
            event_type="background_reflection",
            importance=1,
            content=json.dumps(reflection_summary, ensure_ascii=False),
        )
        
        self._logger.info(
            "reflection background work completed samples=%d first_pass_rate=%.1f%% dislikes=%d",
            metrics.total_samples,
            metrics.first_pass_success_rate * 100,
            len(preference_signals.disliked_openings),
        )
        
        return {
            "status": "completed",
            "samples_analyzed": metrics.total_samples,
            "first_pass_rate": metrics.first_pass_success_rate,
            "reflection_summary": reflection_summary,
            "preference_profile_updated": str(preference_profile.json_path),
        }

    def generate_report(self, *, limit: int | None = None) -> ReflectionReport:
        """Analyze recent review observations and write one local reflection report."""

        sample_limit = limit or self._config.self_reflection_sample_limit
        rows = self._database.get_recent_reply_review_observations(limit=sample_limit)
        metrics = _build_metrics(rows)
        top_rules = tuple(sorted(metrics.rule_counts.items(), key=lambda item: (-item[1], item[0]))[:5])
        common_failure_patterns = _build_common_failure_patterns(rows, metrics.rule_counts)
        possible_false_positive_rules = _build_false_positive_findings(rows, metrics.rule_counts)
        continuity_or_mode_findings = _build_continuity_findings(rows, metrics.rule_counts)
        preference_signals = _build_preference_signals(rows, metrics.rule_counts)
        preference_profile = _build_preference_profile(rows, preference_signals, self._config)
        suggested_experiments = _build_suggested_experiments(metrics.rule_counts, preference_signals)
        report_text = _render_report(
            rows=rows,
            metrics=metrics,
            top_rules=top_rules,
            common_failure_patterns=common_failure_patterns,
            possible_false_positive_rules=possible_false_positive_rules,
            continuity_or_mode_findings=continuity_or_mode_findings,
            preference_signals=preference_signals,
            preference_profile=preference_profile,
            suggested_experiments=suggested_experiments,
        )
        output_path = _write_report(self._config.reflections_dir, report_text)
        return ReflectionReport(
            metrics=metrics,
            top_rules=top_rules,
            common_failure_patterns=common_failure_patterns,
            possible_false_positive_rules=possible_false_positive_rules,
            continuity_or_mode_findings=continuity_or_mode_findings,
            preference_signals=preference_signals,
            preference_profile=preference_profile,
            suggested_experiments=suggested_experiments,
            report_text=report_text,
            output_path=output_path,
        )


def generate_reflection_report(
    database: Database,
    config: AppConfig,
    logger: logging.Logger | None = None,
    *,
    limit: int | None = None,
) -> ReflectionReport:
    """Compatibility wrapper for generating one offline reflection report."""

    effective_logger = logger or logging.getLogger("personal_agent.reflection_specialist")
    return ReflectionSpecialist(database=database, config=config, logger=effective_logger).generate_report(limit=limit)


def _build_metrics(rows: list[object]) -> ReflectionMetrics:
    total_samples = len(rows)
    triggered_count = 0
    retry_count = 0
    retry_success_count = 0
    rule_counter: Counter[str] = Counter()

    for row in rows:
        if int(row["review_triggered"]):
            triggered_count += 1
        if int(row["retry_performed"]):
            retry_count += 1
        if int(row["retry_success"]):
            retry_success_count += 1
        for reason in _parse_reasons(str(row["review_reasons"])):
            rule_counter[reason] += 1

    if total_samples == 0:
        return ReflectionMetrics(
            total_samples=0,
            reviewer_trigger_rate=0.0,
            first_pass_success_rate=0.0,
            retry_success_rate=0.0,
            average_retry_per_turn=0.0,
            triggered_count=0,
            retry_count=0,
            retry_success_count=0,
            rule_counts={},
        )

    reviewer_trigger_rate = triggered_count / total_samples
    first_pass_success_rate = (total_samples - triggered_count) / total_samples
    retry_success_rate = (retry_success_count / retry_count) if retry_count else 0.0
    average_retry_per_turn = retry_count / total_samples
    return ReflectionMetrics(
        total_samples=total_samples,
        reviewer_trigger_rate=reviewer_trigger_rate,
        first_pass_success_rate=first_pass_success_rate,
        retry_success_rate=retry_success_rate,
        average_retry_per_turn=average_retry_per_turn,
        triggered_count=triggered_count,
        retry_count=retry_count,
        retry_success_count=retry_success_count,
        rule_counts=dict(rule_counter),
    )


def _build_common_failure_patterns(rows: list[object], rule_counts: dict[str, int]) -> tuple[str, ...]:
    patterns: list[str] = []
    if rule_counts.get("blacklisted_opening", 0):
        patterns.append("错误：首答仍会滑向模板化开场，说明起手控制仍不稳。")
    if rule_counts.get("off_topic", 0):
        patterns.append("错误：current_topic 或 continuity block 对首答的牵引还不够稳。")
    if rule_counts.get("recent_state_over_inference", 0):
        patterns.append("错误：即时状态场景下仍会过早推测长期原因。")
    if rule_counts.get("intimate_or_emotional_became_meta", 0):
        patterns.append("错误：情绪或亲密场景里，首答仍会掉回 meta / 分析腔。")
    if rule_counts.get("casual_became_advisory", 0):
        patterns.append("会烦：casual_chat 仍容易掉进建议/说明文体，虽然不一定是硬错误。")

    dissatisfaction_count = sum(int(row["user_dissatisfaction_signal"]) for row in rows)
    if dissatisfaction_count:
        patterns.append(f"已有 {dissatisfaction_count} 条样本带用户受挫信号，应优先作为偏好学习样本。")

    if not patterns:
        patterns.append("最近样本里没有明显高频失败模式，优先继续观察真实聊天。")
    return tuple(patterns)


def _build_false_positive_findings(rows: list[object], rule_counts: dict[str, int]) -> tuple[str, ...]:
    explicit_candidates = sum(int(row["false_positive_candidate"]) for row in rows)
    if explicit_candidates:
        return (f"已有 {explicit_candidates} 条样本被标记为潜在误杀，优先回看这些轮次。",)

    findings: list[str] = []
    if rule_counts.get("casual_became_advisory", 0):
        findings.append("`casual_became_advisory` 最可能误伤带轻微建议感、但仍自然的回复。")
    if rule_counts.get("off_topic", 0):
        findings.append("`off_topic` 需要继续观察是否会误伤自然换话题或半延续式聊天。")
    if not findings:
        findings.append("当前还没有稳定的误杀标记样本，暂时以人工抽查为主。")
    return tuple(findings)


def _build_continuity_findings(rows: list[object], rule_counts: dict[str, int]) -> tuple[str, ...]:
    findings: list[str] = []
    if rule_counts.get("off_topic", 0):
        findings.append("continuity prompt 对 current_topic 的牵引可能偏弱，或 off-topic 规则仍偏宽。")
    if rule_counts.get("casual_became_advisory", 0):
        findings.append("response_mode=casual_chat 的定义可能偏宽，导致普通聊天首答仍往解释型滑。")
    if rule_counts.get("intimate_or_emotional_became_meta", 0):
        findings.append("playful_flirty / emotional_support 的 mode 约束还不够稳。")
    if rule_counts.get("recent_state_over_inference", 0):
        findings.append("即时状态提示语仍需更明确，避免模型把当下感受推成长期原因。")

    dissatisfaction_count = sum(int(row["user_dissatisfaction_signal"]) for row in rows)
    if dissatisfaction_count:
        findings.append(f"已有 {dissatisfaction_count} 条样本带用户受挫信号，建议优先人工回看。")
    else:
        findings.append("用户不满意信号目前仍是轻量接口，尚不足以单独驱动规则调整。")
    return tuple(findings or ("continuity prompt 与 response mode 目前未出现明显高频失配。",))


def _build_preference_signals(rows: list[object], rule_counts: dict[str, int]) -> PreferenceSignals:
    opening_counter: Counter[str] = Counter()
    inference_counter: Counter[str] = Counter()
    explanatory_counter: Counter[str] = Counter()
    fake_intimacy_counter: Counter[str] = Counter()
    casual_advisory_counter: Counter[str] = Counter()
    contextual_counter: Counter[str] = Counter()

    for row in rows:
        reasons = set(_parse_reasons(str(row["review_reasons"])))
        first_draft = str(row["first_draft"]).strip()
        response_mode = str(row["response_mode"]).strip()
        time_of_day = str(row["time_of_day"]).strip()
        dissatisfaction = int(row["user_dissatisfaction_signal"]) == 1
        intimacy_level = int(row["intimacy_level"])

        if "blacklisted_opening" in reasons or dissatisfaction:
            opening = _extract_opening(first_draft)
            if opening:
                opening_counter[opening] += 1

        if "recent_state_over_inference" in reasons:
            inference_counter["刚表达即时状态时就推作息/压力/长期原因"] += 1
        elif dissatisfaction and _looks_causal_over_inference(first_draft):
            inference_counter["带因果判断的过早推断容易惹烦"] += 1

        if "casual_became_advisory" in reasons:
            casual_advisory_counter[_extract_advisory_pattern(first_draft)] += 1
            explanatory_counter["casual 场景中过强建议/说明腔"] += 1
        elif dissatisfaction and _looks_explanatory(first_draft):
            explanatory_counter["解释型或说明型首答容易让人烦"] += 1

        if "intimate_or_emotional_became_meta" in reasons:
            contextual_counter["情绪/亲密语境下掉回 meta 或分析腔"] += 1

        if _looks_fake_intimacy(first_draft) and (dissatisfaction or intimacy_level > 0):
            fake_intimacy_counter["模板化亲昵称呼或哄人话术风险较高"] += 1

        if time_of_day == "late_night" and (
            "recent_state_over_inference" in reasons or "intimate_or_emotional_became_meta" in reasons
        ):
            contextual_counter["深夜语境下过推断或掉回分析腔风险更高"] += 1

        if response_mode in {"emotional_support", "playful_flirty"} and _looks_explanatory(first_draft):
            contextual_counter["情绪/亲密场景中应避免解释欲过强"] += 1

    if rule_counts.get("intimate_or_emotional_became_meta", 0):
        fake_intimacy_counter.setdefault("亲密语境里，假亲近和解释腔都需要更保守", 0)

    return PreferenceSignals(
        disliked_openings=_top_patterns(opening_counter),
        disliked_inference_patterns=_top_patterns(inference_counter),
        disliked_explanatory_tone=_top_patterns(explanatory_counter),
        disliked_fake_intimacy_patterns=_top_patterns(fake_intimacy_counter),
        casual_advisory_patterns=_top_patterns(casual_advisory_counter),
        contextual_risk_patterns=_top_patterns(contextual_counter),
    )


def _build_suggested_experiments(
    rule_counts: dict[str, int],
    preference_signals: PreferenceSignals,
) -> tuple[str, ...]:
    suggestions: list[str] = []
    if preference_signals.disliked_openings:
        suggestions.append("先观察并微调首句起手约束，重点降低用户明显不喜欢的开场方式。")
    if preference_signals.disliked_inference_patterns:
        suggestions.append("优先加强‘先回应当下、后判断原因’的提示，但暂不新增静态黑名单。")
    if preference_signals.casual_advisory_patterns or rule_counts.get("casual_became_advisory", 0):
        suggestions.append("继续缩窄 casual 场景的建议/说明腔，但先以观察为主，不立刻加新 reviewer 规则。")
    if preference_signals.contextual_risk_patterns:
        suggestions.append("优先观察深夜、情绪、亲密语境里的高风险表达，再决定是否细调 continuity 或 mode 提示。")

    while len(suggestions) < 3:
        suggestions.append("继续积累真实聊天样本，优先学习用户会烦的模式，而不是继续堆静态规则。")
    return tuple(suggestions[:3])


def _render_report(
    *,
    rows: list[object],
    metrics: ReflectionMetrics,
    top_rules: tuple[tuple[str, int], ...],
    common_failure_patterns: tuple[str, ...],
    possible_false_positive_rules: tuple[str, ...],
    continuity_or_mode_findings: tuple[str, ...],
    preference_signals: PreferenceSignals,
    preference_profile: PreferenceProfile,
    suggested_experiments: tuple[str, ...],
) -> str:
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [
        "# Reflection Report",
        "",
        "## Scope",
        f"- generated_at: {generated_at}",
        f"- samples_analyzed: {len(rows)}",
        "- source: reply_review_observations",
        "- purpose: support manual tuning and future adaptive reviewer inputs",
        "- guarantee: advisory only, no automatic prompt or policy changes",
        "",
        "## Metrics",
        f"- reviewer_trigger_rate: {metrics.reviewer_trigger_rate:.2%}",
        f"- first_pass_success_rate: {metrics.first_pass_success_rate:.2%}",
        f"- retry_success_rate: {metrics.retry_success_rate:.2%}",
        f"- average_retry_per_turn: {metrics.average_retry_per_turn:.2f}",
        f"- reviewer_trigger_count: {metrics.triggered_count}",
        f"- retry_count: {metrics.retry_count}",
        f"- retry_success_count: {metrics.retry_success_count}",
        "",
        "## Reviewer Rule Counts",
    ]
    if metrics.rule_counts:
        for name, count in sorted(metrics.rule_counts.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"- {name}: {count}")
    else:
        lines.append("- no reviewer rule hits in sampled rows")

    lines.extend(["", "## Top Rules"])
    if top_rules:
        for name, count in top_rules:
            lines.append(f"- {name}: {count}")
    else:
        lines.append("- no top rules available")

    lines.extend(["", "## Failure Patterns"])
    for item in common_failure_patterns:
        lines.append(f"- {item}")
    for item in possible_false_positive_rules:
        lines.append(f"- 误杀风险：{item}")

    lines.extend(["", "## Preference Signals"])
    _append_signal_block(lines, "disliked openings", preference_signals.disliked_openings)
    _append_signal_block(lines, "disliked inference patterns", preference_signals.disliked_inference_patterns)
    _append_signal_block(lines, "disliked explanatory tone", preference_signals.disliked_explanatory_tone)
    _append_signal_block(lines, "disliked fake intimacy patterns", preference_signals.disliked_fake_intimacy_patterns)
    _append_signal_block(lines, "casual advisory patterns", preference_signals.casual_advisory_patterns)
    _append_signal_block(lines, "contextual risk patterns", preference_signals.contextual_risk_patterns)

    lines.extend(["", "## Preference Profile Snapshot"])
    lines.append(f"- json_path: {preference_profile.json_path}")
    if preference_profile.markdown_path is not None:
        lines.append(f"- markdown_path: {preference_profile.markdown_path}")
    lines.append(f"- stable_dislikes: {len(preference_profile.stable_dislikes)}")
    lines.append(f"- contextual_risks: {len(preference_profile.contextual_risks)}")
    lines.append(f"- emerging_patterns: {len(preference_profile.emerging_patterns)}")

    lines.extend(["", "## Continuity And Mode Findings"])
    for item in continuity_or_mode_findings:
        lines.append(f"- {item}")

    lines.extend(["", "## Suggested Experiments"])
    for item in suggested_experiments:
        lines.append(f"- {item}")

    return "\n".join(lines).strip() + "\n"


def _append_signal_block(lines: list[str], title: str, items: tuple[str, ...]) -> None:
    if not items:
        lines.append(f"- {title}: no stable signal yet")
        return
    lines.append(f"- {title}:")
    for item in items:
        lines.append(f"  - {item}")


def _write_report(reflections_dir: Path, report_text: str) -> Path:
    reflections_dir.mkdir(parents=True, exist_ok=True)
    filename = datetime.now().strftime("reflection_%Y%m%d_%H%M%S.md")
    output_path = reflections_dir / filename
    output_path.write_text(report_text, encoding="utf-8")
    return output_path


def _parse_reasons(raw_reasons: str) -> list[str]:
    try:
        parsed = json.loads(raw_reasons)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def _extract_opening(text: str) -> str:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return ""
    return normalized[:10]


def _extract_advisory_pattern(text: str) -> str:
    normalized = " ".join(text.split()).strip()
    if "你可以" in normalized:
        return "“你可以 …”式建议开头"
    if "建议" in normalized:
        return "“建议 …”式说明口吻"
    if "不妨" in normalized or "试着" in normalized:
        return "“不妨 / 试着 …”式轻建议"
    if "首先" in normalized or "其次" in normalized:
        return "分步骤说明口吻"
    return "泛化建议/说明腔"


def _looks_causal_over_inference(text: str) -> bool:
    markers = ("因为", "作息", "压力", "长期", "习惯", "这阵子", "最近都", "一直都")
    return any(marker in text for marker in markers)


def _looks_explanatory(text: str) -> bool:
    markers = ("你可以", "建议", "总结一下", "根据你的描述", "我来分析", "从这个角度", "首先")
    return any(marker in text for marker in markers)


def _looks_fake_intimacy(text: str) -> bool:
    markers = ("宝贝", "宝宝", "乖", "抱抱", "亲亲", "哄你")
    return any(marker in text for marker in markers)


def _top_patterns(counter: Counter[str], limit: int = 4) -> tuple[str, ...]:
    ranked = [(pattern, count) for pattern, count in counter.items() if pattern and count > 0]
    ranked.sort(key=lambda item: (-item[1], item[0]))
    return tuple(f"{pattern} ({count})" for pattern, count in ranked[:limit])


def _build_preference_profile(
    rows: list[object],
    preference_signals: PreferenceSignals,
    config: AppConfig,
) -> PreferenceProfile:
    updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    stable_dislikes: list[PreferencePattern] = []
    contextual_risks: list[PreferencePattern] = []
    emerging_patterns: list[PreferencePattern] = []

    pattern_records = _collect_preference_pattern_records(rows)
    for record in pattern_records:
        pattern = PreferencePattern(
            key=record["key"],
            label=record["label"],
            kind=record["kind"],
            evidence_count=record["evidence_count"],
            contexts=tuple(record["contexts"]),
            signals=tuple(record["signals"]),
            last_seen=record["last_seen"],
        )
        if record["category"] == "stable":
            stable_dislikes.append(pattern)
        elif record["category"] == "contextual":
            contextual_risks.append(pattern)
        else:
            emerging_patterns.append(pattern)

    json_path = config.data_dir / "preference_profile.json"
    markdown_path = config.reflections_dir / "preference_profile_latest.md"
    profile = PreferenceProfile(
        version=1,
        updated_at=updated_at,
        sample_window={
            "total_samples": len(rows),
            "reviewed_samples": sum(int(row["review_triggered"]) for row in rows),
            "dissatisfaction_samples": sum(int(row["user_dissatisfaction_signal"]) for row in rows),
        },
        stable_dislikes=tuple(stable_dislikes),
        contextual_risks=tuple(contextual_risks),
        emerging_patterns=tuple(emerging_patterns),
        json_path=json_path,
        markdown_path=markdown_path,
    )
    _write_preference_profile_json(profile)
    _write_preference_profile_markdown(profile, preference_signals)
    return profile


def _collect_preference_pattern_records(rows: list[object]) -> list[dict[str, object]]:
    counters: dict[str, dict[str, object]] = {}

    def record_pattern(
        *,
        key: str,
        label: str,
        kind: str,
        context: str,
        signal: str,
        last_seen: str,
        stable_weight: int = 0,
        contextual_only: bool = False,
    ) -> None:
        entry = counters.setdefault(
            key,
            {
                "key": key,
                "label": label,
                "kind": kind,
                "evidence_count": 0,
                "contexts": set(),
                "signals": set(),
                "last_seen": "",
                "stable_weight": 0,
                "contextual_only": contextual_only,
            },
        )
        entry["evidence_count"] = int(entry["evidence_count"]) + 1
        entry["contexts"].add(context)
        entry["signals"].add(signal)
        if stable_weight:
            entry["stable_weight"] = int(entry["stable_weight"]) + stable_weight
        if last_seen and str(last_seen) > str(entry["last_seen"]):
            entry["last_seen"] = last_seen
        if not contextual_only:
            entry["contextual_only"] = False

    for row in rows:
        reasons = set(_parse_reasons(str(row["review_reasons"])))
        first_draft = str(row["first_draft"]).strip()
        response_mode = str(row["response_mode"]).strip() or "unknown"
        time_of_day = str(row["time_of_day"]).strip() or "unknown"
        dissatisfaction = int(row["user_dissatisfaction_signal"]) == 1
        created_at = str(row["created_at"])

        if "blacklisted_opening" in reasons or dissatisfaction:
            opening = _extract_opening(first_draft)
            if opening:
                record_pattern(
                    key=f"opening:{opening}",
                    label=f"不喜欢以“{opening}”开头的回复",
                    kind="opening",
                    context=response_mode,
                    signal="user_dissatisfaction" if dissatisfaction else "blacklisted_opening",
                    last_seen=created_at,
                    stable_weight=1 if dissatisfaction else 0,
                )

        if "recent_state_over_inference" in reasons or (dissatisfaction and _looks_causal_over_inference(first_draft)):
            record_pattern(
                key="inference:immediate_state_over_inference",
                label="刚表达即时状态时就推作息、压力或长期原因",
                kind="inference",
                context=f"{response_mode}:{time_of_day}",
                signal="user_dissatisfaction" if dissatisfaction else "recent_state_over_inference",
                last_seen=created_at,
                stable_weight=1 if dissatisfaction else 0,
            )

        if "casual_became_advisory" in reasons or (dissatisfaction and _looks_explanatory(first_draft)):
            record_pattern(
                key=f"tone:{_extract_advisory_pattern(first_draft)}",
                label=_extract_advisory_pattern(first_draft),
                kind="explanatory_tone",
                context=response_mode,
                signal="user_dissatisfaction" if dissatisfaction else "casual_became_advisory",
                last_seen=created_at,
                stable_weight=1 if dissatisfaction else 0,
            )

        if _looks_fake_intimacy(first_draft) and dissatisfaction:
            record_pattern(
                key="intimacy:fake_intimacy_template",
                label="模板化亲昵称呼或哄人话术",
                kind="fake_intimacy",
                context=response_mode,
                signal="user_dissatisfaction",
                last_seen=created_at,
                stable_weight=1,
            )

        if "intimate_or_emotional_became_meta" in reasons:
            record_pattern(
                key="context:emotional_or_intimate_meta",
                label="情绪或亲密语境下掉回 meta / 分析腔",
                kind="contextual_risk",
                context=f"{response_mode}:{time_of_day}",
                signal="intimate_or_emotional_became_meta",
                last_seen=created_at,
                contextual_only=True,
            )

        if time_of_day == "late_night" and (
            "recent_state_over_inference" in reasons or "intimate_or_emotional_became_meta" in reasons
        ):
            record_pattern(
                key="context:late_night_over_inference",
                label="深夜语境下过推断或掉回分析腔",
                kind="contextual_risk",
                context=f"{response_mode}:late_night",
                signal="late_night",
                last_seen=created_at,
                contextual_only=True,
            )

    records: list[dict[str, object]] = []
    for entry in counters.values():
        evidence_count = int(entry["evidence_count"])
        stable_weight = int(entry["stable_weight"])
        contextual_only = bool(entry["contextual_only"])
        if contextual_only:
            category = "contextual"
        elif stable_weight >= 1 and evidence_count >= 2:
            category = "stable"
        else:
            category = "emerging"
        records.append(
            {
                "key": entry["key"],
                "label": entry["label"],
                "kind": entry["kind"],
                "evidence_count": evidence_count,
                "contexts": tuple(sorted(entry["contexts"])),
                "signals": tuple(sorted(entry["signals"])),
                "last_seen": entry["last_seen"] or "",
                "category": category,
            }
        )
    records.sort(key=lambda item: (-int(item["evidence_count"]), str(item["key"])))
    return records


def _write_preference_profile_json(profile: PreferenceProfile) -> None:
    profile.json_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": profile.version,
        "updated_at": profile.updated_at,
        "sample_window": profile.sample_window,
        "stable_dislikes": [_pattern_to_dict(item) for item in profile.stable_dislikes],
        "contextual_risks": [_pattern_to_dict(item) for item in profile.contextual_risks],
        "emerging_patterns": [_pattern_to_dict(item) for item in profile.emerging_patterns],
    }
    profile.json_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _write_preference_profile_markdown(
    profile: PreferenceProfile,
    preference_signals: PreferenceSignals,
) -> None:
    if profile.markdown_path is None:
        return
    profile.markdown_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Preference Profile",
        "",
        f"- updated_at: {profile.updated_at}",
        f"- total_samples: {profile.sample_window['total_samples']}",
        f"- reviewed_samples: {profile.sample_window['reviewed_samples']}",
        f"- dissatisfaction_samples: {profile.sample_window['dissatisfaction_samples']}",
        "",
        "## Stable Dislikes",
    ]
    _append_profile_patterns(lines, profile.stable_dislikes)
    lines.extend(["", "## Contextual Risks"])
    _append_profile_patterns(lines, profile.contextual_risks)
    lines.extend(["", "## Emerging Patterns"])
    _append_profile_patterns(lines, profile.emerging_patterns)
    lines.extend(["", "## Signal Snapshot"])
    _append_signal_block(lines, "disliked openings", preference_signals.disliked_openings)
    _append_signal_block(lines, "disliked inference patterns", preference_signals.disliked_inference_patterns)
    _append_signal_block(lines, "disliked explanatory tone", preference_signals.disliked_explanatory_tone)
    _append_signal_block(lines, "disliked fake intimacy patterns", preference_signals.disliked_fake_intimacy_patterns)
    _append_signal_block(lines, "casual advisory patterns", preference_signals.casual_advisory_patterns)
    _append_signal_block(lines, "contextual risk patterns", preference_signals.contextual_risk_patterns)
    profile.markdown_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def _pattern_to_dict(pattern: PreferencePattern) -> dict[str, object]:
    return {
        "key": pattern.key,
        "label": pattern.label,
        "kind": pattern.kind,
        "evidence_count": pattern.evidence_count,
        "contexts": list(pattern.contexts),
        "signals": list(pattern.signals),
        "last_seen": pattern.last_seen,
    }


def _append_profile_patterns(lines: list[str], patterns: tuple[PreferencePattern, ...]) -> None:
    if not patterns:
        lines.append("- none")
        return
    for pattern in patterns:
        lines.append(
            f"- {pattern.label} | key={pattern.key} | evidence={pattern.evidence_count} | contexts={', '.join(pattern.contexts)}"
        )
