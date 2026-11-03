"""A07 W0 read-only source identity check; never imports/runs the inspected code."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
R = Path("F:/项目表/01_云酒账_酒水智能收单与出纳系统/02_当前增强版/frontend")
C = R / "output/t05-mobile-photo-20261013-r1/candidate"
C369 = R / "output/m00-managed-png-product-20261027-r1/source-snapshot"
TABLES = {
    "A01": WORKSPACE / "docs/开发执行/W0/A01_云端适配/01_现有云接入与运行适配调查.md",
    "A04": WORKSPACE / "docs/开发执行/W0/A04_手机适配/01_设备与旧原生壳核查.md",
    "A06": WORKSPACE / "docs/开发执行/W0/A06_打印适配/01_iP110与130x190套打预检.md",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def identity(path: Path) -> dict:
    return {"path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size}


rows = []
for role, table in TABLES.items():
    for line_no, line in enumerate(table.read_text(encoding="utf-8-sig").splitlines(), 1):
        match = re.fullmatch(r"\|\s*([^|]+?)\s*\|\s*([0-9A-Fa-f]{64})\s*\|", line)
        if not match:
            continue
        relative = match[1].strip().strip("`")
        if relative.startswith("C369/"):
            prefix, root, leaf = "C369", C369, relative[len("C369/"):]
        elif relative.startswith("C/") and role == "A04":
            prefix, root, leaf = "C", C, relative[len("C/"):]
        elif relative.startswith("R/"):
            prefix, root, leaf = "R", R, relative[len("R/"):]
        elif role == "A04":
            prefix, root, leaf = "R", R, relative
        else:
            raise ValueError(f"Unrecognised explicit prefix {role}: {relative}")
        source = (root / leaf).resolve()
        source.relative_to(root.resolve())
        expected = match[2].upper()
        actual = sha256(source)
        rows.append({
            "role": role, "table": str(table.relative_to(WORKSPACE)),
            "table_line": line_no, "table_path": relative,
            "resolved_prefix": prefix, "resolved_path": str(source),
            "expected_sha256": expected, "actual_sha256": actual,
            "matches": expected == actual, "bytes": source.stat().st_size,
        })

assert len(rows) == 25, f"Expected 25 listed rows, found {len(rows)}"
by_role = {role: {
    "listed": sum(row["role"] == role for row in rows),
    "matched": sum(row["role"] == role and row["matches"] for row in rows),
} for role in TABLES}
assert [by_role[role]["listed"] for role in TABLES] == [9, 9, 7]

product = WORKSPACE / "docs/功能逐页梳理_2026-10-30"
manifest_path = product / "history/v0.2_用户确认原稿/确认清单.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
original = product / manifest["source"]
snapshot = product / manifest["snapshot"]
expected_page_hash = manifest["sha256"].upper()
page_check = {
    "manifest": identity(manifest_path), "expected_sha256": expected_page_hash,
    "source": identity(original), "snapshot": identity(snapshot),
    "matches": sha256(original) == sha256(snapshot) == expected_page_hash,
    "action": "Read and hash only; source and snapshot were not modified.",
}

sample_path = WORKSPACE / "docs/开发执行/W0/A02_业务规则/02_脱敏业务验收样例.md"
sample_text = sample_path.read_text(encoding="utf-8-sig")
sample_ids = re.findall(r"^\| (V\d{2}) \|", sample_text, re.M)
assert sample_ids == [f"V{i:02d}" for i in range(1, 42)], sample_ids

register_path = WORKSPACE / "docs/项目管理/项目任务台账.json"
register = json.loads(register_path.read_text(encoding="utf-8-sig"))
tasks = register["tasks"]
first = [task for task in tasks if task["phase"] == "first"]
phase_counts = dict(Counter(task["phase"] for task in tasks))
assert phase_counts == {"management": 7, "first": 36, "future": 3}, phase_counts
advanced_first = [{"id": task["id"], "stage": stage, "state": task["stages"][stage]}
                  for task in first
                  for stage in ("implementation", "module", "integration", "acceptance")
                  if task["stages"][stage] not in ("not_started", "not_applicable")]
assert not advanced_first, advanced_first
board_path = WORKSPACE / "docs/项目管理/00_项目进度看板.md"
board_text = board_path.read_text(encoding="utf-8-sig")
register_digest = sha256(register_path).lower()
assert register_digest[:12] in board_text, "Generated board has a stale register digest"

reviewed = sorted((WORKSPACE / "docs/开发执行/W0").glob("A0[1246]*/*.md"))
reviewed += [WORKSPACE / "docs/开发执行/W0/00_ROOT_接口及基线整合候选.md"]
reviewed += [product / filename for filename in (
    "01_全流程与统一规则.md", "03_人工审核与修改清单.md", "04_字段按钮与校验明细.md",
    "05_人工确认结果与正式产品规则_v0.2-r1.md", "06_正式产品规则补充_v0.2-r2.md",
    "07_调价更正退货与启动确认_v0.2-r3.md")]
reviewed += [WORKSPACE / filename for filename in (
    "AGENTS.md", "项目常看入口.md", "docs/项目管理/00_项目进度看板.md",
    "docs/项目管理/01_子代理分工与任务交接.md", "docs/项目管理/02_项目边界与执行规范.md",
    "docs/项目管理/06_W0启动与任务派发.md", "docs/项目管理/问题协调/00_问题台账.md",
    "docs/项目管理/问题协调/01_本轮问题汇总.md")]
link_checks = []
for document in reviewed:
    for link in re.findall(r"!?\[[^\]]*\]\(([^)]+)\)", document.read_text(encoding="utf-8-sig")):
        target = link.strip("<>").split("#", 1)[0]
        if not target or re.match(r"^[a-zA-Z]+://", target):
            continue
        path = (document.parent / target).resolve()
        link_checks.append({"document": str(document.relative_to(WORKSPACE)),
                            "target": link, "exists": path.exists()})

record = {
    "audit_id": "W0-A07",
    "audit_version": "audit-v0.1",
    "generated_at_local": datetime.now().astimezone().isoformat(timespec="seconds"),
    "scope": "Static documentation review and independent SHA256 recomputation only.",
    "source_code_executed": False, "business_samples_executed": False,
    "devices_or_production_accessed": False, "push_or_deployment_performed": False,
    "roots": {"R": str(R), "C": str(C), "C369": str(C369)},
    "table_identities": {role: identity(table) for role, table in TABLES.items()},
    "source_summary": {"listed": len(rows), "matched": sum(r["matches"] for r in rows),
                       "mismatched": sum(not r["matches"] for r in rows), "by_role": by_role,
                       "unique_resolved_files": len({r["resolved_path"] for r in rows})},
    "source_rows": rows,
    "confirmed_page_integrity": page_check,
    "sample_design": {
        "document": identity(sample_path), "count": len(sample_ids), "ids": sample_ids,
        "execution_status": "Not executed; design coverage only.",
        "rule_mapping": {
            "step_one_yuan": ["V01", "V02"],
            "restore_previous_effective_price": ["V03", "V04", "V05", "V06"],
            "explicit_zero_does_not_propagate": ["V10", "V11", "V12", "V13", "V37"],
            "owner_only_cloud_authorization": ["V27"],
            "correction_and_reversal_idempotency": ["V16", "V17", "V18", "V19", "V20", "V21", "V22"],
            "return_original_sale_original_price_partial": ["V28", "V30", "V33", "V34", "V35", "V36", "V37", "V38", "V39", "V40", "V41"],
        },
    },
    "reviewed_document_identities": [identity(path) for path in reviewed],
    "local_link_checks": {"count": len(link_checks),
                          "missing": [entry for entry in link_checks if not entry["exists"]]},
    "management_snapshot": {
        "register": identity(register_path), "register_digest_prefix": register_digest[:12],
        "board": identity(board_path), "board_digest_matches": True,
        "task_count": len(tasks), "phase_counts": phase_counts,
        "first_acceptance_passed": sum(task["stages"]["acceptance"] == "passed" for task in first),
        "advanced_first_implementation_or_verification": advanced_first,
        "stage_counts": {stage: dict(Counter(task["stages"][stage] for task in first))
                         for stage in ("implementation", "module", "integration", "acceptance")},
        "snapshot_only": "ROOT may append audit evidence and regenerate the board after this review.",
    },
    "limitations": [
        "Matching hashes identify file bytes only; they do not establish correctness or deployability.",
        "No build, import, application script, database, model, SMS, native device or printer operation was performed.",
        "Static sample coverage does not establish business module, integration or target environment acceptance.",
    ],
}
output = OUT / "02_来源摘要复核.json"
output.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"source_summary": record["source_summary"],
                  "confirmed_page_integrity_matches": page_check["matches"],
                  "sample_count": len(sample_ids), "output": str(output)}, ensure_ascii=False))
