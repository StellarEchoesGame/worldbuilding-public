"""Executable checks of the WB-C1 v1.3 judgment rules.

Tests named in PROTOCOL.md §8 reproduce its worked examples (Claude's own
v1.1 §9 / v1.2 §4 examples, or the v1.3 editorial cases); the rest pin the
boundaries of the same rules. No world text is judged."""
from fractions import Fraction
import unittest

import judgment
from judgment import Conclusion as C
from judgment import FactKind, FactStatus, Flags, Grade as G, Instance as Inst, LedgerFact, State as S, SubQuestion as Sub


def t02(cost: S, *, breakthrough: S = S.SUPPORTED, bearer: S = S.SUPPORTED, why: S = S.SUPPORTED, facts: tuple[str, ...] = ()) -> Inst:
    return Inst("T02", (Sub("突破", breakthrough, starred=True), Sub("代价", cost, starred=True), Sub("承担者", bearer), Sub("为何不能普遍使用", why)), failure_facts=facts)


def t09(*states: S) -> Inst:
    return Inst("T09", tuple(Sub(f"问{i + 1}", s) for i, s in enumerate(states)))


def flags(*, met: bool = True, f5: bool = False, t01: bool = False, f0: tuple[str, ...] = (), dangling: tuple[Fraction, ...] = ()) -> Flags:
    return Flags(formal_prerequisites_met=met, d6_failed_by_f5=f5, t01_law_f1=t01, f0_questions=f0, dangling_rate_lower_by_round=dangling)


def dims(**overrides: G) -> dict[str, G]:
    base = {f"D{i}": G.PASS for i in range(1, 10)}
    base.update(overrides)
    return base


def fact(fid: str, kind: FactKind, status: FactStatus) -> LedgerFact:
    return LedgerFact(fact_id=fid, kind=kind, status=status)


FAIL_K, FIND_K = FactKind.FAILURE, FactKind.FINDING
KEEP, DROP, DISP, UNDEC = FactStatus.MAINTAINED, FactStatus.WITHDRAWN, FactStatus.DISPUTED, FactStatus.UNDECIDED


class InstanceJudgment(unittest.TestCase):
    def test_v11_example_1_t09_two_supported_one_missing_passes(self) -> None:
        self.assertEqual(judgment.judge_instance(t09(S.SUPPORTED, S.SUPPORTED, S.MISSING)).grade, G.PASS)

    def test_v11_example_1prime_failure_fact_beats_unchecked(self) -> None:
        j = judgment.judge_instance(t02(S.MISSING, why=S.UNCHECKED))
        self.assertEqual(j.grade, G.FAIL)
        self.assertIn("为何不能普遍使用 未检", " ".join(j.notes))

    def test_v12_case_1_unchecked_star_is_insufficient(self) -> None:
        self.assertEqual(judgment.judge_instance(t02(S.UNCHECKED)).grade, G.INSUFFICIENT)

    def test_v12_case_2_star_missing_is_failure_without_explicit_fact(self) -> None:
        self.assertEqual(judgment.judge_instance(t02(S.MISSING, why=S.UNCHECKED)).grade, G.FAIL)

    def test_v12_case_3_t09_missing_third_does_not_lower(self) -> None:
        j = judgment.judge_instance(t09(S.SUPPORTED, S.SUPPORTED, S.MISSING))
        self.assertEqual((j.grade, j.step), (G.PASS, 3))

    def test_v12_case_4_special_clause_not_triggered_falls_back_to_general(self) -> None:
        inst = Inst("T06", (Sub("资源与制度差异", S.SUPPORTED, starred=True), Sub("差异原因", S.MISSING)))
        self.assertEqual((judgment.judge_instance(inst).grade, judgment.judge_instance(inst).step), (G.CONDITIONAL, 4))

    def test_t06_triggered_all_from_resources_is_failure_fact(self) -> None:
        inst = Inst("T06", (Sub("资源与制度差异", S.SUPPORTED, starred=True), Sub("差异原因", S.SUPPORTED)), failure_facts=("T06 全部由资源导出",))
        self.assertEqual(judgment.judge_instance(inst).grade, G.FAIL)

    def test_t09_one_supported_others_checked_is_conditional(self) -> None:
        self.assertEqual(judgment.judge_instance(t09(S.SUPPORTED, S.MISSING, S.MISSING)).grade, G.CONDITIONAL)

    def test_t09_zero_supported_all_checked_is_failure(self) -> None:
        self.assertEqual(judgment.judge_instance(t09(S.MISSING, S.MISSING, S.MISSING)).grade, G.FAIL)

    def test_t09_one_supported_one_unchecked_is_insufficient(self) -> None:
        self.assertEqual(judgment.judge_instance(t09(S.SUPPORTED, S.MISSING, S.UNCHECKED)).grade, G.INSUFFICIENT)

    def test_t09_two_supported_third_unchecked_passes_with_note(self) -> None:
        j = judgment.judge_instance(t09(S.SUPPORTED, S.SUPPORTED, S.UNCHECKED))
        self.assertEqual(j.grade, G.PASS)
        self.assertTrue(any("未检" in n for n in j.notes))

    def test_t09_requires_exactly_three_subquestions(self) -> None:
        with self.assertRaises(ValueError):
            judgment.judge_instance(t09(S.SUPPORTED, S.SUPPORTED))

    def test_layer_unresolved_caps_t09_at_conditional(self) -> None:
        j = judgment.judge_instance(t09(S.SUPPORTED, S.SUPPORTED, S.LAYER_UNRESOLVED))
        self.assertEqual((j.grade, j.step), (G.CONDITIONAL, 5))

    def test_star_layer_unresolved_is_conditional_at_step_4_without_upper_bound_note(self) -> None:
        j = judgment.judge_instance(t02(S.SUPPORTED, breakthrough=S.LAYER_UNRESOLVED))
        self.assertEqual((j.grade, j.step), (G.CONDITIONAL, 4))
        self.assertFalse(any("上限可能为通过" in n for n in j.notes))

    def test_editorial_non_star_blank_does_not_lower(self) -> None:
        self.assertEqual(judgment.judge_instance(t02(S.SUPPORTED, bearer=S.BLANK)).grade, G.PASS)

    def test_star_blank_is_rejected_at_registration(self) -> None:
        with self.assertRaises(ValueError):
            judgment.judge_instance(t02(S.BLANK))

    def test_empty_subquestions_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            judgment.judge_instance(Inst("T05", ()))

    def test_non_star_unchecked_rest_supported_is_conditional_with_upper_bound_note(self) -> None:
        j = judgment.judge_instance(t02(S.SUPPORTED, why=S.UNCHECKED))
        self.assertEqual(j.grade, G.CONDITIONAL)
        self.assertTrue(any("上限可能为通过" in n for n in j.notes))

    def test_non_star_unchecked_plus_cap_has_no_upper_bound_note(self) -> None:
        inst = Inst("T08", (Sub("归类", S.UNCHECKED),), conditional_caps=("模糊无界超过半数",))
        self.assertFalse(any("上限可能为通过" in n for n in judgment.judge_instance(inst).notes))

    def test_editorial_conditional_clause_caps_a_passing_instance(self) -> None:
        inst = Inst("T08", (Sub("归类", S.SUPPORTED),), conditional_caps=("模糊无界超过半数",))
        self.assertEqual(judgment.judge_instance(inst).grade, G.CONDITIONAL)

    def test_conditional_caps_are_rejected_on_questions_without_cap_clauses(self) -> None:
        for q in ("T02", "T09"):
            with self.assertRaises(ValueError):
                judgment.judge_instance(Inst(q, (Sub("a", S.SUPPORTED), Sub("b", S.SUPPORTED), Sub("c", S.SUPPORTED)), conditional_caps=("模糊无界超过半数",)))

    def test_cap_clause_must_belong_to_its_question(self) -> None:
        with self.assertRaises(ValueError):
            judgment.judge_instance(Inst("T04", (Sub("a", S.SUPPORTED),), conditional_caps=("not a real clause",)))
        with self.assertRaises(ValueError):
            judgment.judge_instance(Inst("T08", (Sub("归类", S.SUPPORTED),), conditional_caps=("遗漏T01的法则",)))

    def test_unknown_question_code_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            judgment.judge_instance(Inst("T9", (Sub("a", S.SUPPORTED), Sub("b", S.SUPPORTED), Sub("c", S.SUPPORTED))))

    def test_conditional_cap_never_raises_a_failure(self) -> None:
        inst = Inst("T11", (Sub("约束可追溯", S.MISSING, starred=True),), conditional_caps=("遗漏T01的法则",))
        self.assertEqual(judgment.judge_instance(inst).grade, G.FAIL)

    def test_caller_registered_star_missing_is_not_listed_twice(self) -> None:
        j = judgment.judge_instance(t02(S.MISSING, facts=("★代价 缺失",)))
        self.assertEqual(sum("代价" in n for n in j.notes), 1)

    def test_registered_hard_failure_code_is_kept_beside_derived_star_missing(self) -> None:
        j = judgment.judge_instance(t02(S.MISSING, facts=("F2 代价只有形容词",)))
        self.assertEqual(j.notes, ("F2 代价只有形容词", "★代价 缺失"))

    def test_two_non_star_unchecked_is_conditional(self) -> None:
        j = judgment.judge_instance(t02(S.SUPPORTED, bearer=S.UNCHECKED, why=S.UNCHECKED))
        self.assertEqual((j.grade, j.step), (G.CONDITIONAL, 4))

    def test_t01_without_references_passes(self) -> None:
        inst = Inst("T01", (Sub("约束", S.SUPPORTED, starred=True), Sub("各引用处是否遵守", S.BLANK)))
        self.assertEqual(judgment.judge_instance(inst), judgment.Judgment(G.PASS, 4))

    def test_question_takes_worst_instance(self) -> None:
        self.assertEqual(judgment.judge_question([t02(S.SUPPORTED), t02(S.SUPPORTED, bearer=S.MISSING)]), G.CONDITIONAL)

    def test_question_without_judgeable_instance_is_insufficient(self) -> None:
        self.assertEqual(judgment.judge_question([]), G.INSUFFICIENT)

    def test_question_level_failure_fact_fails_a_question_without_instances(self) -> None:
        self.assertEqual(judgment.judge_question([], question_failure_facts=("F0/技术",)), G.FAIL)

    def test_severity_order(self) -> None:
        self.assertEqual(judgment.worst([G.PASS, G.CONDITIONAL, G.INSUFFICIENT, G.FAIL]), G.FAIL)
        self.assertEqual(judgment.worst([G.PASS, G.CONDITIONAL, G.INSUFFICIENT]), G.INSUFFICIENT)
        self.assertEqual(judgment.worst([G.PASS, G.CONDITIONAL]), G.CONDITIONAL)


class DimensionSynthesis(unittest.TestCase):
    def test_any_fail_fails(self) -> None:
        self.assertEqual(judgment.synthesize_dimension([G.PASS, G.FAIL, G.INSUFFICIENT]), G.FAIL)

    def test_insufficient_before_conditional(self) -> None:
        self.assertEqual(judgment.synthesize_dimension([G.CONDITIONAL, G.INSUFFICIENT]), G.INSUFFICIENT)

    def test_all_pass(self) -> None:
        self.assertEqual(judgment.synthesize_dimension([G.PASS, G.PASS]), G.PASS)

    def test_empty_dimension_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            judgment.synthesize_dimension([])


class RoundSynthesis(unittest.TestCase):
    def test_v11_example_2_maintained_finding_takes_worst(self) -> None:
        r = judgment.synthesize_rounds(G.PASS, G.CONDITIONAL, [fact("Q1", FIND_K, KEEP)])
        self.assertEqual((r.grade, r.pending_r3), (G.CONDITIONAL, False))

    def test_v11_example_3_maintained_failure_survives_a_passing_r2(self) -> None:
        self.assertEqual(judgment.synthesize_rounds(G.FAIL, G.PASS, [fact("F1-XY", FAIL_K, KEEP)]).grade, G.FAIL)

    def test_v11_example_3_dispute_waits_for_r3(self) -> None:
        r = judgment.synthesize_rounds(G.FAIL, G.PASS, [fact("F1-XY", FAIL_K, DISP)])
        self.assertTrue(r.pending_r3)
        self.assertIsNone(r.grade)

    def test_v11_example_3_r3_cannot_decide_is_unstable_insufficient(self) -> None:
        r = judgment.synthesize_rounds(G.FAIL, G.PASS, [fact("F1-XY", FAIL_K, UNDEC)])
        self.assertEqual(r.grade, G.INSUFFICIENT)
        self.assertIn("不稳定", r.note)

    def test_maintained_failure_beats_another_undecided_failure(self) -> None:
        r = judgment.synthesize_rounds(G.FAIL, G.FAIL, [fact("A", FAIL_K, KEEP), fact("B", FAIL_K, UNDEC)])
        self.assertEqual(r.grade, G.FAIL)

    def test_r2_first_confirmed_failure_counts_like_any_maintained_fact(self) -> None:
        r = judgment.synthesize_rounds(G.FAIL, G.FAIL, [fact("X-from-R1", FAIL_K, UNDEC), fact("Y-from-R2", FAIL_K, KEEP)])
        self.assertEqual(r.grade, G.FAIL)

    def test_pending_dispute_blocks_even_with_maintained_failure_present(self) -> None:
        r = judgment.synthesize_rounds(G.FAIL, G.FAIL, [fact("A", FAIL_K, DISP), fact("B", FAIL_K, KEEP)])
        self.assertTrue(r.pending_r3)
        self.assertIsNone(r.grade)

    def test_undecided_non_failure_finding_still_counts_as_persistent(self) -> None:
        r = judgment.synthesize_rounds(G.PASS, G.PASS, [fact("gap", FIND_K, UNDEC)])
        self.assertEqual(r.grade, G.CONDITIONAL)

    def test_withdrawn_facts_do_not_count(self) -> None:
        r = judgment.synthesize_rounds(G.PASS, G.PASS, [fact("A", FAIL_K, DROP), fact("gap", FIND_K, DROP)])
        self.assertEqual(r.grade, G.PASS)

    def test_both_rounds_insufficient(self) -> None:
        self.assertEqual(judgment.synthesize_rounds(G.INSUFFICIENT, G.INSUFFICIENT, []).grade, G.INSUFFICIENT)

    def test_undecided_finding_with_one_insufficient_round_is_single_round_conditional(self) -> None:
        r = judgment.synthesize_rounds(G.INSUFFICIENT, G.PASS, [fact("gap", FIND_K, UNDEC)])
        self.assertEqual(r.grade, G.CONDITIONAL)
        self.assertIn("单轮定档", r.note)

    def test_single_round_grading_is_noted_and_keeps_persistent_findings(self) -> None:
        r = judgment.synthesize_rounds(G.INSUFFICIENT, G.PASS, [fact("gap", FIND_K, KEEP)])
        self.assertEqual(r.grade, G.CONDITIONAL)
        self.assertIn("单轮定档", r.note)


class FinalConclusion(unittest.TestCase):
    def test_all_pass_releases(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(), flags()), C.RELEASE)

    def test_unmet_prerequisites_is_not_executed_even_with_failures(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D3=G.FAIL), flags(met=False)), C.NOT_EXECUTED)

    def test_d3_or_d4_failure_is_structural(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D3=G.FAIL), flags()), C.STRUCTURAL)
        self.assertEqual(judgment.final_conclusion(dims(D4=G.FAIL), flags()), C.STRUCTURAL)

    def test_d6_failure_by_f5_is_structural_but_other_d6_failure_is_targeted(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D6=G.FAIL), flags(f5=True)), C.STRUCTURAL)
        self.assertEqual(judgment.final_conclusion(dims(D6=G.FAIL), flags()), C.TARGETED)

    def test_t01_law_f1_with_d1_failure_is_structural(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D1=G.FAIL), flags(t01=True)), C.STRUCTURAL)

    def test_f0_registered_on_a_failed_question_is_structural(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D2=G.FAIL), flags(f0=("T02",))), C.STRUCTURAL)

    def test_f0_question_must_sit_in_a_failed_dimension(self) -> None:
        with self.assertRaises(ValueError):
            judgment.final_conclusion(dims(D9=G.FAIL), flags(f0=("T02",)))
        with self.assertRaises(ValueError):
            judgment.final_conclusion(dims(D2=G.FAIL), flags(f0=("T99",)))

    def test_flags_must_agree_with_dimension_grades(self) -> None:
        for bad in (flags(t01=True), flags(f5=True), flags(f0=("T12",))):
            with self.assertRaises(ValueError):
                judgment.final_conclusion(dims(), bad)

    def test_failure_precedes_undecidable(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D1=G.FAIL, D2=G.INSUFFICIENT, D5=G.INSUFFICIENT, D7=G.INSUFFICIENT), flags()), C.TARGETED)

    def test_dangling_takes_the_larger_round_lower_bound(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(), flags(dangling=(Fraction(7, 20), Fraction(1, 5)))), C.TARGETED)
        self.assertEqual(judgment.final_conclusion(dims(), flags(dangling=(Fraction(1, 5), Fraction(3, 10)))), C.RELEASE)

    def test_dangling_not_applicable_when_no_rounds(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(), flags(dangling=())), C.RELEASE)

    def test_dangling_out_of_range_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            judgment.final_conclusion(dims(), flags(dangling=(Fraction(11, 10),)))

    def test_three_insufficient_dimensions_is_undecidable(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D1=G.INSUFFICIENT, D2=G.INSUFFICIENT, D7=G.INSUFFICIENT), flags()), C.UNDECIDABLE)

    def test_two_insufficient_dimensions_release_with_revisions(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D1=G.INSUFFICIENT, D2=G.INSUFFICIENT), flags()), C.RELEASE_WITH_REVISIONS)

    def test_one_conditional_dimension_release_with_revisions(self) -> None:
        self.assertEqual(judgment.final_conclusion(dims(D7=G.CONDITIONAL), flags()), C.RELEASE_WITH_REVISIONS)

    def test_requires_exactly_the_nine_dimensions(self) -> None:
        with self.assertRaises(ValueError):
            judgment.final_conclusion({"D1": G.PASS}, flags())
        with self.assertRaises(ValueError):
            judgment.final_conclusion({**dims(), "D10": G.PASS}, flags())


if __name__ == "__main__":
    unittest.main(verbosity=1)
