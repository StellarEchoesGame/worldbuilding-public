"""WB-C1 v1.3 judgment rules as code: sub-question states → instance grade →
question grade → dimension grade → cross-round synthesis → final conclusion.

Encodes PROTOCOL.md §2.2 (instance), §2.3 (dimension), §5.5 (rounds and the
problem ledger) and §2.7 (final conclusion). It judges nothing by itself:
states, failure facts, caps and ledger statuses are registered by judges and
the coordinator from evidence, after the §5.5 reconciliation.

Registration contract: callers register hard-failure codes and triggered
special failure clauses in ``Instance.failure_facts``; a missing ★ sub-question
is derived here as ``"★<name> 缺失"`` and an identical caller entry is collapsed.
F0 is registered on the question through ``judge_question``.
Round grades passed to ``synthesize_rounds`` must already be recomputed without
withdrawn facts (§5.5 跨轮维度合成)."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from fractions import Fraction
from typing import Iterable, Mapping


class State(Enum):
    SUPPORTED = "有据"
    BLANK = "留白"
    MISSING = "缺失"
    LAYER_UNRESOLVED = "层级未决"
    UNCHECKED = "未检"


class Grade(Enum):
    PASS = "通过"
    CONDITIONAL = "有条件通过"
    INSUFFICIENT = "证据不足"
    FAIL = "失败"


SEVERITY: dict[Grade, int] = {Grade.PASS: 0, Grade.CONDITIONAL: 1, Grade.INSUFFICIENT: 2, Grade.FAIL: 3}


class FactKind(Enum):
    FAILURE = "失败事实"
    FINDING = "非失败发现"


class FactStatus(Enum):
    MAINTAINED = "维持"
    WITHDRAWN = "撤销"
    DISPUTED = "争议"
    UNDECIDED = "无法裁定"


class Conclusion(Enum):
    NOT_EXECUTED = "未执行"
    STRUCTURAL = "结构改稿"
    TARGETED = "定点改稿"
    UNDECIDABLE = "本轮无法判断"
    RELEASE_WITH_REVISIONS = "附修订放行"
    RELEASE = "放行"


@dataclass(frozen=True)
class SubQuestion:
    name: str
    state: State
    starred: bool = False


@dataclass(frozen=True)
class Instance:
    question: str
    subquestions: tuple[SubQuestion, ...]
    failure_facts: tuple[str, ...] = ()
    conditional_caps: tuple[str, ...] = ()


@dataclass(frozen=True)
class Judgment:
    grade: Grade
    step: int
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class LedgerFact:
    """One row of the §5.5 problem ledger after R2 check and (if any) R3."""
    fact_id: str
    kind: FactKind
    status: FactStatus


@dataclass(frozen=True)
class RoundResult:
    grade: Grade | None
    pending_r3: bool
    note: str


@dataclass(frozen=True)
class Flags:
    """Inputs to §2.7 beyond the nine dimension grades. Every boolean means
    "confirmed with final ledger status 维持" (§2.7 ED22); ``f0_questions`` lists
    the questions on which a maintained F0 is registered (§2.5 mapping).
    ``dangling_rate_lower_by_round`` lists the lower bound of each round whose
    rate is applicable (§1.5 第 3 条); omit 不适用 rounds, empty = never triggers."""
    formal_prerequisites_met: bool
    d6_failed_by_f5: bool
    t01_law_f1: bool
    f0_questions: tuple[str, ...]
    dangling_rate_lower_by_round: tuple[Fraction, ...]


DIMENSIONS: tuple[str, ...] = tuple(f"D{i}" for i in range(1, 10))
QUESTION_DIMENSION: dict[str, str] = {
    "T01": "D1", "T12": "D1", "T02": "D2", "T03": "D3", "T04": "D4", "T05": "D5",
    "T06": "D6", "T07": "D6", "T09": "D7", "T08": "D8", "T13": "D8", "T10": "D9", "T11": "D9",
}
COUNTING_QUESTIONS: frozenset[str] = frozenset({"T09"})
# §2.2 封顶类 special clauses, registered under exactly these names.
CAP_CLAUSES: dict[str, frozenset[str]] = {
    "T04": frozenset({"F4a 风险筛查触发"}),
    "T08": frozenset({"模糊无界超过半数"}),
    "T10": frozenset({"未标明超过半数"}),
    "T11": frozenset({"遗漏T01的法则"}),
}
CAP_QUESTIONS: frozenset[str] = frozenset(CAP_CLAUSES)
DANGLING_THRESHOLD = Fraction(30, 100)


def worst(grades: Iterable[Grade]) -> Grade:
    items = list(grades)
    if not items:
        raise ValueError("no grades to compare")
    return max(items, key=lambda g: SEVERITY[g])


def _validate(inst: Instance) -> None:
    if inst.question not in QUESTION_DIMENSION:
        raise ValueError(f"unknown question code {inst.question!r}; expected one of {sorted(QUESTION_DIMENSION)}")
    if not inst.subquestions:
        raise ValueError(f"{inst.question}: an instance needs at least one sub-question")
    if inst.question in COUNTING_QUESTIONS and len(inst.subquestions) != 3:
        raise ValueError(f"{inst.question}: the counting rule needs exactly three sub-questions")
    if inst.conditional_caps and inst.question not in CAP_QUESTIONS:
        raise ValueError(f"{inst.question}: only {sorted(CAP_QUESTIONS)} have 封顶类 special clauses (§2.2)")
    for cap in inst.conditional_caps:
        if cap not in CAP_CLAUSES.get(inst.question, frozenset()):
            raise ValueError(f"{inst.question}: unknown 封顶类 clause {cap!r}; expected one of {sorted(CAP_CLAUSES.get(inst.question, ()))}")
    for sq in inst.subquestions:
        if sq.starred and sq.state is State.BLANK:
            raise ValueError(f"{inst.question} {sq.name}: ★子问不接受留白，查完仍为留白应登记为缺失")


def _failure_facts(inst: Instance) -> list[str]:
    derived = [f"★{sq.name} 缺失" for sq in inst.subquestions if sq.starred and sq.state is State.MISSING]
    registered = [f for f in inst.failure_facts if f not in derived]
    return list(dict.fromkeys(registered + derived))


def _counting_rule(inst: Instance, notes: list[str]) -> Grade:
    states = [sq.state for sq in inst.subquestions]
    supported = sum(s is State.SUPPORTED for s in states)
    checked = all(s is not State.UNCHECKED for s in states)
    unchecked = [sq.name for sq in inst.subquestions if sq.state is State.UNCHECKED]
    if supported >= 2:
        if unchecked:
            notes.append("含未检: " + ", ".join(unchecked))
        return Grade.PASS
    if supported == 1 and checked:
        return Grade.CONDITIONAL
    if supported == 0 and checked:
        return Grade.FAIL
    return Grade.INSUFFICIENT


def _general_rule(inst: Instance, notes: list[str]) -> Grade:
    if any(sq.state is State.LAYER_UNRESOLVED for sq in inst.subquestions):
        return Grade.CONDITIONAL
    non_star = [sq for sq in inst.subquestions if not sq.starred]
    if any(sq.state is State.MISSING for sq in non_star):
        return Grade.CONDITIONAL
    if any(sq.state is State.UNCHECKED for sq in non_star):
        if not inst.conditional_caps:
            notes.append("含未检非★，上限可能为通过")
        return Grade.CONDITIONAL
    return Grade.PASS


def judge_instance(inst: Instance) -> Judgment:
    """§2.2: register failure facts, then take the first matching step."""
    _validate(inst)
    notes: list[str] = []
    facts = _failure_facts(inst)
    unchecked_all = [sq.name for sq in inst.subquestions if sq.state is State.UNCHECKED]
    if facts:
        notes.extend(facts)
        notes.extend(f"{n} 未检" for n in unchecked_all)
        return Judgment(Grade.FAIL, 1, tuple(notes))
    if any(sq.starred and sq.state is State.UNCHECKED for sq in inst.subquestions):
        return Judgment(Grade.INSUFFICIENT, 2, tuple(notes))
    if inst.question in COUNTING_QUESTIONS:
        grade, step = _counting_rule(inst, notes), 3
    else:
        grade, step = _general_rule(inst, notes), 4
    if inst.conditional_caps and SEVERITY[grade] < SEVERITY[Grade.CONDITIONAL]:
        notes.append("专用条款封顶: " + "; ".join(inst.conditional_caps))
        grade = Grade.CONDITIONAL
    if any(sq.state is State.LAYER_UNRESOLVED for sq in inst.subquestions) and SEVERITY[grade] < SEVERITY[Grade.CONDITIONAL]:
        notes.append("层级未决封顶")
        grade, step = Grade.CONDITIONAL, 5
    return Judgment(grade, step, tuple(notes))


def judge_question(instances: Iterable[Instance], question_failure_facts: Iterable[str] = ()) -> Grade:
    """§2.2 题目档位: worst instance. ``question_failure_facts`` holds failure facts
    registered on the question itself (F0 via the §2.5 mapping) and forces 失败; a
    question with no facts and no judgeable instance (§3.3 未检) is 证据不足."""
    if list(question_failure_facts):
        return Grade.FAIL
    grades = [judge_instance(i).grade for i in instances]
    return worst(grades) if grades else Grade.INSUFFICIENT


def synthesize_dimension(grades: Iterable[Grade]) -> Grade:
    """§2.3: 失败 > 证据不足 > 有条件通过 > 通过."""
    return worst(grades)


def synthesize_rounds(r1: Grade, r2: Grade, facts: Iterable[LedgerFact]) -> RoundResult:
    """§5.5 跨轮维度合成 over the problem ledger of one dimension."""
    ledger = list(facts)
    ids = lambda kind, status: [f.fact_id for f in ledger if f.kind is kind and f.status is status]
    if disputed := [f.fact_id for f in ledger if f.status is FactStatus.DISPUTED]:
        return RoundResult(None, True, "争议事实待R3裁定: " + ", ".join(disputed))
    if kept := ids(FactKind.FAILURE, FactStatus.MAINTAINED):
        return RoundResult(Grade.FAIL, False, "维持的失败事实: " + ", ".join(kept))
    if undecided := ids(FactKind.FAILURE, FactStatus.UNDECIDED):
        return RoundResult(Grade.INSUFFICIENT, False, "证据不足（不稳定）: R3无法裁定 " + ", ".join(undecided))
    usable = [g for g in (r1, r2) if g is not Grade.INSUFFICIENT]
    if not usable:
        return RoundResult(Grade.INSUFFICIENT, False, "两轮均证据不足")
    persistent = ids(FactKind.FINDING, FactStatus.MAINTAINED) + ids(FactKind.FINDING, FactStatus.UNDECIDED)
    grade = worst(usable + ([Grade.CONDITIONAL] if persistent else []))
    note = "单轮定档" if len(usable) == 1 else "两轮合成"
    if persistent:
        note += "; 持久发现: " + ", ".join(persistent)
    return RoundResult(grade, False, note)


def _validate_conclusion_inputs(dimensions: Mapping[str, Grade], flags: Flags) -> None:
    if set(dimensions) != set(DIMENSIONS):
        raise ValueError("dimensions must be exactly D1–D9, got: " + ", ".join(sorted(dimensions)))
    failed = {d for d in DIMENSIONS if dimensions[d] is Grade.FAIL}
    if flags.t01_law_f1 and "D1" not in failed:
        raise ValueError("t01_law_f1 requires D1 to be 失败")
    if flags.d6_failed_by_f5 and "D6" not in failed:
        raise ValueError("d6_failed_by_f5 requires D6 to be 失败")
    for q in flags.f0_questions:
        if q not in QUESTION_DIMENSION:
            raise ValueError(f"f0_questions: unknown question {q}")
        if QUESTION_DIMENSION[q] not in failed:
            raise ValueError(f"F0 registered on {q} requires {QUESTION_DIMENSION[q]} to be 失败")
    for rate in flags.dangling_rate_lower_by_round:
        if not 0 <= rate <= 1:
            raise ValueError(f"dangling rate lower bound out of [0, 1]: {rate}")


def final_conclusion(dimensions: Mapping[str, Grade], flags: Flags) -> Conclusion:
    """§2.7: mutually exclusive, first matching wins; counted in dimensions."""
    _validate_conclusion_inputs(dimensions, flags)
    if not flags.formal_prerequisites_met:
        return Conclusion.NOT_EXECUTED
    failed = {d for d in DIMENSIONS if dimensions[d] is Grade.FAIL}
    if {"D3", "D4"} & failed or flags.d6_failed_by_f5 or flags.t01_law_f1 or flags.f0_questions:
        return Conclusion.STRUCTURAL
    dangling_triggered = bool(flags.dangling_rate_lower_by_round) and max(flags.dangling_rate_lower_by_round) > DANGLING_THRESHOLD
    if failed or dangling_triggered:
        return Conclusion.TARGETED
    insufficient = sum(dimensions[d] is Grade.INSUFFICIENT for d in DIMENSIONS)
    if insufficient >= 3:
        return Conclusion.UNDECIDABLE
    if insufficient or any(dimensions[d] is Grade.CONDITIONAL for d in DIMENSIONS):
        return Conclusion.RELEASE_WITH_REVISIONS
    return Conclusion.RELEASE
