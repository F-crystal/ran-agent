"""Controlled persona evolution for workspace bootstrap files."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path

from personal_agent.config import AppConfig
from personal_agent.reflection_specialist import ReflectionReport


IDENTITY_MARKER_BEGIN = "<!-- BEGIN AUTO-IDENTITY -->"
IDENTITY_MARKER_END = "<!-- END AUTO-IDENTITY -->"
SOUL_MARKER_BEGIN = "<!-- BEGIN AUTO-SOUL -->"
SOUL_MARKER_END = "<!-- END AUTO-SOUL -->"


@dataclass(frozen=True)
class PersonaProposal:
    generated_at: str
    summary_date: str
    reflection_report_path: str
    target_file: str
    rationale: tuple[str, ...]
    proposed_lines: tuple[str, ...]


@dataclass(frozen=True)
class PersonaEvolutionResult:
    proposal_json_path: Path
    proposal_markdown_path: Path
    identity_path: Path
    soul_path: Path


def evolve_persona_bootstrap(
    *,
    config: AppConfig,
    reflection_report: ReflectionReport,
    summary_date: str,
    logger,
) -> PersonaEvolutionResult | None:
    if not config.persona_evolution_enabled:
        return None

    identity_path = _resolve_workspace_path(config.base_dir, config.identity_path)
    soul_path = _resolve_workspace_path(config.base_dir, config.soul_path)
    proposals_dir = config.persona_proposals_dir
    proposals_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    identity_lines = _build_identity_lines(reflection_report)
    soul_lines = _build_soul_lines(reflection_report)

    identity_proposal = PersonaProposal(
        generated_at=generated_at,
        summary_date=summary_date,
        reflection_report_path=str(reflection_report.output_path),
        target_file=str(identity_path),
        rationale=_build_rationale(reflection_report),
        proposed_lines=identity_lines,
    )
    soul_proposal = PersonaProposal(
        generated_at=generated_at,
        summary_date=summary_date,
        reflection_report_path=str(reflection_report.output_path),
        target_file=str(soul_path),
        rationale=_build_rationale(reflection_report),
        proposed_lines=soul_lines,
    )

    proposal_payload = {
        "generated_at": generated_at,
        "summary_date": summary_date,
        "identity": asdict(identity_proposal),
        "soul": asdict(soul_proposal),
    }
    proposal_stem = f"persona_{summary_date}_{datetime.now().strftime('%H%M%S')}"
    proposal_json_path = proposals_dir / f"{proposal_stem}.json"
    proposal_markdown_path = proposals_dir / f"{proposal_stem}.md"
    proposal_json_path.write_text(json.dumps(proposal_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    proposal_markdown_path.write_text(_render_proposal_markdown(identity_proposal, soul_proposal), encoding="utf-8")

    _update_managed_block(
        identity_path,
        IDENTITY_MARKER_BEGIN,
        IDENTITY_MARKER_END,
        identity_lines,
        title="## Auto Evolution",
    )
    _update_managed_block(
        soul_path,
        SOUL_MARKER_BEGIN,
        SOUL_MARKER_END,
        soul_lines,
        title="## Auto Evolution",
    )

    logger.info(
        "persona evolution applied proposal=%s identity=%s soul=%s",
        proposal_json_path,
        identity_path,
        soul_path,
    )
    return PersonaEvolutionResult(
        proposal_json_path=proposal_json_path,
        proposal_markdown_path=proposal_markdown_path,
        identity_path=identity_path,
        soul_path=soul_path,
    )


def _resolve_workspace_path(base_dir: Path, path: Path) -> Path:
    return path if path.is_absolute() else base_dir / path


def _build_rationale(report: ReflectionReport) -> tuple[str, ...]:
    reasons = list(report.common_failure_patterns[:2])
    reasons.extend(report.continuity_or_mode_findings[:1])
    if not reasons:
        reasons.append("当前没有足够稳定的新模式，只保留保守的提示更新。")
    return tuple(reasons[:3])


def _build_identity_lines(report: ReflectionReport) -> tuple[str, ...]:
    dislikes = [item.label for item in report.preference_profile.stable_dislikes[:3]]
    risks = [item.label for item in report.preference_profile.contextual_risks[:2]]
    lines = ["- 近期稳定校准：继续保持自然、克制、有人味，不做流程播报。"]
    if dislikes:
        lines.append("- 当前更要避免：" + "；".join(dislikes))
    if risks:
        lines.append("- 当前高风险语境：" + "；".join(risks))
    return tuple(lines)


def _build_soul_lines(report: ReflectionReport) -> tuple[str, ...]:
    lines = ["- 近期学习重点：先接住当下，再解释；先自然回应，再给建议。"]
    if report.common_failure_patterns:
        lines.append("- 最近反复暴露的问题：" + "；".join(report.common_failure_patterns[:2]))
    if report.suggested_experiments:
        lines.append("- 下一阶段微调方向：" + "；".join(report.suggested_experiments[:2]))
    return tuple(lines)


def _update_managed_block(
    file_path: Path,
    marker_begin: str,
    marker_end: str,
    lines: tuple[str, ...],
    *,
    title: str,
) -> None:
    existing = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
    block = "\n".join([title, marker_begin, *lines, marker_end]).strip()

    if marker_begin in existing and marker_end in existing:
        before, remainder = existing.split(marker_begin, 1)
        _, after = remainder.split(marker_end, 1)
        before = _drop_existing_managed_title(before, title)
        updated = before.rstrip() + "\n\n" + block + after
    else:
        updated = existing.rstrip() + ("\n\n" if existing.strip() else "") + block + "\n"

    file_path.write_text(updated, encoding="utf-8")


def _drop_existing_managed_title(prefix: str, title: str) -> str:
    lines = prefix.rstrip().splitlines()
    if lines and lines[-1].strip() == title:
        return "\n".join(lines[:-1]).rstrip()
    return prefix


def _render_proposal_markdown(identity: PersonaProposal, soul: PersonaProposal) -> str:
    return "\n".join(
        [
            "# Persona Evolution Proposal",
            "",
            f"- generated_at: {identity.generated_at}",
            f"- summary_date: {identity.summary_date}",
            f"- reflection_report: {identity.reflection_report_path}",
            "",
            "## Identity",
            *identity.rationale,
            *identity.proposed_lines,
            "",
            "## Soul",
            *soul.rationale,
            *soul.proposed_lines,
            "",
        ]
    )
